package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/db"
)

type ctxKey int

const (
	ctxUserID ctxKey = iota
	ctxShop
)

func userID(r *http.Request) uuid.UUID {
	id, _ := r.Context().Value(ctxUserID).(uuid.UUID)
	return id
}

func shopFromCtx(r *http.Request) db.Shop {
	shop, _ := r.Context().Value(ctxShop).(db.Shop)
	return shop
}

// requireAuth достаёт сессию из httpOnly cookie и кладёт userID в контекст.
func (a *API) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(auth.SessionCookie)
		if err != nil {
			apiError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
			return
		}
		uid, err := a.Sessions.Get(r.Context(), cookie.Value)
		if errors.Is(err, auth.ErrNoSession) {
			apiError(w, http.StatusUnauthorized, "unauthorized", "session expired")
			return
		}
		if err != nil {
			a.Log.Error("session lookup failed", "error", err)
			apiError(w, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxUserID, uid)))
	})
}

// requireShop проверяет владение магазином из URL (тенант-изоляция):
// чужой или несуществующий магазин — всегда 404.
func (a *API) requireShop(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		shopID, err := uuid.Parse(chi.URLParam(r, "shopID"))
		if err != nil {
			apiError(w, http.StatusNotFound, "not_found", "shop not found")
			return
		}
		shop, err := a.Q.GetShopForOwner(r.Context(), db.GetShopForOwnerParams{
			ID:      shopID,
			OwnerID: userID(r),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "shop not found")
			return
		}
		if err != nil {
			a.Log.Error("load shop failed", "error", err)
			apiError(w, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxShop, shop)))
	})
}

// requireAdmin — доступ только для users.role=admin. Не-админам всегда 404,
// чтобы не раскрывать существование админ-зоны.
func (a *API) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := a.Q.GetUserByID(r.Context(), userID(r))
		if err != nil {
			a.Log.Error("load user for admin check failed", "error", err)
			apiError(w, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		if user.Role != db.UserRoleAdmin {
			apiError(w, http.StatusNotFound, "not_found", "not found")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// rateLimit — фиксированное окно в Redis: limit запросов в минуту с одного IP.
func (a *API) rateLimit(name string, limit int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := fmt.Sprintf("rl:%s:%s:%d", name, clientIP(r), time.Now().Unix()/60)
			n, err := a.RDB.Incr(r.Context(), key).Result()
			if err != nil {
				// Redis недоступен — пропускаем, а не блокируем весь auth.
				a.Log.Error("rate limit incr failed", "error", err)
				next.ServeHTTP(w, r)
				return
			}
			if n == 1 {
				a.RDB.Expire(r.Context(), key, time.Minute)
			}
			if n > limit {
				apiError(w, http.StatusTooManyRequests, "rate_limited", "too many requests, slow down")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
