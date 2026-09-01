package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

const (
	maxFileSize = 50 << 20 // 50 MiB на файл
	presignTTL  = 15 * time.Minute
)

type photoResponse struct {
	ID        string            `json:"id"`
	AlbumID   string            `json:"album_id"`
	Caption   string            `json:"caption"`
	Status    string            `json:"status"`
	Width     int32             `json:"width"`
	Height    int32             `json:"height"`
	SortOrder int32             `json:"sort_order"`
	Urls      map[string]string `json:"urls,omitempty"`
}

func (a *API) toPhotoResponse(p db.Photo) photoResponse {
	resp := photoResponse{
		ID:        p.ID.String(),
		AlbumID:   p.AlbumID.String(),
		Caption:   p.Caption,
		Status:    string(p.Status),
		Width:     p.Width,
		Height:    p.Height,
		SortOrder: p.SortOrder,
	}
	if p.Status == db.PhotoStatusReady {
		resp.Urls = a.mediaURLs(p.ShopID, p.ID)
	}
	return resp
}

type presignRequest struct {
	ShopID  string `json:"shop_id"`
	AlbumID string `json:"album_id"`
	Size    int64  `json:"size"`
}

type presignResponse struct {
	PhotoID string `json:"photo_id"`
	URL     string `json:"url"`
}

// handlePresign: проверка владения и квоты плана -> запись photo(uploading) ->
// pre-signed PUT. Клиент грузит НАПРЯМУЮ в S3, не через API.
func (a *API) handlePresign(w http.ResponseWriter, r *http.Request) {
	var req presignRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	shop, ok := a.ownedShop(w, r, req.ShopID)
	if !ok {
		return
	}
	albumID, err := uuid.Parse(req.AlbumID)
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	if _, err := a.Q.GetAlbumForShop(r.Context(), db.GetAlbumForShopParams{
		ID:     albumID,
		ShopID: shop.ID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "album not found")
			return
		}
		a.internalError(w, "load album", err)
		return
	}
	if req.Size <= 0 || req.Size > maxFileSize {
		apiError(w, http.StatusBadRequest, "invalid_size", fmt.Sprintf("size must be 1..%d bytes", maxFileSize))
		return
	}
	// Блокировка модератором: витрина скрыта, но загрузка продолжала
	// работать — магазин, снятый по жалобе, спокойно набирал новый
	// контент, и тот уехал бы на витрину при снятии блокировки.
	if shop.Status == db.ShopStatusSuspended {
		apiError(w, http.StatusForbidden, "shop_suspended",
			"shop is suspended by moderation: uploads are disabled")
		return
	}
	// Мягкий отказ по подписке: в grace/suspended загрузка заблокирована,
	// контент и витрина (в grace) продолжают работать.
	if shop.BillingState != db.BillingStateOk {
		apiError(w, http.StatusForbidden, "subscription_inactive",
			"subscription is inactive: uploads are disabled until the plan is renewed")
		return
	}
	limits := a.Cfg.Billing.Limits(string(shop.Plan))
	if shop.StorageUsed+req.Size > limits.MaxStorage {
		apiError(w, http.StatusForbidden, "quota_exceeded",
			"storage quota exceeded for current plan, upgrade your plan")
		return
	}

	// Счёт и вставка — под блокировкой на магазин. Иначе параллельные
	// presign читают одно и то же значение счётчика и проходят все:
	// десять одновременных запросов на 499/500 давали 509 фотографий,
	// а скриптом перебор не ограничен ничем.
	photo, err := a.createPhotoWithinQuota(r, shop, albumID, req.Size, limits.MaxPhotos)
	if errors.Is(err, errPhotoQuota) {
		apiError(w, http.StatusForbidden, "photo_quota_exceeded",
			fmt.Sprintf("plan photo limit reached (%d photos), upgrade your plan", limits.MaxPhotos))
		return
	}
	if err != nil {
		a.internalError(w, "create photo", err)
		return
	}
	url, err := a.Store.PresignPut(r.Context(), storage.OrigKey(shop.ID, photo.ID), presignTTL)
	if err != nil {
		a.internalError(w, "presign upload", err)
		return
	}
	writeJSON(w, http.StatusOK, presignResponse{PhotoID: photo.ID.String(), URL: url})
}

// errPhotoQuota — лимит фотографий тарифа исчерпан.
var errPhotoQuota = errors.New("photo quota exceeded")

