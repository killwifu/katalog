package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"katalog/backend/internal/db"
)

type publicTabResponse struct {
	Title string `json:"title"`
	Slug  string `json:"slug"`
}

type publicSectionResponse struct {
	Title  string                `json:"title"`
	Albums []publicAlbumResponse `json:"albums"`
}

// handlePublicTab — выкладка вкладки: секции со своими альбомами.
// Пустой ответ означает, что секций нет: витрина в этом случае показывает
// все альбомы по дате (kit).
func (a *API) handlePublicTab(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	sections, err := a.publicSections(r, shop.ID, chi.URLParam(r, "tabSlug"))
	if err != nil {
		a.internalError(w, "list public sections", err)
		return
	}
	writeJSON(w, http.StatusOK, sections)
}

// publicSections собирает секции вкладки. Один запрос с LEFT JOIN: пустая
// секция тоже должна доехать до витрины, иначе продавец не поймёт, куда
// делся только что созданный раздел.
func (a *API) publicSections(r *http.Request, shopID uuid.UUID, tabSlug string) ([]publicSectionResponse, error) {
	rows, err := a.Q.ListPublicSectionAlbums(r.Context(), db.ListPublicSectionAlbumsParams{
		ShopID: shopID,
		Slug:   tabSlug,
	})
	if err != nil {
		return nil, err
	}

	out := make([]publicSectionResponse, 0)
	index := make(map[uuid.UUID]int, len(rows))
	for _, row := range rows {
		pos, seen := index[row.SectionID]
		if !seen {
			pos = len(out)
			index[row.SectionID] = pos
			out = append(out, publicSectionResponse{
				Title:  row.SectionTitle,
				Albums: []publicAlbumResponse{},
			})
		}
		// LEFT JOIN: у пустой секции колонки альбома NULL.
		if !row.ID.Valid {
			continue
		}
		item := publicAlbumResponse{ID: row.ID.UUID.String()}
		if row.Title != nil {
			item.Title = *row.Title
		}
		if row.PhotoCount.Valid {
			item.PhotoCount = row.PhotoCount.Int32
		}
		if row.ParentID.Valid {
			p := row.ParentID.UUID.String()
			item.ParentID = &p
		}
		out[pos].Albums = append(out[pos].Albums, item)
	}
	return out, nil
}
