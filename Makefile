-include .env
COMPOSE := docker compose --env-file .env -f deploy/docker-compose.yml
POSTGRES_PORT ?= 5432
DATABASE_URL ?= postgres://katalog:katalog@localhost:$(POSTGRES_PORT)/katalog?sslmode=disable
GOOSE := go run github.com/pressly/goose/v3/cmd/goose@v3.26.0

.PHONY: up down test lint migrate sqlc-gen seed e2e

.env:
	cp .env.example .env

up: .env
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

test:
	cd backend && go test ./...

lint:
	cd backend && golangci-lint run ./...
	cd frontend/cabinet && npm run lint && npm run typecheck
	cd frontend/storefront && npm run lint && npm run typecheck

migrate:
	cd backend && $(GOOSE) -dir ../migrations postgres "$(DATABASE_URL)" up

sqlc-gen:
	cd backend && sqlc generate

# Демо-магазин на запущенном стеке (make up).
seed:
	cd backend && go run ./cmd/seed

# Приёмка: «загрузил фото -> витрина обновилась ≤ 60 сек» + сидинг.
e2e:
	cd backend && go run ./cmd/seed -e2e
