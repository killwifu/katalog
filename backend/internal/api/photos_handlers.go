package api

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

// Лимиты хранилища по тарифам.
const (
	freeStorageLimit = 1 << 30  // 1 GiB
	proStorageLimit  = 20 << 30 // 20 GiB
	maxFileSize      = 50 << 20 // 50 MiB на файл
	presignTTL       = 15 * time.Minute
)

func planStorageLimit(plan db.ShopPlan) int64 {
	if plan == db.ShopPlanPro {
		return proStorageLimit
	}
	return freeStorageLimit
}

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

func toPhotoResponse(p db.Photo) photoResponse {
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
		resp.Urls = map[string]string{
			"thumb":  fmt.Sprintf("/media/%s/%s/300.webp", p.ShopID, p.ID),
			"medium": fmt.Sprintf("/media/%s/%s/800.webp", p.ShopID, p.ID),
			"large":  fmt.Sprintf("/media/%s/%s/1600.webp", p.ShopID, p.ID),
		}
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
	// Проверка квоты тарифа. При параллельных загрузках возможен небольшой
	// перебор (квота фиксируется фактическими байтами на confirm).
	if shop.StorageUsed+req.Size > planStorageLimit(shop.Plan) {
		apiError(w, http.StatusForbidden, "quota_exceeded", "storage quota exceeded for current plan")
		return
	}

	photo, err := a.Q.CreatePhoto(r.Context(), db.CreatePhotoParams{
		AlbumID:   albumID,
		ShopID:    shop.ID,
		OrigSize:  req.Size,
		Source:    db.PhotoSourceUpload,
		SortOrder: 0,
	})
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
	photos, err := a.Q.ListPhotosByAlbum(r.Context(), db.ListPhotosByAlbumParams{
		AlbumID: album.ID,
		ShopID:  shopFromCtx(r).ID,
	})
	if err != nil {
		a.internalError(w, "list photos", err)
		return
	}
	out := make([]photoResponse, 0, len(photos))
	for _, p := range photos {
		out = append(out, toPhotoResponse(p))
	}
	writeJSON(w, http.StatusOK, out)
}

type updatePhotoRequest struct {
	Caption *string `json:"caption"`
}

func (a *API) handleUpdatePhoto(w http.ResponseWriter, r *http.Request) {
	photo, ok := a.ownedPhoto(w, r)
	if !ok {
		return
	}
	var req updatePhotoRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	caption := photo.Caption
	if req.Caption != nil {
		if len(*req.Caption) > 2000 {
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
	writeJSON(w, http.StatusOK, toPhotoResponse(updated))
}

func (a *API) handleDeletePhoto(w http.ResponseWriter, r *http.Request) {
	photo, ok := a.ownedPhoto(w, r)
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
		StorageUsed: -photo.OrigSize,
	}); err != nil {
		a.Log.Error("delete: release storage failed", "error", err)
	}
	if err := a.Store.RemovePhoto(r.Context(), photo.ShopID, photo.ID, imagingmeta.DerivativeSizes); err != nil {
		a.Log.Error("delete: remove s3 objects failed", "error", err)
	}
	w.WriteHeader(http.StatusNoContent)
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
func (a *API) ownedPhoto(w http.ResponseWriter, r *http.Request) (db.Photo, bool) {
	photoID, err := uuid.Parse(chi.URLParam(r, "photoID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return db.Photo{}, false
	}
	photo, err := a.Q.GetPhoto(r.Context(), photoID)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return db.Photo{}, false
	}
	if err != nil {
		a.internalError(w, "load photo", err)
		return db.Photo{}, false
	}
	if _, err := a.Q.GetShopForOwner(r.Context(), db.GetShopForOwnerParams{
		ID:      photo.ShopID,
		OwnerID: userID(r),
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "photo not found")
			return db.Photo{}, false
		}
		a.internalError(w, "check photo ownership", err)
		return db.Photo{}, false
	}
	return photo, true
}
