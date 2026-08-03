// Package api — HTTP-хендлеры REST API /api/v1.
package api

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"strings"

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
	Cfg        config.Config
	Log        *slog.Logger
}

func (a *API) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	r.Route("/api/v1", func(r chi.Router) {
		// Публичные эндпоинты витрины: отдельный неймспейс, без сессии,
		// отдельные response-типы (никаких приватных полей наружу).
		r.Route("/public", func(r chi.Router) {
			r.Use(a.rateLimit("public", a.Cfg.PublicRateLimit))
			r.Get("/shops/{slug}", a.handlePublicShop)
			r.Get("/shops/{slug}/albums/{albumID}", a.handlePublicAlbum)
			r.Get("/shops/{slug}/search", a.handlePublicSearch)
			r.Post("/lead-click", a.handleLeadClick)
			r.Get("/sitemap", a.handlePublicSitemap)
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
			r.Post("/auth/verify-email", a.handleVerifyEmail)
		})
		r.Group(func(r chi.Router) {
			r.Use(a.requireAuth)
			r.Post("/auth/logout", a.handleLogout)
			r.Get("/auth/me", a.handleMe)

			r.Route("/shops", func(r chi.Router) {
				r.Post("/", a.handleCreateShop)
				r.Get("/", a.handleListShops)
				r.Route("/{shopID}", func(r chi.Router) {
					r.Use(a.requireShop)
					r.Get("/", a.handleGetShop)
					r.Patch("/", a.handleUpdateShop)
					r.Delete("/", a.handleDeleteShop)

					r.Get("/billing", a.handleGetBilling)
					r.Post("/billing/subscribe", a.handleSubscribe)
					r.Post("/billing/cancel", a.handleCancelSubscription)

					r.Route("/albums", func(r chi.Router) {
						r.Post("/", a.handleCreateAlbum)
						r.Get("/", a.handleListAlbums)
						r.Route("/{albumID}", func(r chi.Router) {
							r.Get("/", a.handleGetAlbum)
							r.Patch("/", a.handleUpdateAlbum)
							r.Delete("/", a.handleDeleteAlbum)
							r.Get("/photos", a.handleListPhotos)
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
				r.Get("/complaints", a.handleAdminListComplaints)
				r.Patch("/complaints/{complaintID}", a.handleAdminUpdateComplaint)
				r.Get("/photos/flagged", a.handleAdminListFlagged)
				r.Post("/photos/{photoID}/block", a.handleAdminBlockPhoto)
				r.Post("/photos/{photoID}/unflag", a.handleAdminUnflagPhoto)
				r.Post("/albums/{albumID}/hide", a.handleAdminHideAlbum)
				r.Post("/shops/{shopID}/suspend", a.handleAdminSuspendShop)
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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		apiError(w, http.StatusBadRequest, "bad_json", "invalid request body: "+err.Error())
		return false
	}
	return true
}

// clientIP: за Caddy берём первый адрес из X-Forwarded-For.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
