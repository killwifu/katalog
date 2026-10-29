package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
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

// Пароль на альбом.
//
// Покупатель вводит пароль один раз и получает пропуск — случайный токен,
// который живёт в Redis. С ним витрина запрашивает содержимое альбома
// напрямую из браузера: серверный рендер и его кеш закрытого альбома не
// видят вовсе.
//
// Чего пароль НЕ даёт: адреса картинок на CDN остаются публичными. Кто
// получил прямую ссылку на файл, откроет его и без пароля — закрыта
// страница альбома, а не сами файлы.

const (
	albumUnlockTTL    = 12 * time.Hour
	albumTokenHeader  = "X-Album-Token"
	albumUnlockPrefix = "albumunlock:"
	// Защита от перебора (макет 15 · «много попыток»): 5 неверных паролей
	// подряд с одного адреса — ввод закрыт на 15 минут. Общий лимит
	// unlock (AuthRateLimit в минуту) остаётся поверх.
	albumFailPrefix  = "albumfail:"
	albumFailMax     = 5
	albumFailLockout = 15 * time.Minute
)

// albumPassFingerprint привязывает пропуск к текущему паролю: сменил
// продавец пароль — прежние пропуска перестали подходить.
func albumPassFingerprint(album db.Album) string {
	if album.PasswordHash == nil {
		return ""
	}
	sum := sha256.Sum256([]byte(*album.PasswordHash))
	return album.ID.String() + ":" + hex.EncodeToString(sum[:8])
}

func (a *API) albumUnlocked(r *http.Request, album db.Album) bool {
	token := r.Header.Get(albumTokenHeader)
	if len(token) != 64 {
		return false
	}
	got, err := a.RDB.Get(r.Context(), albumUnlockPrefix+token).Result()
	if err != nil {
		return false
	}
	return got == albumPassFingerprint(album)
}

// albumLock — чей пароль закрывает альбом: свой, а без своего — родителя.
// Раньше подальбом закрытого альбома открывался по прямой ссылке без пароля
// (его id есть в ответе главной). Пропуск родителя подходит и подальбому:
// покупатель вводит пароль один раз на всю ветку.
func (a *API) albumLock(ctx context.Context, album db.Album) (db.Album, error) {
	if album.PasswordHash != nil || !album.ParentID.Valid {
		return album, nil
	}
	parent, err := a.Q.GetPublicAlbum(ctx, db.GetPublicAlbumParams{ID: album.ParentID, ShopID: album.ShopID})
	if errors.Is(err, pgx.ErrNoRows) {
		// Не бывает: GetPublicAlbum не отдаёт подальбом скрытого родителя.
		return album, nil
	}
	if err != nil {
		return album, fmt.Errorf("load parent album: %w", err)
	}
	if parent.PasswordHash != nil {
		return parent, nil
	}
	return album, nil
}

// handlePublicAlbumUnlock проверяет пароль альбома и выдаёт пропуск.
func (a *API) handlePublicAlbumUnlock(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	albumID, err := uuid.Parse(chi.URLParam(r, "albumID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	album, err := a.Q.GetPublicAlbum(r.Context(), db.GetPublicAlbumParams{ID: uuid.NullUUID{UUID: albumID, Valid: true}, ShopID: shop.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	if err != nil {
		a.internalError(w, "load public album", err)
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	album, err = a.albumLock(r.Context(), album)
	if err != nil {
		a.internalError(w, "album lock", err)
		return
	}
	if album.PasswordHash == nil {
		apiError(w, http.StatusBadRequest, "not_protected", "album has no password")
		return
	}
	failKey := albumFailPrefix + album.ID.String() + ":" + clientIP(r)
	if n, _ := a.RDB.Get(r.Context(), failKey).Int(); n >= albumFailMax {
		a.albumLockedOut(w, r, failKey)
		return
	}
	// Слишком длинное не хешируем: argon2 дорогой, и это был бы способ
	// нагрузить сервер без подбора.
	match := false
	if req.Password != "" && len([]rune(req.Password)) <= maxAlbumPassword {
		if match, err = auth.VerifyPassword(req.Password, *album.PasswordHash); err != nil {
			a.internalError(w, "verify album password", err)
			return
		}
	}
	if !match {
		// Счётчик живёт 15 минут с последней ошибки; пятая закрывает ввод.
		n, err := a.RDB.Incr(r.Context(), failKey).Result()
		if err == nil {
			a.RDB.Expire(r.Context(), failKey, albumFailLockout)
		}
		if n >= albumFailMax {
			a.albumLockedOut(w, r, failKey)
			return
		}
		apiError(w, http.StatusForbidden, "wrong_password", "wrong password")
		return
	}
	a.RDB.Del(r.Context(), failKey)
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		a.internalError(w, "album token", err)
		return
	}
	token := hex.EncodeToString(raw)
	if err := a.RDB.Set(r.Context(), albumUnlockPrefix+token, albumPassFingerprint(album), albumUnlockTTL).Err(); err != nil {
		a.internalError(w, "store album token", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"expires_in": int(albumUnlockTTL.Seconds()),
	})
}

// albumLockedOut — ввод пароля закрыт: 429 и сколько секунд ждать.
func (a *API) albumLockedOut(w http.ResponseWriter, r *http.Request, failKey string) {
	ttl, err := a.RDB.TTL(r.Context(), failKey).Result()
	if err != nil || ttl <= 0 {
		ttl = albumFailLockout
	}
	secs := int(ttl.Seconds())
	w.Header().Set("Retry-After", fmt.Sprint(secs))
	writeJSON(w, http.StatusTooManyRequests, map[string]any{
		"error":       "too_many_attempts",
		"message":     "too many wrong passwords, try later",
		"retry_after": secs,
	})
}
