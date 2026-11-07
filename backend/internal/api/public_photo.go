package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
)

func (a *API) handlePublicPhoto(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	albumID, err := uuid.Parse(chi.URLParam(r, "albumID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	photoID, err := uuid.Parse(chi.URLParam(r, "photoID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	album, err := a.Q.GetPublicAlbum(r.Context(), db.GetPublicAlbumParams{
		ID: uuid.NullUUID{UUID: albumID, Valid: true}, ShopID: shop.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	if err != nil {
		a.internalError(w, "load public album", err)
		return
	}
	lock, err := a.albumLock(r.Context(), album)
	if err != nil {
		a.internalError(w, "album lock", err)
		return
	}
	if lock.PasswordHash != nil {
		w.Header().Set("Cache-Control", "private, no-store")
		if !a.albumUnlocked(r, lock) {
			apiError(w, http.StatusNotFound, "not_found", "photo not found")
			return
		}
	}
	photo, err := a.Q.GetPublicPhoto(r.Context(), db.GetPublicPhotoParams{ID: photoID, AlbumID: album.ID, ShopID: shop.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	if err != nil {
		a.internalError(w, "load public photo", err)
		return
	}
	writeJSON(w, http.StatusOK, a.toPublicPhotoResponse(photo, shop.MediaRev))
}
