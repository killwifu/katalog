package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

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
	// IsHidden — скрыта с витрины; OnHome — показывается блоком на главной.
	IsHidden bool `json:"is_hidden"`
	OnHome   bool `json:"on_home"`
}

func toCategoryResponse(c db.Category) categoryResponse {
	out := categoryResponse{
		ID:        c.ID.String(),
		Title:     c.Title,
		Slug:      c.Slug,
		SortOrder: c.SortOrder,
		IsHidden:  c.IsHidden,
		OnHome:    c.OnHome,
	}
	if c.ParentID.Valid {
		id := c.ParentID.UUID.String()
		out.ParentID = &id
	}
	return out
}

// handleSetCategoryVisibility — «Скрыть с витрины» и «На главной» из меню
// категории. Отдельно от переименования: это переключатели в один тап, и
// тащить ради них название со слагом клиенту незачем.
func (a *API) handleSetCategoryVisibility(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	id, ok := parseUUIDParam(w, r, "categoryID")
	if !ok {
		return
	}
	current, err := a.Q.GetCategoryForShop(r.Context(), db.GetCategoryForShopParams{ID: id, ShopID: shop.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "category not found")
		return
	}
	if err != nil {
		a.internalError(w, "load category", err)
		return
	}
	var req struct {
		IsHidden *bool `json:"is_hidden"`
		OnHome   *bool `json:"on_home"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	hidden, onHome := current.IsHidden, current.OnHome
	if req.IsHidden != nil {
		hidden = *req.IsHidden
	}
	if req.OnHome != nil {
		onHome = *req.OnHome
	}
	updated, err := a.Q.SetCategoryVisibility(r.Context(), db.SetCategoryVisibilityParams{
		ID: id, ShopID: shop.ID, IsHidden: hidden, OnHome: onHome,
	})
	if err != nil {
		a.internalError(w, "set category visibility", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, toCategoryResponse(updated))
}

type categoryRequest struct {
	Title    string  `json:"title"`
	Slug     string  `json:"slug"`
	ParentID *string `json:"parent_id"`
	// SortOrder не передан — при создании категория встаёт в конец уровня,
	// при правке остаётся на своём месте.
	SortOrder *int32 `json:"sort_order"`
}

// validateCategory разбирает и проверяет общее для создания и обновления.
func validateCategory(w http.ResponseWriter, req *categoryRequest) bool {
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len([]rune(req.Title)) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-200 characters")
		return false
	}
	req.Slug = strings.ToLower(strings.TrimSpace(req.Slug))
	// Тот же формат, что у slug магазина. Список зарезервированных слов не
	// применяем: категория живёт внутри /{shop}/c/..., с системными
	// страницами не пересекается.
	if !slugPattern.MatchString(req.Slug) {
		apiError(w, http.StatusBadRequest, "invalid_slug", "slug must be 3-63 chars: a-z, 0-9, single dashes")
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

	parentID, ok := a.resolveCategoryParent(w, r, req.ParentID, uuid.Nil)
	if !ok {
		return
	}

	var cat db.Category
	err := a.inOrderLock(r.Context(), shop.ID, func(q *db.Queries) error {
		var err error
		cat, err = q.CreateCategory(r.Context(), db.CreateCategoryParams{
			ShopID:    shop.ID,
			ParentID:  parentID,
			Title:     req.Title,
			Slug:      req.Slug,
			SortOrder: derefInt32(req.SortOrder),
		})
		return err
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

// resolveCategoryParent разбирает parent_id из запроса. self — id категории,
// которую правим (uuid.Nil при создании): она не может стать ни собственным
// родителем, ни, будучи родителем сама, уехать на второй уровень — иначе
// её дети окажутся на третьем.
func (a *API) resolveCategoryParent(
	w http.ResponseWriter, r *http.Request, raw *string, self uuid.UUID,
) (uuid.NullUUID, bool) {
	if raw == nil || *raw == "" {
		return uuid.NullUUID{}, true
	}
	shop := shopFromCtx(r)
	pid, err := uuid.Parse(*raw)
	if err != nil {
		apiError(w, http.StatusBadRequest, "invalid_parent", "invalid parent_id")
		return uuid.NullUUID{}, false
	}
	if self != uuid.Nil && pid == self {
		apiError(w, http.StatusBadRequest, "invalid_parent", "category cannot be its own parent")
		return uuid.NullUUID{}, false
	}
	parent, err := a.Q.GetCategoryForShop(r.Context(), db.GetCategoryForShopParams{
		ID:     pid,
		ShopID: shop.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "parent category not found")
		return uuid.NullUUID{}, false
	}
	if err != nil {
		a.internalError(w, "load parent category", err)
		return uuid.NullUUID{}, false
	}
	// Максимум 2 уровня — как у альбомов: родитель сам не может быть вложенным.
	if parent.ParentID.Valid {
		apiError(w, http.StatusBadRequest, "too_deep", "categories can be nested at most 2 levels")
		return uuid.NullUUID{}, false
	}
	if self != uuid.Nil {
		children, err := a.Q.CountCategoryChildren(r.Context(), uuid.NullUUID{UUID: self, Valid: true})
		if err != nil {
			a.internalError(w, "count category children", err)
			return uuid.NullUUID{}, false
		}
		if children > 0 {
			apiError(w, http.StatusBadRequest, "too_deep",
				"category has subcategories and cannot itself be nested")
			return uuid.NullUUID{}, false
		}
	}
	return uuid.NullUUID{UUID: pid, Valid: true}, true
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
	parentID, ok := a.resolveCategoryParent(w, r, req.ParentID, id)
	if !ok {
		return
	}
	cat, err := a.Q.UpdateCategory(r.Context(), db.UpdateCategoryParams{
		ID:        id,
		ShopID:    shop.ID,
		Title:     req.Title,
		Slug:      req.Slug,
		SortOrder: optInt4(req.SortOrder),
		ParentID:  parentID,
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
		targetCat, err := a.Q.GetCategoryForShop(r.Context(), db.GetCategoryForShopParams{
			ID:     target,
			ShopID: shop.ID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				apiError(w, http.StatusNotFound, "not_found", "target category not found")
				return
			}
			a.internalError(w, "load target category", err)
			return
		}
		// Подкатегории удаляются вместе с родителем (каскад): перенос в свою же
		// подкатегорию молча оставлял альбомы без категории при ответе 204.
		if targetCat.ParentID.Valid && targetCat.ParentID.UUID == id {
			apiError(w, http.StatusBadRequest, "invalid_move_to", "cannot move albums into a subcategory of the category being deleted")
			return
		}
		moveTo = uuid.NullUUID{UUID: target, Valid: true}
	}

	// Перенос до удаления: каскад по внешнему ключу снесёт связи альбомов
	// с удаляемой категорией, и переносить станет нечего.
	if moveTo.Valid {
		if err := a.Q.MoveAlbumsToCategory(r.Context(), db.MoveAlbumsToCategoryParams{
			ShopID: shop.ID,
			Source: id,
			Target: moveTo.UUID,
		}); err != nil {
			a.internalError(w, "move albums", err)
			return
		}
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
	a.syncPrimaryCategories(r, shop.ID)
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

// syncPrimaryCategories выравнивает albums.category_id («первая категория»)
// по таблице связей после любой правки состава категорий.
func (a *API) syncPrimaryCategories(r *http.Request, shopID uuid.UUID) {
	if err := a.Q.SyncShopPrimaryCategories(r.Context(), shopID); err != nil {
		a.Log.Error("sync primary categories failed", "shop_id", shopID, "error", err)
	}
}

// handleAddAlbumToCategory кладёт альбом ещё в одну категорию — в остальных
// он остаётся (макет 14: «Добавить альбомы»).
func (a *API) handleAddAlbumToCategory(w http.ResponseWriter, r *http.Request) {
	a.changeAlbumCategory(w, r, true)
}

// handleRemoveAlbumFromCategory убирает альбом из одной категории; сам
// альбом и его место в других категориях не трогаются.
func (a *API) handleRemoveAlbumFromCategory(w http.ResponseWriter, r *http.Request) {
	a.changeAlbumCategory(w, r, false)
}

// addAlbumCategory кладёт альбом в конец категории. Место — max+1 по
// категории; кабинет добавляет пачку альбомов параллельными запросами, и без
// замка на строку категории они получали одно и то же место — порядок
// внутри категории становился случайным.
func (a *API) addAlbumCategory(ctx context.Context, p db.AddAlbumCategoryParams) (int64, error) {
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("add album category: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := a.Q.WithTx(tx)
	if err := q.LockCategoryForShop(ctx, db.LockCategoryForShopParams{ID: p.CategoryID, ShopID: p.ShopID}); err != nil {
		return 0, fmt.Errorf("add album category: lock: %w", err)
	}
	n, err := q.AddAlbumCategory(ctx, p)
	if err != nil {
		return 0, fmt.Errorf("add album category: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("add album category: commit: %w", err)
	}
	return n, nil
}

func (a *API) changeAlbumCategory(w http.ResponseWriter, r *http.Request, add bool) {
	shop := shopFromCtx(r)
	categoryID, ok := parseUUIDParam(w, r, "categoryID")
	if !ok {
		return
	}
	albumID, ok := parseUUIDParam(w, r, "albumID")
	if !ok {
		return
	}
	var (
		n   int64
		err error
	)
	if add {
		// Запрос сам проверяет, что и альбом, и категория — этого магазина:
		// чужая пара не вставит ни строки.
		n, err = a.addAlbumCategory(r.Context(), db.AddAlbumCategoryParams{
			AlbumID: albumID, ShopID: shop.ID, CategoryID: categoryID,
		})
		if err == nil && n == 0 {
			// Ноль строк — либо пара уже есть, либо что-то из двух чужое.
			// Различаем, чтобы повторное добавление не выглядело ошибкой.
			if _, cerr := a.Q.GetCategoryForShop(r.Context(), db.GetCategoryForShopParams{ID: categoryID, ShopID: shop.ID}); cerr != nil {
				apiError(w, http.StatusNotFound, "not_found", "category not found")
				return
			}
			if _, aerr := a.Q.GetAlbumForShop(r.Context(), db.GetAlbumForShopParams{ID: albumID, ShopID: shop.ID}); aerr != nil {
				apiError(w, http.StatusNotFound, "not_found", "album not found")
				return
			}
		}
	} else {
		n, err = a.Q.RemoveAlbumCategory(r.Context(), db.RemoveAlbumCategoryParams{
			AlbumID: albumID, ShopID: shop.ID, CategoryID: categoryID,
		})
		if err == nil && n == 0 {
			apiError(w, http.StatusNotFound, "not_found", "album is not in this category")
			return
		}
	}
	if err != nil {
		a.internalError(w, "change album category", err)
		return
	}
	a.syncPrimaryCategories(r, shop.ID)
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
	// «Задать категорию» — ровно одна (или ни одной): прежние связи
	// снимаются. Добавить альбом ещё в одну категорию — отдельный эндпоинт.
	if err := a.Q.ClearAlbumCategories(r.Context(), db.ClearAlbumCategoriesParams{AlbumID: albumID, ShopID: shop.ID}); err != nil {
		a.internalError(w, "clear album categories", err)
		return
	}
	resp := a.toAlbumResponse(album)
	if catID.Valid {
		if _, err := a.addAlbumCategory(r.Context(), db.AddAlbumCategoryParams{
			AlbumID: albumID, ShopID: shop.ID, CategoryID: catID.UUID,
		}); err != nil {
			a.internalError(w, "add album category", err)
			return
		}
		resp.CategoryIDs = []string{catID.UUID.String()}
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, resp)
}

// maxCategoryAlbumOrder — сколько альбомов можно переставить одним запросом.
const maxCategoryAlbumOrder = 1000

// handleSetCategoryAlbumOrder — порядок альбомов внутри категории (макет 14:
// перетаскивание карточки). В этом же порядке альбомы стоят на витрине.
func (a *API) handleSetCategoryAlbumOrder(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	categoryID, ok := parseUUIDParam(w, r, "categoryID")
	if !ok {
		return
	}
	var req struct {
		AlbumIDs []string `json:"album_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.AlbumIDs) == 0 || len(req.AlbumIDs) > maxCategoryAlbumOrder {
		apiError(w, http.StatusBadRequest, "invalid_order",
			fmt.Sprintf("album_ids must hold 1..%d ids", maxCategoryAlbumOrder))
		return
	}
	ids := make([]uuid.UUID, 0, len(req.AlbumIDs))
	seen := make(map[uuid.UUID]struct{}, len(req.AlbumIDs))
	for _, raw := range req.AlbumIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_album", "invalid album id")
			return
		}
		// Повтор в списке дал бы одному альбому два места сразу.
		if _, dup := seen[id]; dup {
			apiError(w, http.StatusBadRequest, "invalid_order", "album_ids must be unique")
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	// Чужая категория — 404, а не молчаливые «0 строк обновлено».
	if _, err := a.Q.GetCategoryForShop(r.Context(), db.GetCategoryForShopParams{ID: categoryID, ShopID: shop.ID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "category not found")
			return
		}
		a.internalError(w, "load category", err)
		return
	}
	if _, err := a.Q.SetCategoryAlbumOrder(r.Context(), db.SetCategoryAlbumOrderParams{
		AlbumIds:   ids,
		CategoryID: categoryID,
		ShopID:     shop.ID,
	}); err != nil {
		a.internalError(w, "set category album order", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

func derefInt32(v *int32) int32 {
	if v == nil {
		return 0
	}
	return *v
}

func optInt4(v *int32) pgtype.Int4 {
	if v == nil {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: *v, Valid: true}
}
