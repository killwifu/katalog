// Package config загружает конфигурацию приложения из переменных окружения.
package config

import (
	"os"
	"strconv"
	"strings"
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
	// S3Region — регион в scope подписи SigV4. MinIO принимает любой,
	// облачные провайдеры проверяют: Yandex Object Storage — ru-central1.
	S3Region string
	// CookieSecure — Secure-флаг сессионной cookie (в проде за TLS — true).
	CookieSecure bool
	SessionTTL   time.Duration
	// AuthRateLimit — запросов в минуту с одного IP на auth-эндпоинты.
	AuthRateLimit int64
	// PublicRateLimit — запросов в минуту с одного IP на публичные эндпоинты.
	PublicRateLimit int64
	// StorefrontURL — внутренний адрес витрины Next.js для вебхука ревалидации.
	StorefrontURL string
	// APIInternalURL — внутренний адрес самого API. Воркер переотправляет
	// на него уведомления ЮKassa, которые не дошли (см. HandleBillingReconcile):
	// расчёт платежа живёт в одном месте, дублировать его в воркере нельзя.
	APIInternalURL string
	// RevalidateSecret — shared secret вебхука Go -> Next (пустой = вебхук выключен).
	RevalidateSecret string
	// SiteURL — публичный базовый URL (ссылки в письмах: сброс пароля и т.п.).
	SiteURL string
	// SentryDSN — куда фронты шлют свои ошибки (GET /api/v1/public/config).
	// DSN публичен по устройству Sentry; бэкенд читает его сам в errreport.
	SentryDSN string
	// MediaBaseURL — префикс URL деривативов. По умолчанию относительный
	// "/media" (его проксирует Caddy). В проде — отдельный CDN-домен:
	// контент не должен отдаваться с домена приложения.
	MediaBaseURL string
	// StopWords — стоп-слова подписей: совпадение ставит фото флаг ручной
	// проверки модератором (не автоблок). Пустой список = проверка выключена.
	StopWords []string
	Billing   BillingConfig
	Mail      MailConfig
	// OAuth — вход через внешних провайдеров (yandex, vk). Провайдер без
	// ClientID выключен: его кнопки на экранах входа нет.
	OAuth map[string]OAuthProvider
	// TrafficAlertMultiplier — во сколько раз дневные просмотры магазина
	// должны превысить средненедельные, чтобы уйдало письмо админу.
	TrafficAlertMultiplier float64
	// TrafficAlertMinViews — минимум просмотров за день для срабатывания
	// (отсекает шум маленьких магазинов).
	TrafficAlertMinViews int64
	// RetentionLeadClicksDays — сколько хранить сырые переходы в мессенджеры
	// (в них visitor_hash). Агрегат за день остаётся в daily_stats.
	// TrashKeepDays — сколько «Удаленное» держит фотографию до окончательной
	// уборки. Всё это время она занимает место в хранилище.
	TrashKeepDays           int64
	RetentionLeadClicksDays int64
	// RetentionDailyStatsDays — сколько хранить дневные агрегаты. Больше
	// года кабинет всё равно не показывает (максимум days=365).
	RetentionDailyStatsDays int64
}

// MailConfig — транзакционная почта. Пустой SMTPHost = письма пишутся в лог.
type MailConfig struct {
	SMTPHost string
	SMTPPort int
	SMTPUser string
	SMTPPass string
	// From — адрес отправителя писем, FromName — имя отправителя («ВУАД»).
	From     string
	FromName string
	// AdminEmail — куда уходят уведомления о новых жалобах (пусто = не слать).
	AdminEmail string
}

// OAuthProvider — настройки OAuth 2.0 провайдера. Адреса — константы
// провайдера; переопределяются только в тестах (фейковый провайдер).
type OAuthProvider struct {
	ClientID     string
	ClientSecret string
	AuthURL      string
	TokenURL     string
	UserInfoURL  string
	Scope        string
}

// PlanLimits — лимиты и цена тарифа. PriceKopecks 0 = бесплатный тариф.
type PlanLimits struct {
	MaxPhotos    int64
	MaxStorage   int64 // байты
	PriceKopecks int64 // цена оплаченного периода
}

