#!/bin/sh
# Ежесуточный дамп Postgres в S3: s3://$S3_BUCKET/backup/pg/<UTC-время>.dump
# (формат custom, восстановление — pg_restore, см. README «Бэкапы»).
#
# Первый дамп — сразу при старте контейнера, дальше раз в BACKUP_INTERVAL
# секунд. Контейнер пересоздаётся на каждом деплое, так что дамп
# снимается и после каждой выкладки.
#
# Дампы старше BACKUP_KEEP_DAYS удаляются (0 — не трогать, чистит lifecycle).
# После успешного дампа скрипт пингует BACKUP_PING_URL (heartbeat-монитор вроде healthchecks.io):
# не пришёл пинг вовремя — монитор присылает алерт. Так замечаем и упавший
# дамп, и остановленный контейнер.
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
: "${S3_ENDPOINT:?}" "${S3_BUCKET:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}" "${AWS_DEFAULT_REGION:?}"
BACKUP_INTERVAL=${BACKUP_INTERVAL:-86400}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
PREFIX=backup/pg/

s3() { aws --endpoint-url "$S3_ENDPOINT" "$@"; }
log() { echo "$(date -u +%FT%TZ) backup: $*"; }

# Внутри функции, вызванной из `if`, set -e не действует — каждый шаг
# проверяется явно, иначе битый дамп уехал бы в S3 и отправил пинг.
backup() {
	key="$PREFIX$(date -u +%Y-%m-%dT%H%M%SZ).dump"
	file=/tmp/db.dump
	pg_dump -Fc -f "$file" || return 1
	# Битый или обрезанный архив pg_restore не прочитает — ловим до заливки.
	pg_restore --list "$file" >/dev/null || return 1
	s3 s3 cp --only-show-errors "$file" "s3://$S3_BUCKET/$key" || return 1
	log "uploaded $key ($(wc -c <"$file") bytes)"
	rm -f "$file"

	# Имена — UTC-время, строковое сравнение с порогом = сравнение дат.
	# Сбой чистки не делает бэкап неудачным: дамп уже лежит в S3.
	# 0 — чистит lifecycle бакета (отдельный бакет, ключ без права удаления,
	# см. deploy/s3/setup-backup.sh).
	if [ "$BACKUP_KEEP_DAYS" -gt 0 ]; then
		cutoff=$(date -u -d "@$(($(date +%s) - BACKUP_KEEP_DAYS * 86400))" +%Y-%m-%d)
		s3 s3 ls "s3://$S3_BUCKET/$PREFIX" | awk -v c="$cutoff" '$4 != "" && $4 < c {print $4}' | while read -r name; do
			s3 s3 rm --only-show-errors "s3://$S3_BUCKET/$PREFIX$name" && log "removed old $name"
		done
	fi

	if [ -n "${BACKUP_PING_URL:-}" ]; then
		wget -q -T 10 -O /dev/null "$BACKUP_PING_URL" || log "heartbeat ping failed"
	fi
}

while true; do
	# Неудачный дамп не роняет цикл: пинга не будет — монитор поднимет тревогу,
	# а следующая попытка — через час, а не через сутки.
	if backup; then
		sleep "$BACKUP_INTERVAL"
	else
		log "FAILED, retry in 1h"
		rm -f /tmp/db.dump
		sleep 3600
	fi
done
