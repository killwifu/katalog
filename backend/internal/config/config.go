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
	Billing          BillingConfig
}

// PlanLimits — лимиты и цена тарифа. PriceKopecks 0 = бесплатный тариф.
type PlanLimits struct {
	MaxPhotos    int64
	MaxStorage   int64 // байты
	PriceKopecks int64 // цена оплаченного периода
}

type BillingConfig struct {
	// Plans — лимиты по имени тарифа (free/basic/pro).
	Plans map[string]PlanLimits
	// GraceDays — длительность grace-периода после окончания оплаты
	// (загрузка заблокирована, витрина работает; затем витрина скрывается).
	GraceDays int
	// PeriodDays — длительность оплаченного периода подписки.
	PeriodDays int
	// ЮKassa. Пустой YooKassaShopID = платежи выключены (subscribe вернёт 503).
	YooKassaShopID    string
	YooKassaSecretKey string
	YooKassaAPIURL    string
	// ReturnURL — куда ЮKassa возвращает пользователя после оплаты.
	ReturnURL string
}

// Limits — лимиты тарифа; для неизвестного тарифа возвращает нулевые лимиты
// (safe default: загрузка будет запрещена).
func (b BillingConfig) Limits(plan string) PlanLimits {
	return b.Plans[plan]
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
		Billing: BillingConfig{
			Plans: map[string]PlanLimits{
				"free": {
					MaxPhotos:  getenvInt64("PLAN_FREE_MAX_PHOTOS", 500),
					MaxStorage: getenvInt64("PLAN_FREE_MAX_STORAGE_MB", 1024) << 20,
				},
				"basic": {
					MaxPhotos:    getenvInt64("PLAN_BASIC_MAX_PHOTOS", 5000),
					MaxStorage:   getenvInt64("PLAN_BASIC_MAX_STORAGE_MB", 10*1024) << 20,
					PriceKopecks: getenvInt64("PLAN_BASIC_PRICE_RUB", 490) * 100,
				},
				"pro": {
					MaxPhotos:    getenvInt64("PLAN_PRO_MAX_PHOTOS", 20000),
					MaxStorage:   getenvInt64("PLAN_PRO_MAX_STORAGE_MB", 20*1024) << 20,
					PriceKopecks: getenvInt64("PLAN_PRO_PRICE_RUB", 990) * 100,
				},
			},
			GraceDays:         int(getenvInt64("BILLING_GRACE_DAYS", 14)),
			PeriodDays:        int(getenvInt64("BILLING_PERIOD_DAYS", 30)),
			YooKassaShopID:    os.Getenv("YOOKASSA_SHOP_ID"),
			YooKassaSecretKey: os.Getenv("YOOKASSA_SECRET_KEY"),
			YooKassaAPIURL:    getenv("YOOKASSA_API_URL", "https://api.yookassa.ru/v3"),
			ReturnURL:         getenv("BILLING_RETURN_URL", "http://localhost/app/billing"),
		},
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
