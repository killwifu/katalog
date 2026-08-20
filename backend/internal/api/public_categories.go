package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"katalog/backend/internal/db"
)

// publicCategoryResponse — наружу только то, что рисует витрина.
// Ни shop_id, ни служебных полей.
type publicCategoryResponse struct {
	ParentSlug *string `json:"parent_slug"`
	Title      string  `json:"title"`
	Slug       string  `json:"slug"`
	AlbumCount int64   `json:"album_count"`
}

// handlePublicCategories — дерево категорий магазина. Из него витрина строит
// все три раскладки: выпадающее меню в шапке, дерево слева на странице
// категории и мобильную шторку (kit: «один компонент, три раскладки»).
func (a *API) handlePublicCategories(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	rows, err := a.Q.ListPublicCategories(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "list public categories", err)
		return
	}

	slugByID := make(map[string]string, len(rows))
	for _, c := range rows {
		slugByID[c.ID.String()] = c.Slug
	}

	out := make([]publicCategoryResponse, 0, len(rows))
	for _, c := range rows {
		item := publicCategoryResponse{
			Title:      c.Title,
			Slug:       c.Slug,
			AlbumCount: c.AlbumCount,
		}
		if c.ParentID.Valid {
			if s, ok := slugByID[c.ParentID.UUID.String()]; ok {
				item.ParentSlug = &s
			}
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}

// handlePublicCategory — альбомы категории. Категория верхнего уровня
// показывает и альбомы вложенных: покупателю не нужно кликать вглубь.
func (a *API) handlePublicCategory(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	albums, err := a.Q.ListPublicAlbumsByCategory(r.Context(), db.ListPublicAlbumsByCategoryParams{
		ShopID: shop.ID,
		Slug:   chi.URLParam(r, "categorySlug"),
	})
	if err != nil {
		a.internalError(w, "list category albums", err)
		return
	}
	out := make([]publicAlbumResponse, 0, len(albums))
	for _, al := range albums {
		item := publicAlbumResponse{
			ID:         al.ID.String(),
			Title:      al.Title,
			PhotoCount: al.PhotoCount,
		}
		if al.ParentID.Valid {
			p := al.ParentID.UUID.String()
			item.ParentID = &p
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}
