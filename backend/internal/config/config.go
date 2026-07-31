// Package config загружает конфигурацию приложения из переменных окружения.
package config

import "os"

type Config struct {
	// HTTPAddr — адрес API-сервера, например ":8080".
	HTTPAddr string
	// WorkerHealthAddr — адрес health-эндпоинта воркера.
	WorkerHealthAddr string
	DatabaseURL      string
	RedisAddr        string
	S3Endpoint       string
	S3Bucket         string
	S3AccessKey      string
	S3SecretKey      string
}

func Load() Config {
	return Config{
		HTTPAddr:         getenv("HTTP_ADDR", ":8080"),
		WorkerHealthAddr: getenv("WORKER_HEALTH_ADDR", ":8081"),
		DatabaseURL:      getenv("DATABASE_URL", "postgres://katalog:katalog@localhost:5432/katalog?sslmode=disable"),
		RedisAddr:        getenv("REDIS_ADDR", "localhost:6379"),
		S3Endpoint:       getenv("S3_ENDPOINT", "http://localhost:9000"),
		S3Bucket:         getenv("S3_BUCKET", "katalog"),
		S3AccessKey:      getenv("S3_ACCESS_KEY", "minioadmin"),
		S3SecretKey:      getenv("S3_SECRET_KEY", "minioadmin"),
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
