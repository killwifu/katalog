// Package config загружает конфигурацию приложения из переменных окружения.
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	// HTTPAddr — адрес API-сервера, например ":8080".
	HTTPAddr string
	// WorkerHealthAddr — адрес health/metrics-эндпоинта воркера.
	WorkerHealthAddr string
	DatabaseURL      string
	RedisAddr        string
	S3Endpoint       string
	// S3PublicEndpoint — endpoint, доступный из браузера (для presigned URL).
	S3PublicEndpoint string
	S3Bucket         string
	S3AccessKey      string
	S3SecretKey      string
	// CookieSecure — Secure-флаг сессионной cookie (в проде за TLS — true).
	CookieSecure bool
	SessionTTL   time.Duration
	// AuthRateLimit — запросов в минуту с одного IP на auth-эндпоинты.
	AuthRateLimit int64
	// PublicRateLimit — запросов в минуту с одного IP на публичные эндпоинты.
	PublicRateLimit int64
	// StorefrontURL — внутренний адрес витрины Next.js для вебхука ревалидации.
	StorefrontURL string
	// RevalidateSecret — shared secret вебхука Go -> Next (пустой = вебхук выключен).
	RevalidateSecret string
}

func Load() Config {
	return Config{
		HTTPAddr:         getenv("HTTP_ADDR", ":8080"),
		WorkerHealthAddr: getenv("WORKER_HEALTH_ADDR", ":8081"),
		DatabaseURL:      getenv("DATABASE_URL", "postgres://katalog:katalog@localhost:5432/katalog?sslmode=disable"),
		RedisAddr:        getenv("REDIS_ADDR", "localhost:6379"),
		S3Endpoint:       getenv("S3_ENDPOINT", "http://localhost:9000"),
		S3PublicEndpoint: getenv("S3_PUBLIC_ENDPOINT", "http://localhost:9000"),
		S3Bucket:         getenv("S3_BUCKET", "katalog"),
		S3AccessKey:      getenv("S3_ACCESS_KEY", "minioadmin"),
		S3SecretKey:      getenv("S3_SECRET_KEY", "minioadmin"),
		CookieSecure:     os.Getenv("COOKIE_SECURE") == "true",
		SessionTTL:       30 * 24 * time.Hour,
		AuthRateLimit:    getenvInt64("AUTH_RATE_LIMIT", 20),
		PublicRateLimit:  getenvInt64("PUBLIC_RATE_LIMIT", 300),
		StorefrontURL:    getenv("STOREFRONT_URL", "http://localhost:3000"),
		RevalidateSecret: os.Getenv("REVALIDATE_SECRET"),
	}
}

func getenvInt64(key string, fallback int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
