package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"katalog/backend/internal/db"
)

// parseUUIDParam — id из URL. Невалидный id для приватного ресурса это 404,
// а не 400: чужой/несуществующий ресурс не должен различаться снаружи.
func parseUUIDParam(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "not found")
		return uuid.UUID{}, false
	}
	return id, true
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

type categoryResponse struct {
	ID        string  `json:"id"`
	ParentID  *string `json:"parent_id"`
	Title     string  `json:"title"`
	Slug      string  `json:"slug"`
	SortOrder int32   `json:"sort_order"`
}

func toCategoryResponse(c db.Category) categoryResponse {
	out := categoryResponse{
		ID:        c.ID.String(),
		Title:     c.Title,
		Slug:      c.Slug,
		SortOrder: c.SortOrder,
	}
	if c.ParentID.Valid {
		id := c.ParentID.UUID.String()
		out.ParentID = &id
	}
	return out
}

type categoryRequest struct {
	Title     string  `json:"title"`
	Slug      string  `json:"slug"`
	ParentID  *string `json:"parent_id"`
	SortOrder int32   `json:"sort_order"`
}

// validateCategory разбирает и проверяет общее для создания и обновления.
func validateCategory(w http.ResponseWriter, req *categoryRequest) bool {
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len(req.Title) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-200 characters")
		return false
	}
	req.Slug = strings.ToLower(strings.TrimSpace(req.Slug))
	// Тот же формат, что у slug магазина. Список зарезервированных слов не
	// применяем: категория живёт внутри /{shop}/c/..., с системными
	// страницами не пересекается.
	if !slugPattern.MatchString(req.Slug) {
		apiError(w, http.StatusBadRequest, "invalid_slug", "slug must be 3-64 chars: a-z, 0-9, single dashes")
		return false
	}
	return true
}

func (a *API) handleCreateCategory(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req categoryRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validateCategory(w, &req) {
		return
	}

	var parentID uuid.NullUUID
	if req.ParentID != nil && *req.ParentID != "" {
		pid, err := uuid.Parse(*req.ParentID)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_parent", "invalid parent_id")
			return
		}
		parent, err := a.Q.GetCategoryForShop(r.Context(), db.GetCategoryForShopParams{
			ID:     pid,
			ShopID: shop.ID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "parent category not found")
			return
		}
		if err != nil {
			a.internalError(w, "load parent category", err)
			return
		}
		// Максимум 2 уровня — как у альбомов: родитель сам не может быть вложенным.
		if parent.ParentID.Valid {
			apiError(w, http.StatusBadRequest, "too_deep", "categories can be nested at most 2 levels")
			return
		}
		parentID = uuid.NullUUID{UUID: pid, Valid: true}
	}

	cat, err := a.Q.CreateCategory(r.Context(), db.CreateCategoryParams{
		ShopID:    shop.ID,
		ParentID:  parentID,
		Title:     req.Title,
		Slug:      req.Slug,
		SortOrder: req.SortOrder,
	})
	if err != nil {
		if isUniqueViolation(err) {
			apiError(w, http.StatusConflict, "slug_taken", "category slug already used in this shop")
			return
		}
		a.internalError(w, "create category", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusCreated, toCategoryResponse(cat))
}

func (a *API) handleListCategories(w http.ResponseWriter, r *http.Request) {
	cats, err := a.Q.ListCategoriesByShop(r.Context(), shopFromCtx(r).ID)
	if err != nil {
		a.internalError(w, "list categories", err)
		return
	}
	out := make([]categoryResponse, 0, len(cats))
	for _, c := range cats {
		out = append(out, toCategoryResponse(c))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleUpdateCategory(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	id, ok := parseUUIDParam(w, r, "categoryID")
	if !ok {
		return
	}
	var req categoryRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validateCategory(w, &req) {
		return
	}
	cat, err := a.Q.UpdateCategory(r.Context(), db.UpdateCategoryParams{
		ID:        id,
		ShopID:    shop.ID,
		Title:     req.Title,
		Slug:      req.Slug,
		SortOrder: req.SortOrder,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "category not found")
		return
	}
	if err != nil {
		if isUniqueViolation(err) {
			apiError(w, http.StatusConflict, "slug_taken", "category slug already used in this shop")
			return
		}
		a.internalError(w, "update category", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, toCategoryResponse(cat))
}

// handleDeleteCategory: альбомы не удаляются вместе с категорией. Куда их
// девать, решает продавец — ?move_to=<id> переносит, пустой параметр
// оставляет без категории (kit: «Просто удалять нельзя»).
func (a *API) handleDeleteCategory(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	id, ok := parseUUIDParam(w, r, "categoryID")
	if !ok {
		return
	}

	var moveTo uuid.NullUUID
	if raw := r.URL.Query().Get("move_to"); raw != "" {
		target, err := uuid.Parse(raw)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_move_to", "invalid move_to")
			return
		}
		if target == id {
			apiError(w, http.StatusBadRequest, "invalid_move_to", "cannot move albums into the category being deleted")
			return
		}
		if _, err := a.Q.GetCategoryForShop(r.Context(), db.GetCategoryForShopParams{
			ID:     target,
			ShopID: shop.ID,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				apiError(w, http.StatusNotFound, "not_found", "target category not found")
				return
			}
			a.internalError(w, "load target category", err)
			return
		}
		moveTo = uuid.NullUUID{UUID: target, Valid: true}
	}

	// Перенос до удаления: ON DELETE SET NULL иначе обнулит категорию сам.
	if err := a.Q.MoveAlbumsToCategory(r.Context(), db.MoveAlbumsToCategoryParams{
		ShopID:       shop.ID,
		CategoryID:   uuid.NullUUID{UUID: id, Valid: true},
		CategoryID_2: moveTo,
	}); err != nil {
		a.internalError(w, "move albums", err)
		return
	}

	rows, err := a.Q.DeleteCategory(r.Context(), db.DeleteCategoryParams{ID: id, ShopID: shop.ID})
	if err != nil {
		a.internalError(w, "delete category", err)
		return
	}
	if rows == 0 {
		apiError(w, http.StatusNotFound, "not_found", "category not found")
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

// handleSetAlbumCategory — отдельный эндпоинт, чтобы не расширять
// PATCH /albums/{id}: категория меняется из другого экрана кабинета.
func (a *API) handleSetAlbumCategory(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	albumID, ok := parseUUIDParam(w, r, "albumID")
	if !ok {
		return
	}
	var req struct {
		CategoryID *string `json:"category_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	var catID uuid.NullUUID
	if req.CategoryID != nil && *req.CategoryID != "" {
		cid, err := uuid.Parse(*req.CategoryID)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_category", "invalid category_id")
			return
		}
		if _, err := a.Q.GetCategoryForShop(r.Context(), db.GetCategoryForShopParams{
			ID:     cid,
			ShopID: shop.ID,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				apiError(w, http.StatusNotFound, "not_found", "category not found")
				return
			}
			a.internalError(w, "load category", err)
			return
		}
		catID = uuid.NullUUID{UUID: cid, Valid: true}
	}

	album, err := a.Q.SetAlbumCategory(r.Context(), db.SetAlbumCategoryParams{
		ID:         albumID,
		ShopID:     shop.ID,
		CategoryID: catID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	if err != nil {
		a.internalError(w, "set album category", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, toAlbumResponse(album))
}