// createPhotoWithinQuota считает фотографии и заводит новую в одной
// транзакции под блокировкой на магазин: проверка и вставка должны быть
// неделимы, иначе лимит обходится параллельными запросами. Блокировка
// транзакционная и на конкретный магазин — соседние продавцы не ждут.
func (a *API) createPhotoWithinQuota(
	r *http.Request, shop db.Shop, albumID uuid.UUID, size, maxPhotos int64,
) (db.Photo, error) {
	ctx := r.Context()
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return db.Photo{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := a.Q.WithTx(tx)

	if err := q.LockShopForUpload(ctx, shop.ID.String()); err != nil {
		return db.Photo{}, fmt.Errorf("lock shop: %w", err)
	}
	count, err := q.CountShopPhotos(ctx, shop.ID)
	if err != nil {
		return db.Photo{}, fmt.Errorf("count shop photos: %w", err)
	}
	if count >= maxPhotos {
		return db.Photo{}, errPhotoQuota
	}
	photo, err := q.CreatePhoto(ctx, db.CreatePhotoParams{
		AlbumID:   albumID,
		ShopID:    shop.ID,
		OrigSize:  size,
		Source:    db.PhotoSourceUpload,
		SortOrder: 0,
	})
	if err != nil {
		return db.Photo{}, fmt.Errorf("create photo: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.Photo{}, fmt.Errorf("commit tx: %w", err)
	}
	return photo, nil
}

type confirmRequest struct {
	ShopID   string   `json:"shop_id"`
	PhotoIDs []string `json:"photo_ids"`
}

type confirmResult struct {
	PhotoID string `json:"photo_id"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
}

// handleConfirmPhotos: photo uploading -> processing + задача в asynq.
func (a *API) handleConfirmPhotos(w http.ResponseWriter, r *http.Request) {
	var req confirmRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	shop, ok := a.ownedShop(w, r, req.ShopID)
	if !ok {
		return
	}
	if len(req.PhotoIDs) == 0 || len(req.PhotoIDs) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_photo_ids", "photo_ids must contain 1..200 items")
		return
	}

	results := make([]confirmResult, 0, len(req.PhotoIDs))
	for _, raw := range req.PhotoIDs {
		results = append(results, a.confirmOne(r, shop, raw))
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (a *API) confirmOne(r *http.Request, shop db.Shop, rawID string) confirmResult {
	photoID, err := uuid.Parse(rawID)
	if err != nil {
		return confirmResult{PhotoID: rawID, Status: "error", Error: "invalid photo id"}
	}
	res := confirmResult{PhotoID: rawID}

	photo, err := a.Q.GetPhotoForShop(r.Context(), db.GetPhotoForShopParams{
		ID:     photoID,
		ShopID: shop.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		res.Status, res.Error = "error", "photo not found"
		return res
	}
	if err != nil {
		a.Log.Error("confirm: load photo failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	if photo.Status != db.PhotoStatusUploading {
		// Повторный confirm — идемпотентно возвращаем текущий статус.
		res.Status = string(photo.Status)
		return res
	}

	size, exists, err := a.Store.StatSize(r.Context(), storage.OrigKey(shop.ID, photo.ID))
	if err != nil {
		a.Log.Error("confirm: stat object failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	if !exists {
		res.Status, res.Error = "error", "object not uploaded"
		return res
	}

	if _, err := a.Q.SetPhotoProcessing(r.Context(), db.SetPhotoProcessingParams{
		ID:       photo.ID,
		OrigSize: size,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			res.Status = "processing" // гонка двух confirm — уже переведено
			return res
		}
		a.Log.Error("confirm: set processing failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	// Квота: фактический размер оригинала.
	if err := a.Q.AddShopStorageUsed(r.Context(), db.AddShopStorageUsedParams{
		ID:          shop.ID,
		StorageUsed: size,
	}); err != nil {
		a.Log.Error("confirm: account storage failed", "error", err)
	}

	task, err := tasks.NewPhotoProcess(photo.ID)
	if err != nil {
		a.Log.Error("confirm: build task failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	if _, err := a.Tasks.EnqueueContext(r.Context(), task); err != nil {
		a.Log.Error("confirm: enqueue failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	res.Status = "processing"
	return res
}

func (a *API) handleListPhotos(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	shopID := shopFromCtx(r).ID
	// Страницами, как и на витрине: альбом на тарифе «Продавец» вмещает
	// до 5000 фотографий, и выдача целиком вешала кабинет на секунды.
	page := queryInt(r, "page", 1, 1, 1_000_000)
	perPage := queryInt(r, "per_page", cabinetPhotosPerPage, 1, cabinetPhotosPerPageMax)

	total, err := a.Q.CountPhotosByAlbum(r.Context(), db.CountPhotosByAlbumParams{
		AlbumID: album.ID,
		ShopID:  shopID,
	})
	if err != nil {
		a.internalError(w, "count photos", err)
		return
	}
	photos, err := a.Q.ListPhotosByAlbum(r.Context(), db.ListPhotosByAlbumParams{
		AlbumID: album.ID,
		ShopID:  shopID,
		Limit:   int32(perPage),
		Offset:  int32((page - 1) * perPage),
	})
	if err != nil {
		a.internalError(w, "list photos", err)
		return
	}
	out := make([]photoResponse, 0, len(photos))
	for _, p := range photos {
		out = append(out, a.toPhotoResponse(p))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"photos":   out,
		"page":     page,
		"per_page": perPage,
		"total":    total,
	})
}

const (
	cabinetPhotosPerPage    = 100
	cabinetPhotosPerPageMax = 500
)

type updatePhotoRequest struct {
	Caption *string `json:"caption"`
}

func (a *API) handleUpdatePhoto(w http.ResponseWriter, r *http.Request) {
	photo, shop, ok := a.ownedPhoto(w, r)
	if !ok {
		return
	}
	var req updatePhotoRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	caption := photo.Caption
	if req.Caption != nil {
		if len([]rune(*req.Caption)) > 2000 {
			apiError(w, http.StatusBadRequest, "invalid_caption", "caption must be at most 2000 characters")
			return
		}
		caption = *req.Caption
	}
	updated, err := a.Q.UpdatePhotoCaption(r.Context(), db.UpdatePhotoCaptionParams{
		ID:      photo.ID,
		ShopID:  photo.ShopID,
		Caption: caption,
	})
	if err != nil {
		a.internalError(w, "update photo", err)
		return
	}
	// Стоп-слова: флаг на ручную проверку модератором, НЕ автоблок.
	if req.Caption != nil && hasStopWord(a.Cfg.StopWords, caption) {
		if err := a.Q.SetPhotoFlagged(r.Context(), db.SetPhotoFlaggedParams{
			ID:      photo.ID,
			Flagged: true,
		}); err != nil {
			a.Log.Error("flag photo failed", "photo_id", photo.ID, "error", err)
		}
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, a.toPhotoResponse(updated))
}

func (a *API) handleDeletePhoto(w http.ResponseWriter, r *http.Request) {
	photo, shop, ok := a.ownedPhoto(w, r)
	if !ok {
		return
	}
	n, err := a.Q.DeletePhoto(r.Context(), db.DeletePhotoParams{
		ID:     photo.ID,
		ShopID: photo.ShopID,
	})
	if err != nil {
		a.internalError(w, "delete photo", err)
		return
	}
	if n == 0 {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	// Возврат квоты и снятие счётчика альбома.
	if photo.Status == db.PhotoStatusReady {
		if err := a.Q.AddAlbumPhotoCount(r.Context(), db.AddAlbumPhotoCountParams{
			ID:         photo.AlbumID,
			PhotoCount: -1,
		}); err != nil {
			a.Log.Error("delete: decrement album count failed", "error", err)
		}
	}
	if err := a.Q.AddShopStorageUsed(r.Context(), db.AddShopStorageUsedParams{
		ID:          photo.ShopID,
		StorageUsed: -(photo.OrigSize + photo.DrvSize),
	}); err != nil {
		a.Log.Error("delete: release storage failed", "error", err)
	}
	if err := a.Store.RemovePhoto(r.Context(), photo.ShopID, photo.ID, imagingmeta.DerivativeSizes); err != nil {
		a.Log.Error("delete: remove s3 objects failed", "error", err)
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

// hasStopWord — регистронезависимое вхождение стоп-слова в подпись
// (подстрока: работает и для кириллицы, и для словоформ).
func hasStopWord(words []string, caption string) bool {
	if len(words) == 0 || caption == "" {
		return false
	}
	lc := strings.ToLower(caption)
	for _, word := range words {
		if strings.Contains(lc, strings.ToLower(word)) {
			return true
		}
	}
	return false
}

// ownedShop: магазин по id из тела запроса, с проверкой владения (404 чужому).
func (a *API) ownedShop(w http.ResponseWriter, r *http.Request, rawID string) (db.Shop, bool) {
	shopID, err := uuid.Parse(rawID)
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return db.Shop{}, false
	}
	shop, err := a.Q.GetShopForOwner(r.Context(), db.GetShopForOwnerParams{
		ID:      shopID,
		OwnerID: userID(r),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return db.Shop{}, false
	}
	if err != nil {
		a.internalError(w, "load shop", err)
		return db.Shop{}, false
	}
	return shop, true
}

// ownedPhoto: фото по id из URL + проверка владения через магазин (404 чужому).
func (a *API) ownedPhoto(w http.ResponseWriter, r *http.Request) (db.Photo, db.Shop, bool) {
	photoID, err := uuid.Parse(chi.URLParam(r, "photoID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return db.Photo{}, db.Shop{}, false
	}
	photo, err := a.Q.GetPhoto(r.Context(), photoID)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return db.Photo{}, db.Shop{}, false
	}
	if err != nil {
		a.internalError(w, "load photo", err)
		return db.Photo{}, db.Shop{}, false
	}
	shop, err := a.Q.GetShopForOwner(r.Context(), db.GetShopForOwnerParams{
		ID:      photo.ShopID,
		OwnerID: userID(r),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "photo not found")
			return db.Photo{}, db.Shop{}, false
		}
		a.internalError(w, "check photo ownership", err)
		return db.Photo{}, db.Shop{}, false
	}
	return photo, shop, true
}
