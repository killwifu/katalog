package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imagingmeta"
)

// Корзина. Удаление фотографии перестало быть необратимым: промах по
// крестику на плитке стоил продавцу снимка навсегда, потому что объект
// уходил из S3 в том же запросе.
//
// Помеченная фотография пропадает из кабинета и с витрины, но продолжает
// занимать место в хранилище — файлы на месте, и возвращать квоту было бы
// враньём. Освобождает её либо окончательное удаление, либо ночная уборка
// по сроку хранения.

const trashPerPage = 60

type trashResponse struct {
	Photos   []photoResponse `json:"photos"`
	Total    int64           `json:"total"`
	Page     int             `json:"page"`
	PerPage  int             `json:"per_page"`
	KeepDays int64           `json:"keep_days"`
}

func (a *API) handleListTrash(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	page := 1
	if v, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && v > 1 {
		page = v
	}
	rows, err := a.Q.ListDeletedPhotos(r.Context(), db.ListDeletedPhotosParams{
		ShopID: shop.ID,
		Limit:  trashPerPage,
		Offset: int32((page - 1) * trashPerPage),
	})
	if err != nil {
		a.internalError(w, "list trash", err)
		return
	}
	total, err := a.Q.CountDeletedPhotos(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "count trash", err)
		return
	}
	out := make([]photoResponse, 0, len(rows))
	for _, p := range rows {
		out = append(out, a.toPhotoResponse(p))
	}
	writeJSON(w, http.StatusOK, trashResponse{
		Photos:   out,
		Total:    total,
		Page:     page,
		PerPage:  trashPerPage,
		KeepDays: a.Cfg.TrashKeepDays,
	})
}

func (a *API) handleRestorePhoto(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	photoID, err := uuid.Parse(chi.URLParam(r, "photoID"))
	if err != nil {
		apiError(w, http.StatusBadRequest, "invalid_id", "invalid photo id")
		return
	}
	photo, err := a.Q.RestorePhoto(r.Context(), db.RestorePhotoParams{ID: photoID, ShopID: shop.ID})
	if err != nil {
		// Нет строки — либо чужое фото, либо оно не в корзине. Наружу
		// в обоих случаях 404: существование чужих id не подтверждаем.
		apiError(w, http.StatusNotFound, "not_found", "photo not found in trash")
		return
	}
	// Счётчик альбома снимался при пометке — возвращаем его обратно.
	if photo.Status == db.PhotoStatusReady {
		if err := a.Q.AddAlbumPhotoCount(r.Context(), db.AddAlbumPhotoCountParams{
			ID:         photo.AlbumID,
			PhotoCount: 1,
		}); err != nil {
			a.Log.Error("restore: increment album count failed", "error", err)
		}
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, a.toPhotoResponse(photo))
}

func (a *API) handlePurgePhoto(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	photoID, err := uuid.Parse(chi.URLParam(r, "photoID"))
	if err != nil {
		apiError(w, http.StatusBadRequest, "invalid_id", "invalid photo id")
		return
	}
	row, err := a.Q.PurgePhoto(r.Context(), db.PurgePhotoParams{ID: photoID, ShopID: shop.ID})
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "photo not found in trash")
		return
	}
	a.releasePhotoBytes(r, shop.ID, []uuid.UUID{row.ID}, row.Bytes)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleEmptyTrash(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	rows, err := a.Q.PurgeShopTrash(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "empty trash", err)
		return
	}
	ids := make([]uuid.UUID, 0, len(rows))
	var bytes int64
	for _, row := range rows {
		ids = append(ids, row.ID)
		bytes += row.Bytes
	}
	a.releasePhotoBytes(r, shop.ID, ids, bytes)
	w.WriteHeader(http.StatusNoContent)
}

// releasePhotoBytes возвращает место в квоту и убирает объекты из S3.
// Порядок важен: сначала квота, потом S3 — если уборка объектов упадёт,
// продавец хотя бы не останется с занятым местом за несуществующие фото.
func (a *API) releasePhotoBytes(r *http.Request, shopID uuid.UUID, ids []uuid.UUID, bytes int64) {
	if len(ids) == 0 {
		return
	}
	if err := a.Q.AddShopStorageUsed(r.Context(), db.AddShopStorageUsedParams{
		ID:          shopID,
		StorageUsed: -bytes,
	}); err != nil {
		a.Log.Error("purge: release storage failed", "error", err)
	}
	for _, id := range ids {
		if err := a.Store.RemovePhoto(r.Context(), shopID, id, imagingmeta.DerivativeSizes()); err != nil {
			a.Log.Error("purge: remove s3 objects failed", "error", err, "photo", id)
		}
	}
}
