// Package api — HTTP-хендлеры REST API /api/v1.
package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strings"

	sentryhttp "github.com/getsentry/sentry-go/http"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/billing"
	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
	"katalog/backend/internal/revalidate"
	"katalog/backend/internal/storage"
)

type API struct {
	Q *db.Queries
	// Pool — для транзакций (обработка платёжных вебхуков).
	Pool       *pgxpool.Pool
	Sessions   *auth.Sessions
	Tokens     *auth.Tokens
	RDB        *redis.Client
	Store      *storage.Client
	Tasks      *asynq.Client
	Revalidate *revalidate.Notifier
	Billing    *billing.Client
	// PublicLatency — гистограмма латентности публичных запросов для /metrics.
	PublicLatency *Histogram
	Cfg           config.Config
	Log           *slog.Logger
}

func (a *API) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	// Паника доходит до Sentry и летит дальше в Recoverer, который отвечает 500.
	// Без SENTRY_DSN — no-op.
	r.Use(sentryhttp.New(sentryhttp.Options{Repanic: true}).Handle)
	r.Use(rejectNUL)

	r.Get("/healthz", a.handleHealthz)
	// Бизнес-метрики Prometheus. Наружу через Caddy не проксируется.
	r.Get("/metrics", a.handleMetrics)

	r.Route("/api/v1", func(r chi.Router) {
		// Публичные эндпоинты витрины: отдельный неймспейс, без сессии,
		// отдельные response-типы (никаких приватных полей наружу).
		r.Route("/public", func(r chi.Router) {
			r.Use(a.measurePublic)
			r.Use(a.rateLimit("public", a.Cfg.PublicRateLimit))
			r.Get("/shops/{slug}", a.handlePublicShop)
			r.Get("/shops/{slug}/albums/{albumID}", a.handlePublicAlbum)
			// Подбор пароля альбома ограничен так же жёстко, как вход:
			// общий лимит публичных страниц для этого слишком щедрый.
			r.With(a.rateLimit("unlock", a.Cfg.AuthRateLimit)).
				Post("/shops/{slug}/albums/{albumID}/unlock", a.handlePublicAlbumUnlock)
			r.Get("/shops/{slug}/search", a.handlePublicSearch)
			r.Get("/shops/{slug}/tabs/{tabSlug}", a.handlePublicTab)
			r.Get("/shops/{slug}/categories", a.handlePublicCategories)
			r.Get("/shops/{slug}/categories/{categorySlug}", a.handlePublicCategory)
			r.Post("/lead-click", a.handleLeadClick)
			r.Get("/sitemap", a.handlePublicSitemap)
			r.Get("/config", a.handlePublicConfig)
			// Notice-and-takedown: жалоба правообладателя, без auth.
			r.Post("/complaints", a.handleCreateComplaint)
		})

		// Вебхук ЮKassa: без сессии; подлинность проверяется запросом
		// статуса платежа к самой ЮKassa (см. handleYooKassaWebhook).
		r.Post("/billing/webhooks/yookassa", a.handleYooKassaWebhook)

		// Auth: с rate-limit (Redis) по IP.
		r.Group(func(r chi.Router) {
			r.Use(a.rateLimit("auth", a.Cfg.AuthRateLimit))
			r.Post("/auth/register", a.handleRegister)
			r.Post("/auth/login", a.handleLogin)
			r.Post("/auth/password/forgot", a.handleForgotPassword)
			r.Post("/auth/password/reset", a.handleResetPassword)
			r.Post("/auth/password/reset/check", a.handleCheckResetToken)
			r.Post("/auth/verify-email", a.handleVerifyEmail)
			r.Post("/auth/email/confirm", a.handleConfirmEmailChange)
			// Вход через Яндекс / VK: переходы браузера, не fetch.
			r.Get("/auth/oauth/{provider}/start", a.handleOAuthStart)
			r.Get("/auth/oauth/{provider}/callback", a.handleOAuthCallback)
		})
		// Что показать на экранах входа: кнопки провайдеров и цены тарифов
		// для плашки «Тариф … — N ₽» (магазина ещё нет).
		r.Get("/auth/options", a.handleAuthOptions)
		r.Group(func(r chi.Router) {
			r.Use(a.requireAuth)
			r.Post("/auth/logout", a.handleLogout)
			r.Get("/auth/me", a.handleMe)
			// Подбор текущего пароля чужой открытой сессией ограничен тем же
			// лимитом, что и вход.
			r.With(a.rateLimit("auth", a.Cfg.AuthRateLimit)).Post("/auth/password/change", a.handleChangePassword)
			r.With(a.rateLimit("auth", a.Cfg.AuthRateLimit)).Post("/auth/email/change", a.handleChangeEmail)
			r.Post("/auth/verify-email/resend", a.handleResendVerification)
			r.Post("/auth/register/cancel", a.handleCancelRegistration)

			r.Route("/shops", func(r chi.Router) {
				r.With(a.requireVerifiedEmail).Post("/", a.handleCreateShop)
				r.Get("/", a.handleListShops)
				r.Get("/slug-check", a.handleSlugCheck)
				r.Route("/{shopID}", func(r chi.Router) {
					r.Use(a.requireShop)
					r.Get("/", a.handleGetShop)
					r.Patch("/", a.handleUpdateShop)
					r.Delete("/", a.handleDeleteShop)

					r.Get("/billing", a.handleGetBilling)
					r.Get("/billing/quote", a.handleQuoteBilling)
					r.Get("/billing/payments", a.handleListPayments)
					r.Post("/billing/subscribe", a.handleSubscribe)
					r.Post("/billing/cancel", a.handleCancelSubscription)
					r.Post("/billing/resume", a.handleResumeSubscription)
					r.Post("/billing/trial", a.handleStartTrial)
					r.Get("/stats", a.handleShopStats)

					r.Route("/tabs", func(r chi.Router) {
						r.Post("/", a.handleCreateTab)
						r.Get("/", a.handleListTabs)
						r.Put("/order", a.handleSetTabOrder)
						r.Patch("/{tabID}", a.handleUpdateTab)
						r.Delete("/{tabID}", a.handleDeleteTab)
						r.Post("/{tabID}/sections", a.handleCreateSection)
					})

					r.Route("/sections", func(r chi.Router) {
						r.Get("/", a.handleListSections)
						r.Patch("/{sectionID}", a.handleUpdateSection)
						r.Delete("/{sectionID}", a.handleDeleteSection)
						r.Put("/{sectionID}/albums", a.handleSetSectionAlbums)
					})

					r.Route("/categories", func(r chi.Router) {
						r.Post("/", a.handleCreateCategory)
						r.Get("/", a.handleListCategories)
						r.Patch("/{categoryID}", a.handleUpdateCategory)
						r.Patch("/{categoryID}/visibility", a.handleSetCategoryVisibility)
						r.Put("/{categoryID}/albums/order", a.handleSetCategoryAlbumOrder)
						r.Put("/{categoryID}/albums/{albumID}", a.handleAddAlbumToCategory)
						r.Delete("/{categoryID}/albums/{albumID}", a.handleRemoveAlbumFromCategory)
						r.Delete("/{categoryID}", a.handleDeleteCategory)
					})

					r.Route("/trash", func(r chi.Router) {
						r.Get("/", a.handleListTrash)
						r.Delete("/", a.handleEmptyTrash)
						r.Post("/albums/{albumID}/restore", a.handleRestoreAlbum)
						r.Delete("/albums/{albumID}", a.handlePurgeAlbum)
						r.Post("/{photoID}/restore", a.handleRestorePhoto)
						r.Delete("/{photoID}", a.handlePurgePhoto)
					})

					r.Route("/albums", func(r chi.Router) {
						r.Post("/", a.handleCreateAlbum)
						r.Get("/", a.handleListAlbums)
						r.Route("/{albumID}", func(r chi.Router) {
							r.Get("/", a.handleGetAlbum)
							r.Patch("/", a.handleUpdateAlbum)
							r.Patch("/category", a.handleSetAlbumCategory)
							r.Delete("/", a.handleDeleteAlbum)
							r.Get("/photos", a.handleListPhotos)
							r.Put("/photos/order", a.handleSetPhotoOrder)
							r.Get("/download", a.handleAlbumDownload)
							r.Get("/stats", a.handleAlbumStats)
						})
					})
				})
			})

			r.Post("/uploads/presign", a.handlePresign)
			r.Post("/photos/confirm", a.handleConfirmPhotos)
			r.Patch("/photos/{photoID}", a.handleUpdatePhoto)
			r.Delete("/photos/{photoID}", a.handleDeletePhoto)

			// Админ-зона: только для users.role=admin (не-админам 404).
			r.Route("/admin", func(r chi.Router) {
				r.Use(a.requireAdmin)
				r.Get("/overview", a.handleAdminOverview)
				r.Get("/shops", a.handleAdminListShops)
				r.Get("/complaints", a.handleAdminListComplaints)
				r.Patch("/complaints/{complaintID}", a.handleAdminUpdateComplaint)
				r.Get("/photos/flagged", a.handleAdminListFlagged)
				r.Post("/photos/{photoID}/block", a.handleAdminBlockPhoto)
				r.Post("/photos/{photoID}/unblock", a.handleAdminUnblockPhoto)
				r.Post("/photos/{photoID}/unflag", a.handleAdminUnflagPhoto)
				r.Post("/albums/{albumID}/hide", a.handleAdminHideAlbum)
				r.Post("/albums/{albumID}/unhide", a.handleAdminUnhideAlbum)
				r.Post("/shops/{shopID}/suspend", a.handleAdminSuspendShop)
				r.Post("/shops/{shopID}/unsuspend", a.handleAdminUnsuspendShop)
			})
		})
	})

	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// apiError — единый формат ошибок: {"error": "machine_code", "message": "..."}.
