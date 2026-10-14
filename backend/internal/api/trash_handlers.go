package api

import (
	"net/http"
	"time"

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

// trashAlbumResponse — удалённый альбом в корзине: одной строкой вместе
// со всеми своими фотографиями.
type trashAlbumResponse struct {
	ID         string            `json:"id"`
	Title      string            `json:"title"`
	PhotoCount int32             `json:"photo_count"`
	DeletedAt  string            `json:"deleted_at"`
	CoverUrls  map[string]string `json:"cover_urls,omitempty"`
}

type trashResponse struct {
	// Albums отдаются целиком и только на первой странице: их единицы,
	// а листают в корзине фотографии.
	Albums   []trashAlbumResponse `json:"albums"`
	Photos   []photoResponse      `json:"photos"`
	Total    int64                `json:"total"`
	Page     int                  `json:"page"`
	PerPage  int                  `json:"per_page"`
	KeepDays int64                `json:"keep_days"`
}

func (a *API) handleListTrash(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	// Потолок как у остальных списков: без него огромный page переполнял
	// int32-смещение и запрос падал с 500.
	page := queryInt(r, "page", 1, 1, 1_000_000)
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
	albums := []trashAlbumResponse{}
	if page == 1 {
		deleted, err := a.Q.ListDeletedAlbums(r.Context(), shop.ID)
		if err != nil {
			a.internalError(w, "list deleted albums", err)
			return
		}
		for _, al := range deleted {
			item := trashAlbumResponse{ID: al.ID.String(), Title: al.Title, PhotoCount: al.PhotoCount}
			if al.DeletedAt.Valid {
				item.DeletedAt = al.DeletedAt.Time.Format(time.RFC3339)
			}
			if al.CoverPhotoID.Valid {
				item.CoverUrls = a.mediaURLs(shop.ID, al.CoverPhotoID.UUID)
			} else if first, err := a.Q.FirstAlbumPhotoAny(r.Context(), al.ID); err == nil {
				// Продавец узнаёт альбом по картинке, а не по названию.
				item.CoverUrls = a.mediaURLs(shop.ID, first)
			}
			albums = append(albums, item)
		}
	}
	writeJSON(w, http.StatusOK, trashResponse{
		Albums:   albums,
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
	if err := a.recountAlbumPhotos(r.Context(), photo.AlbumID); err != nil {
		a.Log.Error("restore: recount album photos failed", "error", err)
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

// handleRestoreAlbum возвращает альбом из корзины вместе с подальбомами и
// фотографиями, которые уехали вместе с ним. Фото, удалённые раньше по
// отдельности, остаются в корзине: их продавец убирал сознательно.
func (a *API) handleRestoreAlbum(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	album, ok := a.deletedAlbumFromURL(w, r)
	if !ok {
		return
	}
	tx, err := a.Pool.Begin(r.Context())
	if err != nil {
		a.internalError(w, "restore album: begin", err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := a.Q.WithTx(tx)
	if _, err := q.RestoreAlbumTreePhotos(r.Context(), db.RestoreAlbumTreePhotosParams{
		ID: album.ID, ShopID: shop.ID, DeletedAt: album.DeletedAt,
	}); err != nil {
		a.internalError(w, "restore album photos", err)
		return
	}
	if _, err := q.RestoreAlbumTree(r.Context(), db.RestoreAlbumTreeParams{
		ID: album.ID, ShopID: shop.ID, DeletedAt: album.DeletedAt,
	}); err != nil {
		a.internalError(w, "restore album", err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		a.internalError(w, "restore album: commit", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	restored, err := a.Q.GetAlbumForShop(r.Context(), db.GetAlbumForShopParams{ID: album.ID, ShopID: shop.ID})
	if err != nil {
		a.internalError(w, "load restored album", err)
		return
	}
	writeJSON(w, http.StatusOK, a.toAlbumResponse(restored))
}

// handlePurgeAlbum — окончательное удаление альбома из корзины: строки,
// объекты в S3 и место в квоте.
func (a *API) handlePurgeAlbum(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	album, ok := a.deletedAlbumFromURL(w, r)
	if !ok {
		return
	}
	// Каскад снесёт фото и подальбомы, но ни квоту, ни S3 не вернёт —
	// список собираем до удаления.
	doomed, err := a.Q.ListAlbumTreePhotos(r.Context(), album.ID)
	if err != nil {
		a.internalError(w, "list album photos", err)
		return
	}
	if _, err := a.Q.DeleteAlbum(r.Context(), db.DeleteAlbumParams{ID: album.ID, ShopID: shop.ID}); err != nil {
		a.internalError(w, "purge album", err)
		return
	}
	ids := make([]uuid.UUID, 0, len(doomed))
	var bytes int64
	for _, ph := range doomed {
		ids = append(ids, ph.ID)
		bytes += ph.Bytes
	}
	a.releasePhotoBytes(r, shop.ID, ids, bytes)
	w.WriteHeader(http.StatusNoContent)
}

// deletedAlbumFromURL: альбом из корзины по id в адресе. Чужой или не
// удалённый — 404: существование чужих id не подтверждаем.
func (a *API) deletedAlbumFromURL(w http.ResponseWriter, r *http.Request) (db.Album, bool) {
	albumID, err := uuid.Parse(chi.URLParam(r, "albumID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found in trash")
		return db.Album{}, false
	}
	album, err := a.Q.GetDeletedAlbumForShop(r.Context(), db.GetDeletedAlbumForShopParams{
		ID: albumID, ShopID: shopFromCtx(r).ID,
	})
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found in trash")
		return db.Album{}, false
	}
	return album, true
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
	// Фотографии удалённых альбомов ушли запросом выше — остались сами
	// альбомы.
	if _, err := a.Q.PurgeDeletedAlbums(r.Context(), shop.ID); err != nil {
		a.Log.Error("empty trash: purge albums failed", "error", err)
	}
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
