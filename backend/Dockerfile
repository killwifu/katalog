# Контекст сборки — корень репозитория (нужен доступ к migrations/).
# Worker требует CGO+libvips, поэтому база — bookworm (совпадение версий
# libvips между build и runtime через пакеты одной версии дистрибутива).
FROM golang:1.26-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends libvips-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/api ./cmd/api \
 && CGO_ENABLED=1 go build -ldflags="-s -w" -o /out/worker ./cmd/worker \
 && CGO_ENABLED=0 go install github.com/pressly/goose/v3/cmd/goose@v3.26.0

FROM alpine:3.21 AS api
RUN adduser -D app
USER app
COPY --from=build /out/api /usr/local/bin/api
EXPOSE 8080
ENTRYPOINT ["api"]

FROM debian:bookworm-slim AS worker
RUN apt-get update \
 && apt-get install -y --no-install-recommends libvips42 ca-certificates wget \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m app
USER app
COPY --from=build /out/worker /usr/local/bin/worker
EXPOSE 8081
ENTRYPOINT ["worker"]

FROM alpine:3.21 AS migrate
COPY --from=build /go/bin/goose /usr/local/bin/goose
COPY migrations/ /migrations/
ENTRYPOINT ["goose", "-dir", "/migrations", "up"]
