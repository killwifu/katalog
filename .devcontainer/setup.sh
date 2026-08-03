#!/bin/bash
# Codespaces: генерирует .env с внешними URL проброшенных портов.
# Без этого браузер не достучится до MinIO (presigned-загрузки указывали бы
# на localhost:9000) и ссылки в письмах вели бы на localhost.
# При локальной разработке скрипт ничего не делает (make up сам создаст .env).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.example .env

if [ -z "${CODESPACE_NAME:-}" ]; then
  echo "not in codespaces, skipping env overrides"
  exit 0
fi

domain="$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
cat >> .env <<EOF

# --- Codespaces overrides (.devcontainer/setup.sh) ---
# Дубликаты ключей ниже переопределяют значения выше (последний выигрывает).
# S3 — через Caddy на 80-м порту (/katalog/*): наружу нужен один порт.
S3_PUBLIC_ENDPOINT=https://${CODESPACE_NAME}-80.${domain}
SITE_URL=https://${CODESPACE_NAME}-80.${domain}
COOKIE_SECURE=true
EOF
echo "codespaces .env ready: site https://${CODESPACE_NAME}-80.${domain}"
