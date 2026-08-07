# Katalog

Мультитенантный фотохостинг-витрина для малого бизнеса (см. `CLAUDE.md` —
контекст проекта и архитектурные инварианты).

## Требования

- Docker + Docker Compose v2
- Go 1.26+ (локальная разработка бэкенда)
- Node.js 20+ (локальная разработка фронтендов)
- [golangci-lint](https://golangci-lint.run/) v2 (`brew install golangci-lint`)
- [sqlc](https://sqlc.dev/) (`brew install sqlc`) — для `make sqlc-gen`
- libvips (`brew install vips`) — govips в воркере; нужен для сборки и тестов
- Docker должен быть запущен для `make test`: интеграционные тесты
  поднимают Postgres/Redis/MinIO через testcontainers

## Быстрый старт

```sh
make up                      # поднимает весь стек (собирает образы, применяет миграции)
curl localhost/healthz       # -> {"status":"ok"}
make down                    # останавливает стек
```

## Демо в облаке без локальной установки (GitHub Codespaces)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/killwifu/katalog)

1. Нажмите бейдж (или Code → Codespaces → Create) — codespace сам соберёт
   и поднимет весь стек (`make up` в postCreate, первая сборка ~5–10 минут;
   прогресс — в логе создания).
2. В терминале codespace откройте порт наружу:
   ```sh
   gh codespace ports visibility 80:public -c "$CODESPACE_NAME"
   ```
   (S3-загрузки тоже идут через 80-й порт — маршрут `/katalog/orig/*` в Caddy).
3. Публичная ссылка на демо — вкладка Ports, порт 80:
   `https://<codespace>-80.app.github.dev`. Демо-данные: `make seed`.

Ссылка живёт, пока codespace запущен (останавливается после ~30 минут
простоя; перезапуск — той же кнопкой в github.com/codespaces).

После `make up` доступно:

| URL | Что |
| --- | --- |
| `localhost/` | публичные страницы: главная, `/pricing`, `/updates`, `/remove-bg` |
| `localhost/{slug}` | витрина магазина (Next.js SSR) |
| `localhost/app/` | кабинет продавца (SPA), тарифы — `/app/billing`, статистика — `/app/stats` |
| `localhost/app/admin` | админ-зона модератора (нужна роль `admin` в `users`) |
| `localhost/api/v1/...` | Go API |
| `localhost/abuse`, `/terms`, `/privacy`, `/content-policy` | форма жалобы и статические страницы |
| `localhost:9001` | консоль MinIO (minioadmin/minioadmin) |

Миграции применяются автоматически one-shot сервисом `migrate`,
бакет MinIO создаётся сервисом `minio-init`.

## Тарифы и биллинг

Дефолтные лимиты (меняются `PLAN_*`-переменными без пересборки):

| Тариф | Фото | Хранилище | Цена |
| --- | --- | --- | --- |
| free | 500 | 1 ГБ | 0 ₽ |
| basic | 5 000 | 10 ГБ | 490 ₽/мес |
| pro | 20 000 | 20 ГБ | 990 ₽/мес |

Квоты проверяются в presign — мягкий 403 с машинным кодом
(`photo_quota_exceeded` / `quota_exceeded` / `subscription_inactive`).
Оплата через ЮKassa: redirect на подтверждение, активация тарифа только по
вебхуку `payment.succeeded` (обработка идемпотентна — повторная доставка
события ничего не дублирует), продление — рекуррентные списания по
сохранённому способу оплаты. Просрочка оплаты: `grace` (`BILLING_GRACE_DAYS`,
загрузка заблокирована, витрина работает) → витрина скрыта; контент не
удаляется, оплата возвращает всё автоматически.

## Интеграции (опциональные, включаются через env)

- **Платежи (ЮKassa)**: `YOOKASSA_SHOP_ID`/`YOOKASSA_SECRET_KEY`; пусто —
  оплата тарифов отключена (subscribe отвечает 503). Возврат после оплаты —
  `BILLING_RETURN_URL`.
- **Почта (SMTP)**: `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM`;
  пустой `SMTP_HOST` — письма пишутся в лог воркера (dev-режим). Письма:
  подтверждение регистрации, сброс пароля, уведомления о жалобах и блокировках.
- **Модерация**: `ADMIN_EMAIL` — куда слать уведомления о новых жалобах;
  `STOP_WORDS` — стоп-слова подписей (через запятую), совпадение ставит фото
  флаг ручной проверки. Роль выдаётся вручную:
  `UPDATE users SET role = 'admin' WHERE email = '...'`.
- **Аналитика**: дашборд продавца в `/app/stats` (просмотры/уникальные из
  `daily_stats`, клики по каналам и топ фото из `lead_clicks` в реальном
  времени); ежемесячный email-дайджест продавцам; алерт админу на аномальный
  CDN-трафик (`TRAFFIC_ALERT_MULTIPLIER` × средненедельных просмотров,
  минимум `TRAFFIC_ALERT_MIN_VIEWS`).
- **Мониторинг**: `GET /metrics` на порту API (наружу не проксируется) —
  загрузки за сегодня, активные магазины, гистограмма латентности публичного
  API (p95 считает Prometheus); глубина очереди asynq — на `/metrics` воркера
  (порт 8081).

Полный список переменных с дефолтами — в `.env.example`.

## Команды

```sh
make test      # go test ./... — unit + интеграционные (testcontainers:
               # пайплайн фото, тенант-изоляция, auth, rate-limit, биллинг
               # с фейковой ЮKassa, модерация и почта с перехватчиком писем)
make lint      # golangci-lint + eslint + tsc --noEmit для обоих фронтендов
make migrate   # goose up на localhost:5432 (переопределяется DATABASE_URL=...)
make sqlc-gen  # регенерация Go-кода из internal/db/queries/*.sql
make seed      # демо-магазин на запущенном стеке
make e2e       # приёмка: загрузка фото -> витрина обновилась ≤ 60 сек
```

Фронтенды локально:

```sh
cd frontend/cabinet && npm install && npm run dev      # http://localhost:5173/app/
cd frontend/storefront && npm install && npm run dev   # http://localhost:3000
```

## Деплой в прод

Один сервер с Docker, образы из GHCR, фото — в облачном S3-совместимом
хранилище. Локальный `deploy/docker-compose.yml` для прода не годится:
он держит MinIO рядом, публикует порты Postgres и Redis наружу и слушает
`:80` без TLS.

Что нужно до первого деплоя:

1. Домен с A-записью на сервер, открытые 80 и 443 — Caddy выпускает
   сертификат Let's Encrypt сам, отдельный шаг не нужен.
2. Бакет в S3 (Yandex Object Storage, VK Cloud — любой S3-совместимый)
   и CDN-домен, смотрящий на префикс `drv/` этого бакета. Деривативы
   отдаются только с него: контент не должен идти с домена приложения.
3. SMTP: без почты не работают регистрация и сброс пароля.
4. Проверить, что среди существующих магазинов нет slug'ов, которые теперь
   заняты публичными страницами:
   `select slug from shops where slug in ('pricing','updates','remove-bg')`.
   Эндпоинта смены slug нет — чинить придётся в БД.

Дальше на сервере:

```sh
git clone https://github.com/killwifu/katalog.git && cd katalog
cp .env.prod.example .env      # заполнить: домен, S3, SMTP, пароли, секреты
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
```

Образы собирает CI и пушит в GHCR на каждый push в `main`: тег `latest`
и тег по sha коммита. Обновление и откат — сменой `IMAGE_TAG` в `.env`:

```sh
IMAGE_TAG=<sha> docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
```

Миграции применяет one-shot сервис `migrate` при каждом старте стека,
до запуска `api` и `worker`.

Бэкапить нужно том `pgdata` и бакет S3. Тома `redisdata` (кеш и очередь)
и `caddydata` (сертификаты) восстанавливаются сами.

## Структура

```
backend/     Go: cmd/api, cmd/worker, internal/{api,worker,db,billing,mail,...}
frontend/
  cabinet/     Vite + React + TS + Tailwind + TanStack Router (раздаётся по /app/)
  storefront/  Next.js App Router: app/(marketing) — публичные страницы,
               app/[slug] — витрина магазина. Дизайн-токены в app/globals.css,
               вёрстка страниц — в CSS-модулях рядом с ними
deploy/      docker-compose.yml, Caddyfile
api/         openapi.yaml — источник правды для контрактов
migrations/  goose-миграции (schema для sqlc)
```

Фоновые задачи воркера (asynq): обработка фото, отправка писем; по крону —
агрегация статистики (00:30 UTC), биллинговый жизненный цикл (00:45),
рекуррентные списания (01:00), алерт на аномальный трафик (01:15),
ежемесячный дайджест продавцам (06:00 первого числа).

## Конвенции

- SQL только через sqlc: запросы в `backend/internal/db/queries/*.sql`,
  после изменения — `make sqlc-gen`, генерированный код коммитится.
- Каждая фича = миграция + запросы sqlc + handler + тест + обновление
  `api/openapi.yaml` (если меняется публичный контракт).
- Секреты только через env; `.env.example` поддерживать актуальным.
