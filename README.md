# Katalog

Мультитенантный фотохостинг-витрина для малого бизнеса (см. `CLAUDE.md` —
контекст проекта и архитектурные инварианты).

## Требования

- Docker + Docker Compose v2
- Go 1.26+ (локальная разработка бэкенда)
- Node.js 20+ (локальная разработка фронтендов)
- [golangci-lint](https://golangci-lint.run/) v2 (`brew install golangci-lint`)
- [sqlc](https://sqlc.dev/) (`brew install sqlc`) — для `make sqlc-gen`

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
| `localhost/app/` | кабинет продавца (SPA) |
| `localhost/api/v1/...` | Go API |
| `localhost:9001` | консоль MinIO (minioadmin/minioadmin) |

Миграции применяются автоматически one-shot сервисом `migrate`,
бакет MinIO создаётся сервисом `minio-init`.

## Команды

```sh
make test      # go test ./... (unit; интеграционные — testcontainers, позже)
make lint      # golangci-lint + eslint + tsc --noEmit для обоих фронтендов
make migrate   # goose up на localhost:5432 (переопределяется DATABASE_URL=...)
make sqlc-gen  # регенерация Go-кода из internal/db/queries/*.sql
```

Фронтенды локально:

```sh
cd frontend/cabinet && npm install && npm run dev      # http://localhost:5173/app/
cd frontend/storefront && npm install && npm run dev   # http://localhost:3000
```

## Структура

```
backend/     Go: cmd/api, cmd/worker, internal/{config,server,db}
frontend/
  cabinet/     Vite + React + TS + Tailwind + TanStack Router (раздаётся по /app/)
  storefront/  Next.js App Router (SSR витрина)
deploy/      docker-compose.yml, Caddyfile
api/         openapi.yaml — источник правды для контрактов
migrations/  goose-миграции (schema для sqlc)
```

## Конвенции

- SQL только через sqlc: запросы в `backend/internal/db/queries/*.sql`,
  после изменения — `make sqlc-gen`, генерированный код коммитится.
- Каждая фича = миграция + запросы sqlc + handler + тест + обновление
  `api/openapi.yaml` (если меняется публичный контракт).
- Секреты только через env; `.env.example` поддерживать актуальным.
