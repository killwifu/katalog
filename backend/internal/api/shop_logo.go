package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"katalog/backend/internal/db"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

// Логотип витрины (макет 17 · «Витрина»). Как и фото: браузер грузит файл
// НАПРЯМУЮ в S3 по pre-signed URL, воркер проверяет его тем же пайплайном
// (magic bytes, лимит разрешения, вычистка EXIF) и кладёт WebP-дериватив.
// Покупателю уходит только дериватив.

// maxLogoBytes — логотип маленький; больше — почти наверняка не тот файл.
const maxLogoBytes = 10 << 20

// handleLogoPresign выдаёт id логотипа и URL для загрузки оригинала.
// ponytail: оригинал, загруженный без confirm, лежит до удаления магазина —
// уборка зависших загрузок смотрит только на photos; добавить её для логотипов,
// если такие файлы начнут копиться.
func (a *API) handleLogoPresign(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	logoID := uuid.New()
	url, err := a.Store.PresignPut(r.Context(), storage.OrigKey(shop.ID, logoID), presignTTL)
	if err != nil {
		a.internalError(w, "presign logo", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"logo_id": logoID.String(), "url": url})
}

type logoConfirmRequest struct {
	LogoID string `json:"logo_id"`
}

// handleLogoConfirm ставит загруженный логотип в обработку.
func (a *API) handleLogoConfirm(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req logoConfirmRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	logoID, err := uuid.Parse(req.LogoID)
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "logo not found")
		return
	}
	key := storage.OrigKey(shop.ID, logoID)
	size, exists, err := a.Store.StatSize(r.Context(), key)
	if err != nil {
		a.internalError(w, "stat logo", err)
		return
	}
	if !exists {
		apiError(w, http.StatusNotFound, "not_found", "logo not uploaded")
		return
	}
	if size > maxLogoBytes {
		_ = a.Store.Delete(r.Context(), key)
		apiError(w, http.StatusBadRequest, "logo_too_large", "logo must be at most 10 MB")
		return
	}
	task, err := tasks.NewShopLogo(shop.ID, logoID)
	if err == nil {
		_, err = a.Tasks.EnqueueContext(r.Context(), task)
	}
	if err != nil {
		a.internalError(w, "enqueue logo", err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// handleLogoStatus — обработан ли логотип: ready (стоит на витрине),
// failed (файл не подошёл) или processing.
func (a *API) handleLogoStatus(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	logoID, err := uuid.Parse(r.URL.Query().Get("logo_id"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "logo not found")
		return
	}
	status := "processing"
	switch reason, err := a.RDB.Get(r.Context(), tasks.LogoFailKey(logoID)).Result(); {
	case shop.LogoID.Valid && shop.LogoID.UUID == logoID:
		status = "ready"
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]string{"status": "failed", "reason": reason})
		return
	case !errors.Is(err, redis.Nil):
		a.internalError(w, "logo status", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status, "logo_url": a.logoURL(shop)})
}

// handleLogoDelete убирает логотип: в шапке витрины снова инициалы.
func (a *API) handleLogoDelete(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	if err := a.Q.SetShopLogo(r.Context(), db.SetShopLogoParams{ID: shop.ID}); err != nil {
		a.internalError(w, "delete logo", err)
		return
	}
	if shop.LogoID.Valid {
		if err := a.Store.RemovePhoto(r.Context(), shop.ID, shop.LogoID.UUID, []int{logoSize}); err != nil {
			a.Log.Warn("remove logo objects", "shop_id", shop.ID, "error", err)
		}
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

// logoSize — какой дериватив хранится у логотипа (small, 500 px).
const logoSize = 500
