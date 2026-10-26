# Бэкап Postgres в S3. pg_dump той же мажорной версии, что и сервер
# (postgres:16 в docker-compose.prod.yml) — иначе дамп не снимется.
FROM postgres:16-alpine
RUN apk add --no-cache aws-cli
COPY backup.sh /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
