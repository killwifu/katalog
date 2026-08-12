#!/usr/bin/env bash
# Настройка Yandex Object Storage под Katalog за один запуск: бакет,
# сервисный аккаунт с ключами, политика на drv/, CORS для pre-signed PUT
# и проверки, что всё это действительно работает.
#
#   S3_BUCKET=katalog-prod-xyz APP_DOMAIN=katalog.example.ru ./deploy/s3/setup.sh
#
# Требует настроенный yc (yc init), aws-cli и jq. Идемпотентен: повторный
# запуск не ломает существующие ресурсы.
#
# Ключ создаётся только если у сервисного аккаунта его ещё нет: секрет
# показывается один раз и потом не читается. Чтобы выпустить новый —
# ROTATE_KEY=1. Чтобы переиспользовать имеющийся — передать S3_ACCESS_KEY
# и S3_SECRET_KEY в окружении.
set -euo pipefail

ENDPOINT=https://storage.yandexcloud.net
REGION=ru-central1
SA_NAME=katalog-s3
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

: "${S3_BUCKET:?нужен S3_BUCKET — имя бакета, глобально уникальное в Yandex}"
: "${APP_DOMAIN:?нужен APP_DOMAIN — домен приложения, с него разрешается CORS}"

for cmd in yc aws jq curl; do
	command -v "$cmd" >/dev/null || { echo "нет $cmd в PATH" >&2; exit 1; }
done

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fails=0
check() {
	local name=$1 ok=$2
	if [ "$ok" = 0 ]; then
		printf '  \033[32mOK\033[0m   %s\n' "$name"
	else
		printf '  \033[31mFAIL\033[0m %s\n' "$name"
		fails=$((fails + 1))
	fi
}

step "Бакет $S3_BUCKET"
if yc storage bucket list --format json | jq -e --arg n "$S3_BUCKET" 'any(.[]; .name == $n)' >/dev/null; then
	echo "  уже существует"
else
	# Публичные флаги (--public-read/--public-list) НЕ ставим: доступ
	# выдаётся политикой ровно на drv/*. --public-list открыл бы анонимный
	# ListBucket — перечисление фото всех магазинов в обход is_hidden
	# и паролей альбомов.
	yc storage bucket create --name "$S3_BUCKET" --default-storage-class standard >/dev/null
	echo "  создан"
fi

step "Сервисный аккаунт $SA_NAME"
if ! yc iam service-account list --format json | jq -e --arg n "$SA_NAME" 'any(.[]; .name == $n)' >/dev/null; then
	yc iam service-account create --name "$SA_NAME" >/dev/null
	echo "  создан"
else
	echo "  уже существует"
fi
SA_ID=$(yc iam service-account get "$SA_NAME" --format json | jq -r .id)
FOLDER_ID=$(yc config get folder-id)
# Повторная выдача уже существующей роли — не ошибка, гасим шум.
yc resource-manager folder add-access-binding "$FOLDER_ID" \
	--role storage.editor --subject "serviceAccount:$SA_ID" >/dev/null 2>&1 || true
echo "  роль storage.editor выдана"

step "Ключи доступа"
key_count=$(yc iam access-key list --service-account-name "$SA_NAME" --format json | jq 'length')
if [ "${ROTATE_KEY:-}" = 1 ] || [ "$key_count" -eq 0 ]; then
	key_json=$(yc iam access-key create --service-account-name "$SA_NAME" --format json)
	S3_ACCESS_KEY=$(jq -r '.access_key.key_id // .key_id // empty' <<<"$key_json")
	S3_SECRET_KEY=$(jq -r '.secret // .access_key.secret // empty' <<<"$key_json")
	if [ -z "$S3_ACCESS_KEY" ] || [ -z "$S3_SECRET_KEY" ]; then
		# Ключ уже выпущен, а секрет показывается один раз — молча выйти
		# нельзя, иначе он потерян. Печатаем сырой ответ.
		echo "не разобрал вывод yc iam access-key create:" >&2
		echo "$key_json" >&2
		exit 1
	fi
	echo "  выпущен новый ключ"
else
	echo "  у аккаунта уже $key_count ключ(ей), новый не выпускаю (ROTATE_KEY=1 — выпустить)"
	: "${S3_ACCESS_KEY:?секрет существующего ключа не читается — передай S3_ACCESS_KEY и S3_SECRET_KEY или запусти с ROTATE_KEY=1}"
	: "${S3_SECRET_KEY:?передай S3_SECRET_KEY вместе с S3_ACCESS_KEY}"
