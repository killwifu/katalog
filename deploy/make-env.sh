#!/usr/bin/env bash
# Готовит .env для прод-стека: создаёт его из .env.prod.example, генерирует
# секреты (пароль Postgres, REVALIDATE_SECRET) и проверяет, что все
# обязательные значения заполнены.
#
#   ./deploy/make-env.sh
#
# Запускать на сервере из корня репозитория. Идемпотентен: существующий
# .env не перезаписывается, повторный запуск работает как проверка.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Минимум, без которого стек не поднимется или витрина будет битой.
# Почта и платежи сюда намеренно не входят: без них сервис работает,
# см. «Что отложено» в README.
REQUIRED=(
	APP_DOMAIN ACME_EMAIL GHCR_OWNER
	POSTGRES_PASSWORD
	S3_ENDPOINT S3_PUBLIC_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY S3_REGION
	MEDIA_BASE_URL REVALIDATE_SECRET
)

if [ ! -f .env ]; then
	cp .env.prod.example .env
	# Секреты генерируем сразу — руками их всё равно генерировать openssl.
	sed -i.bak \
		-e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')|" \
		-e "s|^REVALIDATE_SECRET=.*|REVALIDATE_SECRET=$(openssl rand -hex 32)|" \
		.env
	rm -f .env.bak
	chmod 600 .env
	echo ".env создан из .env.prod.example, секреты сгенерированы"
else
	echo ".env уже существует — не трогаю, только проверяю"
fi

# Читаем значения парсингом, а не source: значения вроде
# STOP_WORDS=контрафакт,подделка бренда содержат пробелы, и шелл попытался
# бы выполнить остаток строки как команду.
getval() { sed -n "s/^$1=//p" .env | tail -1; }

missing=()
for var in "${REQUIRED[@]}"; do
	[ -n "$(getval "$var")" ] || missing+=("$var")
done

# Плейсхолдеры из примера — валидные непустые строки, но в проде это мусор.
placeholders=()
for var in APP_DOMAIN ACME_EMAIL MEDIA_BASE_URL; do
	val=$(getval "$var")
	case "$val" in
		*example.ru*|*example.com*) placeholders+=("$var=$val") ;;
	esac
done

status=0
if [ ${#missing[@]} -ne 0 ]; then
	printf '\n\033[31mНе заполнено:\033[0m\n'
	printf '  %s\n' "${missing[@]}"
	status=1
fi
if [ ${#placeholders[@]} -ne 0 ]; then
	printf '\n\033[33mОстались значения из примера:\033[0m\n'
	printf '  %s\n' "${placeholders[@]}"
	status=1
fi

if [ "$status" -ne 0 ]; then
	printf '\nОтредактируй .env и запусти скрипт снова.\n'
	exit 1
fi

# Отложенное не должно потеряться молча: перечисляем, что выключено
# и чем это аукнется. Подробности — «Что отложено» в README.
off=()
[ -n "$(getval SMTP_HOST)" ] || off+=("SMTP_HOST — письма в лог воркера, сброс пароля недоступен")
[ -n "$(getval YOOKASSA_SHOP_ID)" ] || off+=("YOOKASSA_* — оплата тарифов отдаёт 503, все магазины на free")
[ -n "$(getval ADMIN_EMAIL)" ] || off+=("ADMIN_EMAIL — жалобы и алерты по трафику никуда не уходят")
case "$(getval MEDIA_BASE_URL)" in
	*storage.yandexcloud.net*) off+=("MEDIA_BASE_URL смотрит прямо в S3 — картинки без CDN-кеша") ;;
esac

if [ ${#off[@]} -ne 0 ]; then
	printf '\n\033[33mВыключено (заработает после заполнения, пересборка не нужна):\033[0m\n'
	printf '  %s\n' "${off[@]}"
fi

printf '\n\033[32m.env заполнен.\033[0m Дальше:\n'
printf '  docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d\n'
