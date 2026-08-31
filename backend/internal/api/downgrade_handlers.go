package api

import (
	"fmt"
	"net/http"

	"github.com/google/uuid"

	"katalog/backend/internal/db"
)

type downgradeAlbum struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	PhotoCount   int32  `json:"photo_count"`
	Views        int64  `json:"views"`
	HiddenByPlan bool   `json:"hidden_by_plan"`
}

// handleGetDowngrade — состояние экрана понижения тарифа: сколько фотографий
// помещается в тариф, сколько есть и какие альбомы из чего выбирать.
//
// Экран нужен и когда тариф уже понижен, и когда понижение только предстоит,
// поэтому он не привязан к событию биллинга: показывается, пока фотографий
// больше лимита.
func (a *API) handleGetDowngrade(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	rows, err := a.Q.ListAlbumsForDowngrade(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "list albums for downgrade", err)
		return
	}

	limits := a.Cfg.Billing.Limits(string(shop.Plan))
	albums := make([]downgradeAlbum, 0, len(rows))
	var total, visible int64
	for _, row := range rows {
		albums = append(albums, downgradeAlbum{
			ID:           row.ID.String(),
			Title:        row.Title,
			PhotoCount:   row.PhotoCount,
			Views:        row.Views,
			HiddenByPlan: row.HiddenByPlan,
		})
		total += int64(row.PhotoCount)
		if !row.HiddenByPlan {
			visible += int64(row.PhotoCount)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"plan":           string(shop.Plan),
		"max_photos":     limits.MaxPhotos,
		"total_photos":   total,
		"visible_photos": visible,
		// over_limit — единственный признак, по которому кабинет решает
		// показывать экран: считать его на клиенте значит разойтись
		// с сервером при первой же смене лимитов тарифа.
		"over_limit": total > limits.MaxPhotos,
		"albums":     albums,
	})
}

// handleApplyDowngrade — сохранить выбор: перечисленные альбомы остаются
// видимыми, остальные скрываются. Ничего не удаляется.
func (a *API) handleApplyDowngrade(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req struct {
		AlbumIDs []string `json:"album_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	keep := make([]uuid.UUID, 0, len(req.AlbumIDs))
	for _, raw := range req.AlbumIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_album", "invalid album id")
			return
		}
		keep = append(keep, id)
	}

	// Выбор обязан помещаться в тариф. Кабинет это проверяет и блокирует
	// кнопку, но лимит платный: единственный запрос со списком всех альбомов
	// оставлял бы видимым весь каталог мимо тарифа.
	rows, err := a.Q.ListAlbumsForDowngrade(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "list albums for downgrade", err)
		return
	}
	kept := make(map[uuid.UUID]struct{}, len(keep))
	for _, id := range keep {
		kept[id] = struct{}{}
	}
	var keptPhotos int64
	for _, row := range rows {
		if _, ok := kept[row.ID]; ok {
			keptPhotos += int64(row.PhotoCount)
		}
	}
	limits := a.Cfg.Billing.Limits(string(shop.Plan))
	if keptPhotos > limits.MaxPhotos {
		apiError(w, http.StatusBadRequest, "over_limit",
			fmt.Sprintf("selected albums hold %d photos, plan allows %d", keptPhotos, limits.MaxPhotos))
		return
	}

	// Запрос ограничен shop_id, поэтому чужие id в списке просто ни на что
	// не влияют: они не совпадут ни с одним альбомом магазина.
	if err := a.Q.ApplyPlanVisibility(r.Context(), db.ApplyPlanVisibilityParams{
		ShopID:  shop.ID,
		Column2: keep,
	}); err != nil {
		a.internalError(w, "apply plan visibility", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}
