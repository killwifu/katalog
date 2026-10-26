#!/usr/bin/env bash
# Отдельный бакет для дампов Postgres (сервис backup) со своим ключом.
#
#   BACKUP_S3_BUCKET=katalog-backup-xyz ./deploy/s3/setup-backup.sh
#
# Зачем отдельно: ключ приложения (S3_ACCESS_KEY) живёт в api и worker,
# и с ним можно удалить всё в основном бакете — вместе с дампами, если
# они лежат там же. Здесь:
#   - политика бакета — единственный источник прав для S3 API (см. setup.sh,
#     п. 2), поэтому ключ приложения сюда доступа не имеет вовсе;
#   - ключ бэкапа может писать, читать и листать, но не удалять;
#   - перезапись старого дампа мусором не страшна — включено версионирование;
#   - старые дампы и версии удаляет lifecycle через 14 дней, сам скрипт
#     бэкапа чистку не делает (BACKUP_KEEP_DAYS=0).
#
# Требует yc, aws-cli, jq. Каталог — FOLDER_ID или из профиля yc.
# Порядок шагов как в setup.sh: версионирование и lifecycle — до политики.
set -euo pipefail

ENDPOINT=https://storage.yandexcloud.net
REGION=ru-central1
SA_NAME=katalog-backup
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

: "${BACKUP_S3_BUCKET:?нужен BACKUP_S3_BUCKET — имя бакета для дампов}"
FOLDER_ID=${FOLDER_ID:-$(yc config get folder-id)}
ycf() { yc "$@" --folder-id "$FOLDER_ID"; }

for cmd in yc aws jq; do
	command -v "$cmd" >/dev/null || { echo "нет $cmd в PATH" >&2; exit 1; }
done

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fails=0
check() {
	if [ "$2" = 0 ]; then printf '  \033[32mOK\033[0m   %s\n' "$1"; else printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails + 1)); fi
}

step "Бакет $BACKUP_S3_BUCKET"
if ycf storage bucket list --format json | jq -e --arg n "$BACKUP_S3_BUCKET" 'any(.[]; .name == $n)' >/dev/null; then
	echo "  уже существует"
else
	# cold: дампы пишутся раз в сутки и читаются только при аварии.
	ycf storage bucket create --name "$BACKUP_S3_BUCKET" --default-storage-class cold >/dev/null
	echo "  создан"
fi

step "Сервисный аккаунт $SA_NAME"
ycf iam service-account get "$SA_NAME" >/dev/null 2>&1 || { ycf iam service-account create --name "$SA_NAME" >/dev/null; echo "  создан"; }
SA_ID=$(ycf iam service-account get "$SA_NAME" --format json | jq -r .id)

# storage.admin — только на время настройки (версионирование, lifecycle,
# политика), снимается на выходе в любом случае.
admin_granted=0
drop_admin() {
	[ "$admin_granted" = 1 ] || return 0
	yc resource-manager folder remove-access-binding "$FOLDER_ID" \
		--role storage.admin --subject "serviceAccount:$SA_ID" >/dev/null 2>&1 || true
	echo "  storage.admin снят с $SA_NAME"
}
trap 'rm -f "$DIR"/.backup-policy.tmp.json; drop_admin' EXIT
yc resource-manager folder add-access-binding "$FOLDER_ID" \
	--role storage.admin --subject "serviceAccount:$SA_ID" >/dev/null 2>&1 || true
admin_granted=1

step "Ключ доступа"
key_count=$(ycf iam access-key list --service-account-name "$SA_NAME" --format json | jq 'length')
if [ "${ROTATE_KEY:-}" = 1 ] || [ "$key_count" -eq 0 ]; then
	key_json=$(ycf iam access-key create --service-account-name "$SA_NAME" --format json)
	BACKUP_S3_ACCESS_KEY=$(jq -r '.access_key.key_id // .key_id // empty' <<<"$key_json")
	BACKUP_S3_SECRET_KEY=$(jq -r '.secret // .access_key.secret // empty' <<<"$key_json")
	printf '  выпущен новый ключ\n    BACKUP_S3_ACCESS_KEY=%s\n    BACKUP_S3_SECRET_KEY=%s\n' \
		"$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY"
else
	echo "  ключ уже есть, новый не выпускаю (ROTATE_KEY=1 — выпустить)"
	: "${BACKUP_S3_ACCESS_KEY:?передай BACKUP_S3_ACCESS_KEY и BACKUP_S3_SECRET_KEY или запусти с ROTATE_KEY=1}"
	: "${BACKUP_S3_SECRET_KEY:?}"
fi
export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" AWS_DEFAULT_REGION="$REGION"
s3() { aws --endpoint-url="$ENDPOINT" "$@"; }

step "Версионирование, lifecycle, политика"
s3 s3api delete-bucket-policy --bucket "$BACKUP_S3_BUCKET" >/dev/null 2>&1 || true
# Свежий ключ и роль расходятся не мгновенно.
for attempt in 1 2 3 4 5 6; do
	s3 s3api put-bucket-versioning --bucket "$BACKUP_S3_BUCKET" \
		--versioning-configuration Status=Enabled 2>/dev/null && break
	[ "$attempt" = 6 ] && { echo "  не удалось включить версионирование" >&2; exit 1; }
	sleep 5
done
s3 s3api put-bucket-lifecycle-configuration --bucket "$BACKUP_S3_BUCKET" \
	--lifecycle-configuration "file://$DIR/backup-lifecycle.json"
sed -e "s/<BUCKET>/$BACKUP_S3_BUCKET/g" -e "s/<SERVICE_ACCOUNT_ID>/$SA_ID/" \
	"$DIR/backup-policy.json" >"$DIR/.backup-policy.tmp.json"
s3 s3api put-bucket-policy --bucket "$BACKUP_S3_BUCKET" --policy "file://$DIR/.backup-policy.tmp.json"
echo "  готово"
drop_admin
admin_granted=0
# Права после снятия роли применяются не мгновенно.
sleep 10

step "Проверки (ключом бэкапа, уже без storage.admin)"
probe=$(mktemp); echo probe >"$probe"
s3 s3api put-object --bucket "$BACKUP_S3_BUCKET" --key .probe --body "$probe" >/dev/null 2>&1; check "пишет" $?
s3 s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --max-items 1 >/dev/null 2>&1; check "листает" $?
if s3 s3api delete-object --bucket "$BACKUP_S3_BUCKET" --key .probe >/dev/null 2>&1; then ok=1; else ok=0; fi
check "НЕ удаляет" "$ok"
if [ -n "${S3_ACCESS_KEY:-}" ]; then
	if AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY AWS_SECRET_ACCESS_KEY=$S3_SECRET_KEY \
		s3 s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --max-items 1 >/dev/null 2>&1; then ok=1; else ok=0; fi
	check "ключ приложения (S3_ACCESS_KEY) сюда НЕ ходит" "$ok"
else
	echo "  пропущено: ключ приложения не проверен (передай S3_ACCESS_KEY/S3_SECRET_KEY)"
fi
rm -f "$probe"
# .probe удалит lifecycle.

[ "$fails" -eq 0 ] || { printf '\n\033[31mПровалено проверок: %s\033[0m\n' "$fails" >&2; exit 1; }

step "Готово — в .env на сервере"
cat <<ENV
BACKUP_S3_BUCKET=$BACKUP_S3_BUCKET
BACKUP_S3_ACCESS_KEY=$BACKUP_S3_ACCESS_KEY
BACKUP_S3_SECRET_KEY=$BACKUP_S3_SECRET_KEY
BACKUP_KEEP_DAYS=0
ENV
