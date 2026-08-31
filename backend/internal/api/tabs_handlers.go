package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
)

type tabResponse struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Slug      string `json:"slug"`
	IsSystem  bool   `json:"is_system"`
	SortOrder int32  `json:"sort_order"`
}

func toTabResponse(t db.Tab) tabResponse {
	return tabResponse{
		ID:        t.ID.String(),
		Title:     t.Title,
		Slug:      t.Slug,
		IsSystem:  t.IsSystem,
		SortOrder: t.SortOrder,
	}
}

type sectionResponse struct {
	ID        string   `json:"id"`
	TabID     string   `json:"tab_id"`
	Title     string   `json:"title"`
	SortOrder int32    `json:"sort_order"`
	AlbumIDs  []string `json:"album_ids"`
}

func (a *API) handleCreateTab(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req struct {
		Title     string `json:"title"`
		Slug      string `json:"slug"`
		SortOrder int32  `json:"sort_order"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len(req.Title) > 100 {
		apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-100 characters")
		return
	}
	req.Slug = strings.ToLower(strings.TrimSpace(req.Slug))
	if !slugPattern.MatchString(req.Slug) {
		apiError(w, http.StatusBadRequest, "invalid_slug", "slug must be 3-64 chars: a-z, 0-9, single dashes")
		return
	}

	tab, err := a.Q.CreateTab(r.Context(), db.CreateTabParams{
		ShopID:    shop.ID,
		Title:     req.Title,
		Slug:      req.Slug,
		IsSystem:  false,
		SortOrder: req.SortOrder,
	})
	if err != nil {
		if isUniqueViolation(err) {
			apiError(w, http.StatusConflict, "slug_taken", "tab slug already used in this shop")
			return
		}
		a.internalError(w, "create tab", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusCreated, toTabResponse(tab))
}

func (a *API) handleListTabs(w http.ResponseWriter, r *http.Request) {
	tabs, err := a.Q.ListTabsByShop(r.Context(), shopFromCtx(r).ID)
	if err != nil {
		a.internalError(w, "list tabs", err)
		return
	}
	out := make([]tabResponse, 0, len(tabs))
	for _, t := range tabs {
		out = append(out, toTabResponse(t))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleUpdateTab(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	id, ok := parseUUIDParam(w, r, "tabID")
	if !ok {
		return
	}
	var req struct {
		Title     string `json:"title"`
		SortOrder int32  `json:"sort_order"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len(req.Title) > 100 {
		apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-100 characters")
		return
	}
	tab, err := a.Q.UpdateTab(r.Context(), db.UpdateTabParams{
		ID:        id,
		ShopID:    shop.ID,
		Title:     req.Title,
		SortOrder: req.SortOrder,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "tab not found")
		return
	}
	if err != nil {
		a.internalError(w, "update tab", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, toTabResponse(tab))
}

// handleDeleteTab: системные вкладки не удаляются — они генерируются
// автоматически и без них витрина теряет навигацию.
func (a *API) handleDeleteTab(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	id, ok := parseUUIDParam(w, r, "tabID")
	if !ok {
		return
	}
	rows, err := a.Q.DeleteCustomTab(r.Context(), db.DeleteCustomTabParams{ID: id, ShopID: shop.ID})
	if err != nil {
		a.internalError(w, "delete tab", err)
		return
	}
	if rows == 0 {
		// Не различаем «чужая», «нет такой» и «системная»: наружу это 404.
		apiError(w, http.StatusNotFound, "not_found", "tab not found or system")
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleCreateSection(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	tabID, ok := parseUUIDParam(w, r, "tabID")
	if !ok {
		return
	}
	if _, err := a.Q.GetTabForShop(r.Context(), db.GetTabForShopParams{ID: tabID, ShopID: shop.ID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "tab not found")
			return
		}
		a.internalError(w, "load tab", err)
		return
	}
	var req struct {
		Title     string `json:"title"`
		SortOrder int32  `json:"sort_order"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len(req.Title) > 100 {
		apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-100 characters")
		return
	}
	sec, err := a.Q.CreateSection(r.Context(), db.CreateSectionParams{
		TabID:     tabID,
		Title:     req.Title,
		SortOrder: req.SortOrder,
	})
	if err != nil {
		a.internalError(w, "create section", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusCreated, sectionResponse{
		ID:        sec.ID.String(),
		TabID:     sec.TabID.String(),
		Title:     sec.Title,
		SortOrder: sec.SortOrder,
		AlbumIDs:  []string{},
	})
}

func (a *API) handleListSections(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	rows, err := a.Q.ListSectionsByShop(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "list sections", err)
		return
	}
	out := make([]sectionResponse, 0, len(rows))
	for _, s := range rows {
		ids, err := a.Q.ListSectionAlbumIDs(r.Context(), s.ID)
		if err != nil {
			a.internalError(w, "list section albums", err)
			return
		}
		albumIDs := make([]string, 0, len(ids))
		for _, id := range ids {
			albumIDs = append(albumIDs, id.String())
		}
		out = append(out, sectionResponse{
			ID:        s.ID.String(),
			TabID:     s.TabID.String(),
			Title:     s.Title,
			SortOrder: s.SortOrder,
			AlbumIDs:  albumIDs,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleUpdateSection(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	id, ok := parseUUIDParam(w, r, "sectionID")
	if !ok {
		return
	}
	var req struct {
		Title     string `json:"title"`
		SortOrder int32  `json:"sort_order"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len(req.Title) > 100 {
		apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-100 characters")
		return
	}
	sec, err := a.Q.UpdateSection(r.Context(), db.UpdateSectionParams{
		ID:        id,
		ShopID:    shop.ID,
		Title:     req.Title,
		SortOrder: req.SortOrder,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "section not found")
		return
	}
	if err != nil {
		a.internalError(w, "update section", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, sectionResponse{
		ID:        sec.ID.String(),
		TabID:     sec.TabID.String(),
		Title:     sec.Title,
		SortOrder: sec.SortOrder,
	})
}

func (a *API) handleDeleteSection(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	id, ok := parseUUIDParam(w, r, "sectionID")
	if !ok {
		return
	}
	rows, err := a.Q.DeleteSection(r.Context(), db.DeleteSectionParams{ID: id, ShopID: shop.ID})
	if err != nil {
		a.internalError(w, "delete section", err)
		return
	}
	if rows == 0 {
		apiError(w, http.StatusNotFound, "not_found", "section not found")
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

// maxSectionAlbums — потолок на размер секции. Каждый альбом — отдельный
// INSERT, так что без потолка один запрос может занять соединение надолго.
const maxSectionAlbums = 500

// handleSetTabOrder задаёт порядок вкладок целиком. Раньше кабинет менял
// местами два sort_order двумя запросами: если второй не доезжал, у соседей
// оставался одинаковый порядковый номер, а кабинет об этом не узнавал —
// он обновлял список только при успехе.
func (a *API) handleSetTabOrder(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req struct {
		TabIDs []string `json:"tab_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.TabIDs) > maxSectionAlbums {
		apiError(w, http.StatusBadRequest, "too_many_tabs", "too many tabs")
		return
	}
	ids := make([]uuid.UUID, 0, len(req.TabIDs))
	for _, raw := range req.TabIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_tab", "invalid tab id")
			return
		}
		ids = append(ids, id)
	}
	// Запрос ограничен shop_id: чужие id просто не совпадут ни с одной
	// строкой и порядок не тронут.
	if _, err := a.Q.SetTabOrder(r.Context(), db.SetTabOrderParams{
		ShopID:  shop.ID,
		Column2: ids,
	}); err != nil {
		a.internalError(w, "set tab order", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

// handleSetSectionAlbums задаёт состав секции целиком: редактор перетаскивания
// всё равно сохраняет и порядок, а замена списка проще пары add/remove.
// Порядок в секции ручной, не по дате (kit).
func (a *API) handleSetSectionAlbums(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	id, ok := parseUUIDParam(w, r, "sectionID")
	if !ok {
		return
	}
	if _, err := a.Q.GetSectionForShop(r.Context(), db.GetSectionForShopParams{ID: id, ShopID: shop.ID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "section not found")
			return
		}
		a.internalError(w, "load section", err)
		return
	}
	var req struct {
		AlbumIDs []string `json:"album_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if len(req.AlbumIDs) > maxSectionAlbums {
		apiError(w, http.StatusBadRequest, "too_many_albums",
			fmt.Sprintf("section holds at most %d albums", maxSectionAlbums))
		return
	}

	// Транзакция: без неё ошибка на середине списка оставляет секцию
	// наполовину очищенной, и продавец теряет раскладку витрины.
	tx, err := a.Pool.Begin(r.Context())
	if err != nil {
		a.internalError(w, "begin tx", err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := a.Q.WithTx(tx)

	if err := q.ClearSectionAlbums(r.Context(), id); err != nil {
		a.internalError(w, "clear section", err)
		return
	}
	for i, raw := range req.AlbumIDs {
		albumID, err := uuid.Parse(raw)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_album", "invalid album id")
			return
		}
		// Запрос сам отсекает чужие альбомы: вставка идёт SELECT'ом
		// с условием shop_id, чужой id просто не даст строки.
		if err := q.AddAlbumToSection(r.Context(), db.AddAlbumToSectionParams{
			ID:        albumID,
			SectionID: id,
			SortOrder: int32(i),
			ShopID:    shop.ID,
		}); err != nil {
			a.internalError(w, "add album to section", err)
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		a.internalError(w, "commit section albums", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}