func apiError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeBody(w, r, dst, true)
}

// decodeExternalJSON — тело от внешнего сервиса (вебхук ЮKassa): его формат
// задаём не мы, и провайдер присылает больше полей, чем мы читаем (paid,
// created_at, test, authorization_details…). Со строгим разбором каждое
// настоящее уведомление получало 400.
func decodeExternalJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeBody(w, r, dst, false)
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any, strict bool) bool {
	// Только application/json. «Простой» межсайтовый запрос (форма, text/plain)
	// этот тип выставить не может без preflight, который мы не разрешаем, —
	// защита от CSRF, не зависящая от SameSite у cookie (тот же сайт —
	// это и соседние поддомены). Раньше JSON принимался с любым типом.
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		apiError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "request body must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		apiError(w, http.StatusBadRequest, "bad_json", "invalid request body: "+err.Error())
		return false
	}
	// Тело `null` раскладывалось в пустую структуру без ошибки, и запрос
	// без единого поля проходил как валидный. Контракт — JSON-объект.
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		apiError(w, http.StatusBadRequest, "bad_json", "invalid request body: must be a JSON object")
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if strict {
		dec.DisallowUnknownFields()
	}
	if err := dec.Decode(dst); err != nil {
		apiError(w, http.StatusBadRequest, "bad_json", "invalid request body: "+err.Error())
		return false
	}
	// NUL в строке Postgres не хранит («invalid byte sequence for encoding
	// UTF8: 0x00»): такой запрос доходил до базы и отвечал 500 — на любом
	// текстовом поле. В JSON NUL приходит только экранированным.
	if hasEscapedNUL(raw) {
		apiError(w, http.StatusBadRequest, "bad_json", "invalid request body: NUL character is not allowed")
		return false
	}
	// Второй объект после первого (`{...}{...}`) раньше молча отбрасывался:
	// тело принималось не таким, каким его отправили.
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		apiError(w, http.StatusBadRequest, "bad_json", "invalid request body: unexpected data after JSON object")
		return false
	}
	return true
}

