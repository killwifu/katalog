package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
)

type albumResponse struct {
	ID           string  `json:"id"`
	ParentID     *string `json:"parent_id"`
	Title        string  `json:"title"`
	CoverPhotoID *string `json:"cover_photo_id"`
	SortOrder    int32   `json:"sort_order"`
	IsHidden     bool    `json:"is_hidden"`
	PhotoCount   int32   `json:"photo_count"`
}

func toAlbumResponse(al db.Album) albumResponse {
	resp := albumResponse{
		ID:         al.ID.String(),
		Title:      al.Title,
		SortOrder:  al.SortOrder,
		IsHidden:   al.IsHidden,
		PhotoCount: al.PhotoCount,
	}
	if al.ParentID.Valid {
		s := al.ParentID.UUID.String()
		resp.ParentID = &s
	}
	if al.CoverPhotoID.Valid {
		s := al.CoverPhotoID.UUID.String()
		resp.CoverPhotoID = &s
	}
	return resp
}

// albumFromURL загружает альбом с проверкой принадлежности магазину
// (магазин уже проверен requireShop). Чужой альбом — 404.
func (a *API) albumFromURL(w http.ResponseWriter, r *http.Request) (db.Album, bool) {
	albumID, err := uuid.Parse(chi.URLParam(r, "albumID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return db.Album{}, false
	}
	album, err := a.Q.GetAlbumForShop(r.Context(), db.GetAlbumForShopParams{
		ID:     albumID,
		ShopID: shopFromCtx(r).ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return db.Album{}, false
	}
	if err != nil {
		a.internalError(w, "load album", err)
		return db.Album{}, false
	}
	return album, true
}

type createAlbumRequest struct {
	Title     string  `json:"title"`
	ParentID  *string `json:"parent_id"`
	SortOrder int32   `json:"sort_order"`
}

func (a *API) handleCreateAlbum(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req createAlbumRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len(req.Title) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-200 characters")
		return
	}

	var parentID uuid.NullUUID
	if req.ParentID != nil {
		pid, err := uuid.Parse(*req.ParentID)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_parent", "invalid parent_id")
			return
		}
		parent, err := a.Q.GetAlbumForShop(r.Context(), db.GetAlbumForShopParams{
			ID:     pid,
			ShopID: shop.ID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "parent album not found")
			return
		}
		if err != nil {
			a.internalError(w, "load parent album", err)
			return
		}
		// Максимум 2 уровня: родитель сам не может быть вложенным.
		if parent.ParentID.Valid {
			apiError(w, http.StatusBadRequest, "too_deep", "albums can be nested at most 2 levels")
			return
		}
		parentID = uuid.NullUUID{UUID: pid, Valid: true}
	}

	album, err := a.Q.CreateAlbum(r.Context(), db.CreateAlbumParams{
		ShopID:    shop.ID,
		ParentID:  parentID,
		Title:     req.Title,
		SortOrder: req.SortOrder,
	})
	if err != nil {
		a.internalError(w, "create album", err)
		return
	}
	writeJSON(w, http.StatusCreated, toAlbumResponse(album))
}

func (a *API) handleListAlbums(w http.ResponseWriter, r *http.Request) {
	albums, err := a.Q.ListAlbumsByShop(r.Context(), shopFromCtx(r).ID)
	if err != nil {
		a.internalError(w, "list albums", err)
		return
	}
	out := make([]albumResponse, 0, len(albums))
	for _, al := range albums {
		out = append(out, toAlbumResponse(al))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleGetAlbum(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, toAlbumResponse(album))
}

type updateAlbumRequest struct {
	Title        *string `json:"title"`
	SortOrder    *int32  `json:"sort_order"`
	IsHidden     *bool   `json:"is_hidden"`
	CoverPhotoID *string `json:"cover_photo_id"`
}

func (a *API) handleUpdateAlbum(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	var req updateAlbumRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	title, sortOrder, isHidden, cover := album.Title, album.SortOrder, album.IsHidden, album.CoverPhotoID
	if req.Title != nil {
		title = strings.TrimSpace(*req.Title)
		if title == "" || len(title) > 200 {
			apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-200 characters")
			return
		}
	}
	if req.SortOrder != nil {
		sortOrder = *req.SortOrder
	}
	if req.IsHidden != nil {
		isHidden = *req.IsHidden
	}
	if req.CoverPhotoID != nil {
		if *req.CoverPhotoID == "" {
			cover = uuid.NullUUID{}
		} else {
			pid, err := uuid.Parse(*req.CoverPhotoID)
			if err != nil {
				apiError(w, http.StatusBadRequest, "invalid_cover", "invalid cover_photo_id")
				return
			}
			photo, err := a.Q.GetPhotoForShop(r.Context(), db.GetPhotoForShopParams{
				ID:     pid,
				ShopID: shop.ID,
			})
			if errors.Is(err, pgx.ErrNoRows) {
				apiError(w, http.StatusNotFound, "not_found", "cover photo not found")
				return
			}
			if err != nil {
				a.internalError(w, "load cover photo", err)
				return
			}
			if photo.AlbumID != album.ID {
				apiError(w, http.StatusBadRequest, "invalid_cover", "cover photo must belong to this album")
				return
			}
			cover = uuid.NullUUID{UUID: pid, Valid: true}
		}
	}

	updated, err := a.Q.UpdateAlbum(r.Context(), db.UpdateAlbumParams{
		ID:           album.ID,
		ShopID:       shop.ID,
		Title:        title,
		SortOrder:    sortOrder,
		IsHidden:     isHidden,
		CoverPhotoID: cover,
	})
	if err != nil {
		a.internalError(w, "update album", err)
		return
	}
	writeJSON(w, http.StatusOK, toAlbumResponse(updated))
}

func (a *API) handleDeleteAlbum(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	n, err := a.Q.DeleteAlbum(r.Context(), db.DeleteAlbumParams{
		ID:     album.ID,
		ShopID: shopFromCtx(r).ID,
	})
	if err != nil {
		a.internalError(w, "delete album", err)
		return
	}
	if n == 0 {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