type BillingConfig struct {
	// Plans — лимиты по имени тарифа (free/standard/pro/business).
	Plans map[string]PlanLimits
	// PeriodDays — длительность оплаченного месяца подписки (год — 365 дней).
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

// YearDays — длительность годового периода подписки.
const YearDays = 365

// Price — цена тарифа за период в копейках. Год — 12 месяцев со скидкой
// 25% (макет 18 · «Оплата за год»: 390 -> 3 510, 890 -> 8 010, 1 690 -> 15 210).
func (b BillingConfig) Price(plan string, year bool) int64 {
	p := b.Plans[plan].PriceKopecks
	if year {
		return p * 12 * 3 / 4
	}
	return p
}

// Days — длительность периода в днях.
func (b BillingConfig) Days(year bool) int {
	if year {
		return YearDays
	}
	return b.PeriodDays
}

func Load() Config {
	return Config{
		HTTPAddr:                getenv("HTTP_ADDR", ":8080"),
		WorkerHealthAddr:        getenv("WORKER_HEALTH_ADDR", ":8081"),
		DatabaseURL:             getenv("DATABASE_URL", "postgres://katalog:katalog@localhost:5432/katalog?sslmode=disable"),
		RedisAddr:               getenv("REDIS_ADDR", "localhost:6379"),
		S3Endpoint:              getenv("S3_ENDPOINT", "http://localhost:9000"),
		S3PublicEndpoint:        getenv("S3_PUBLIC_ENDPOINT", "http://localhost:9000"),
		S3Bucket:                getenv("S3_BUCKET", "katalog"),
		S3AccessKey:             getenv("S3_ACCESS_KEY", "minioadmin"),
		S3SecretKey:             getenv("S3_SECRET_KEY", "minioadmin"),
		S3Region:                getenv("S3_REGION", "us-east-1"),
		CookieSecure:            os.Getenv("COOKIE_SECURE") == "true",
		SessionTTL:              30 * 24 * time.Hour,
		AuthRateLimit:           getenvInt64("AUTH_RATE_LIMIT", 20),
		PublicRateLimit:         getenvInt64("PUBLIC_RATE_LIMIT", 300),
		StorefrontURL:           getenv("STOREFRONT_URL", "http://localhost:3000"),
		APIInternalURL:          getenv("API_INTERNAL_URL", "http://api:8080"),
		RevalidateSecret:        os.Getenv("REVALIDATE_SECRET"),
		SiteURL:                 getenv("SITE_URL", "http://localhost"),
		SentryDSN:               os.Getenv("SENTRY_DSN"),
		MediaBaseURL:            strings.TrimRight(getenv("MEDIA_BASE_URL", "/media"), "/"),
		StopWords:               splitList(os.Getenv("STOP_WORDS")),
		TrafficAlertMultiplier:  getenvFloat("TRAFFIC_ALERT_MULTIPLIER", 5),
		TrafficAlertMinViews:    getenvInt64("TRAFFIC_ALERT_MIN_VIEWS", 1000),
		TrashKeepDays:           getenvInt64("TRASH_KEEP_DAYS", 30),
		RetentionLeadClicksDays: getenvInt64("RETENTION_LEAD_CLICKS_DAYS", 90),
		RetentionDailyStatsDays: getenvInt64("RETENTION_DAILY_STATS_DAYS", 400),
		Mail: MailConfig{
			SMTPHost:   os.Getenv("SMTP_HOST"),
			SMTPPort:   int(getenvInt64("SMTP_PORT", 587)),
			SMTPUser:   os.Getenv("SMTP_USER"),
			SMTPPass:   os.Getenv("SMTP_PASS"),
			From:       getenv("MAIL_FROM", "noreply@localhost"),
			FromName:   getenv("MAIL_FROM_NAME", "ВУАД"),
			AdminEmail: os.Getenv("ADMIN_EMAIL"),
		},
		OAuth: map[string]OAuthProvider{
			// Яндекс ID: https://yandex.ru/dev/id/doc/ru/ (PKCE поддерживается).
			"yandex": {
				ClientID:     os.Getenv("OAUTH_YANDEX_CLIENT_ID"),
				ClientSecret: os.Getenv("OAUTH_YANDEX_CLIENT_SECRET"),
				AuthURL:      "https://oauth.yandex.ru/authorize",
				TokenURL:     "https://oauth.yandex.ru/token",
				UserInfoURL:  "https://login.yandex.ru/info?format=json",
				Scope:        "login:email login:info",
			},
			// VK ID (OAuth 2.1, PKCE обязателен, секрет не нужен):
			// https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/api-integration/realization
			"vk": {
				ClientID:    os.Getenv("OAUTH_VK_CLIENT_ID"),
				AuthURL:     "https://id.vk.com/authorize",
				TokenURL:    "https://id.vk.com/oauth2/auth",
				UserInfoURL: "https://id.vk.com/oauth2/user_info",
				Scope:       "email",
			},
		},
		Billing: BillingConfig{
			Plans: map[string]PlanLimits{
				"free": {
					MaxPhotos:  getenvInt64("PLAN_FREE_MAX_PHOTOS", 250),
					MaxStorage: getenvInt64("PLAN_FREE_MAX_STORAGE_MB", 1024) << 20,
				},
				"standard": {
					MaxPhotos:    getenvInt64("PLAN_STANDARD_MAX_PHOTOS", 2000),
					MaxStorage:   getenvInt64("PLAN_STANDARD_MAX_STORAGE_MB", 5*1024) << 20,
					PriceKopecks: getenvInt64("PLAN_STANDARD_PRICE_RUB", 390) * 100,
				},
				"pro": {
					MaxPhotos:    getenvInt64("PLAN_PRO_MAX_PHOTOS", 20000),
					MaxStorage:   getenvInt64("PLAN_PRO_MAX_STORAGE_MB", 40*1024) << 20,
					PriceKopecks: getenvInt64("PLAN_PRO_PRICE_RUB", 890) * 100,
				},
				"business": {
					MaxPhotos:    getenvInt64("PLAN_BUSINESS_MAX_PHOTOS", 70000),
					MaxStorage:   getenvInt64("PLAN_BUSINESS_MAX_STORAGE_MB", 120*1024) << 20,
					PriceKopecks: getenvInt64("PLAN_BUSINESS_PRICE_RUB", 1690) * 100,
				},
			},
			PeriodDays:        int(getenvInt64("BILLING_PERIOD_DAYS", 30)),
			YooKassaShopID:    os.Getenv("YOOKASSA_SHOP_ID"),
			YooKassaSecretKey: os.Getenv("YOOKASSA_SECRET_KEY"),
			YooKassaAPIURL:    getenv("YOOKASSA_API_URL", "https://api.yookassa.ru/v3"),
			ReturnURL:         getenv("BILLING_RETURN_URL", "http://localhost/app/billing"),
		},
	}
}

// splitList — comma-separated env в список непустых значений без пробелов.
func splitList(raw string) []string {
	var out []string
	for part := range strings.SplitSeq(raw, ",") {
		if v := strings.TrimSpace(part); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func getenvFloat(key string, fallback float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			return f
		}
	}
	return fallback
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
