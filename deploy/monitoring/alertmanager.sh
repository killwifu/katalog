#!/bin/sh
# Alertmanager не подставляет переменные окружения в конфиг — собираем его
# при старте. Без TELEGRAM_* алерты видны только в Grafana/Alertmanager UI.
set -eu
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
	receiver="
  - name: default
    telegram_configs:
      - bot_token: '$TELEGRAM_BOT_TOKEN'
        chat_id: $TELEGRAM_CHAT_ID
        send_resolved: true"
else
	echo "alertmanager: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID пусты — алерты никуда не уходят" >&2
	receiver="
  - name: default"
fi
cat >/tmp/alertmanager.yml <<YML
route:
  receiver: default
  group_by: [alertname]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
receivers:$receiver
YML
exec /bin/alertmanager --config.file=/tmp/alertmanager.yml --storage.path=/alertmanager