// clientIP: последний адрес в X-Forwarded-For — тот, что дописал наш Caddy.
// Именно последний, а не первый: Caddy добавляет адрес пира к тому, что
// прислал клиент, а клиент может прислать что угодно. По первому адресу
// rate-limit на /auth обходился одним заголовком.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.LastIndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[i+1:])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// hasEscapedNUL ищет в теле JSON экранированный NUL (\u0000), не считая
// строки с экранированной обратной косой («\\u0000» — это текст, не NUL).
func hasEscapedNUL(raw []byte) bool {
	for i := 0; ; {
		j := bytes.Index(raw[i:], []byte(`\u0000`))
		if j < 0 {
			return false
		}
		k := i + j
		slashes := 0
		for p := k - 1; p >= 0 && raw[p] == '\\'; p-- {
			slashes++
		}
		if slashes%2 == 0 {
			return true
		}
		i = k + 1
	}
}

// rejectNUL отклоняет NUL в пути и параметрах запроса (%00): дальше они
// уходили бы в запросы к базе (slug, поиск) и заканчивались 500.
func rejectNUL(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.ContainsRune(r.URL.Path, 0) || strings.Contains(r.URL.RawQuery, "%00") || strings.ContainsRune(r.URL.RawQuery, 0) {
			apiError(w, http.StatusBadRequest, "bad_request", "NUL character is not allowed")
			return
		}
		next.ServeHTTP(w, r)
	})
}
