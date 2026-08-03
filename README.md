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

После `make up` доступно:

| URL | Что |
| --- | --- |
| `localhost/` и `localhost/{slug}` | витрина (Next.js SSR) |
| `localhost/app/` | кабинет продавца (SPA), тарифы — `/app/billing` |
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

## Структура

```
backend/     Go: cmd/api, cmd/worker, internal/{api,worker,db,billing,mail,...}
frontend/
  cabinet/     Vite + React + TS + Tailwind + TanStack Router (раздаётся по /app/)
  storefront/  Next.js App Router (SSR витрина + статические страницы)
deploy/      docker-compose.yml, Caddyfile
api/         openapi.yaml — источник правды для контрактов
migrations/  goose-миграции (schema для sqlc)
```

Фоновые задачи воркера (asynq): обработка фото, отправка писем; по крону —
агрегация статистики (00:30 UTC), биллинговый жизненный цикл (00:45),
рекуррентные списания (01:00).

## Конвенции

- SQL только через sqlc: запросы в `backend/internal/db/queries/*.sql`,
  после изменения — `make sqlc-gen`, генерированный код коммитится.
- Каждая фича = миграция + запросы sqlc + handler + тест + обновление
  `api/openapi.yaml` (если меняется публичный контракт).
- Секреты только через env; `.env.example` поддерживать актуальным.