fi

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
export AWS_DEFAULT_REGION="$REGION"
s3() { aws --endpoint-url="$ENDPOINT" "$@"; }

step "Политика и CORS"
sed "s/<BUCKET>/$S3_BUCKET/" "$DIR/bucket-policy.json" >"$DIR/.policy.tmp.json"
sed "s/<APP_DOMAIN>/$APP_DOMAIN/" "$DIR/cors.json" >"$DIR/.cors.tmp.json"
trap 'rm -f "$DIR/.policy.tmp.json" "$DIR/.cors.tmp.json"' EXIT

# Свежий ключ доступен не мгновенно — даём ему пару секунд разойтись.
for attempt in 1 2 3 4 5 6; do
	if s3 s3api put-bucket-policy --bucket "$S3_BUCKET" --policy "file://$DIR/.policy.tmp.json" 2>/dev/null; then
		break
	fi
	[ "$attempt" = 6 ] && { echo "  не удалось применить политику" >&2; exit 1; }
	sleep 5
done
echo "  политика применена (анонимное чтение только drv/*)"
s3 s3api put-bucket-cors --bucket "$S3_BUCKET" --cors-configuration "file://$DIR/.cors.tmp.json"
echo "  CORS применён (PUT с https://$APP_DOMAIN)"

step "Проверки"
probe=$(mktemp)
echo probe >"$probe"

# Тот же scope подписи SigV4, что использует minio-go в api и worker.
s3 s3api put-object --bucket "$S3_BUCKET" --key "drv/.probe" --body "$probe" >/dev/null 2>&1
ok=$?
check "подпись SigV4 с регионом $REGION принимается" "$ok"

s3 s3api put-object --bucket "$S3_BUCKET" --key "orig/.probe" --body "$probe" >/dev/null 2>&1 || true

code=$(curl -s -o /dev/null -w '%{http_code}' "$ENDPOINT/$S3_BUCKET/drv/.probe")
if [ "$code" = 200 ]; then ok=0; else ok=1; fi
check "drv/ читается анонимно (got $code)" "$ok"

code=$(curl -s -o /dev/null -w '%{http_code}' "$ENDPOINT/$S3_BUCKET/orig/.probe")
if [ "$code" != 200 ]; then ok=0; else ok=1; fi
check "orig/ анонимно НЕ читается (got $code)" "$ok"

if curl -s "$ENDPOINT/$S3_BUCKET/?list-type=2" | grep -q ListBucketResult; then ok=1; else ok=0; fi
check "листинг бакета наружу закрыт" "$ok"

# Загрузка из браузера — кросс-доменный PUT с Content-Type файла, т.е.
# с preflight. Без Access-Control-Allow-Origin в ответе фото не грузятся.
if curl -s -o /dev/null -D- -X OPTIONS \
	-H "Origin: https://$APP_DOMAIN" \
	-H "Access-Control-Request-Method: PUT" \
	-H "Access-Control-Request-Headers: content-type" \
	"$ENDPOINT/$S3_BUCKET/orig/.cors-probe" | grep -qi 'access-control-allow-origin'; then ok=0; else ok=1; fi
check "CORS preflight PUT с https://$APP_DOMAIN проходит" "$ok"

s3 s3api delete-object --bucket "$S3_BUCKET" --key "drv/.probe" >/dev/null 2>&1 || true
s3 s3api delete-object --bucket "$S3_BUCKET" --key "orig/.probe" >/dev/null 2>&1 || true
rm -f "$probe"

if [ "$fails" -ne 0 ]; then
	printf '\n\033[31mПровалено проверок: %s\033[0m\n' "$fails" >&2
	exit 1
fi

step "Готово — в .env на сервере"
cat <<ENV
S3_ENDPOINT=$ENDPOINT
S3_PUBLIC_ENDPOINT=$ENDPOINT
S3_BUCKET=$S3_BUCKET
S3_ACCESS_KEY=$S3_ACCESS_KEY
S3_SECRET_KEY=$S3_SECRET_KEY
S3_REGION=$REGION
MEDIA_BASE_URL=$ENDPOINT/$S3_BUCKET/drv
ENV
echo
echo "MEDIA_BASE_URL выше смотрит прямо в S3 — для первого деплоя годится."
echo "Позже завести CDN-домен на бакет (см. README) и заменить на него:"
echo "картинки — 95% трафика, без кеша это дорого и медленно."
