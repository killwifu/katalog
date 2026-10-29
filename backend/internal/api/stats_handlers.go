package api

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"katalog/backend/internal/db"
)

// Дашборд продавца: агрегаты из daily_stats (просмотры/уникальные — по
// вчерашний день включительно, их считает ночной джоб) + клики «написать»
// из lead_clicks в реальном времени. Никакого Redis на этом пути.

type statsDailyPoint struct {
	Date           string `json:"date"`
	Views          int64  `json:"views"`
	UniqueVisitors int64  `json:"unique_visitors"`
	LeadClicks     int64  `json:"lead_clicks"`
}

type statsResponse struct {
	Days int `json:"days"`
	// From/To — границы периода включительно (YYYY-MM-DD).
	From   string `json:"from"`
	To     string `json:"to"`
	Totals struct {
		Views          int64 `json:"views"`
		UniqueVisitors int64 `json:"unique_visitors"`
		LeadClicks     int64 `json:"lead_clicks"`
	} `json:"totals"`
	Daily     []statsDailyPoint `json:"daily"`
	Channels  []statsChannel    `json:"channels"`
	TopAlbums []statsTopAlbum   `json:"top_albums"`
	// AlbumsViewedWeek — сколько разных альбомов открывали за 7 дней;
	// окно фиксированное, от параметра days не зависит.
	AlbumsViewedWeek int64           `json:"albums_viewed_week"`
	TopPhotos        []statsTopPhoto `json:"top_photos"`
}

type statsChannel struct {
	Channel string `json:"channel"`
	Clicks  int64  `json:"clicks"`
}

type statsTopAlbum struct {
	AlbumID string `json:"album_id"`
	Title   string `json:"title"`
	Views   int64  `json:"views"`
	Clicks  int64  `json:"clicks"`
}

type statsTopPhoto struct {
	PhotoID    string `json:"photo_id"`
	Caption    string `json:"caption"`
	AlbumTitle string `json:"album_title"`
	Clicks     int64  `json:"clicks"`
	ThumbURL   string `json:"thumb_url,omitempty"`
}

// statsMaxBack — насколько назад можно спросить «свой период»: в кабинете
// доступны последние 30 дней, плюс столько же на сравнение с прошлым
// отрезком той же длины.
const statsMaxBack = 62

// handleShopStats — GET /shops/{shopID}/stats?days=N или ?from=&to=
// (YYYY-MM-DD, включительно; «Свой период» макета 19).
func (a *API) handleShopStats(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	if !requirePaidPlan(w, shop, "analytics_plan_required", "analytics is not available on the free plan") {
		return
	}
	days := queryInt(r, "days", 30, 1, 365)

	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	from, to := today.AddDate(0, 0, -days+1), today
	if qf, qt := r.URL.Query().Get("from"), r.URL.Query().Get("to"); qf != "" || qt != "" {
		f, err1 := time.Parse("2006-01-02", qf)
		t, err2 := time.Parse("2006-01-02", qt)
		if err1 != nil || err2 != nil || t.Before(f) || t.After(today) || f.Before(today.AddDate(0, 0, -statsMaxBack)) {
			apiError(w, http.StatusBadRequest, "invalid_period", "from/to must be dates within the last 62 days, from <= to")
			return
		}
		from, to = f, t
		days = int(to.Sub(from).Hours()/24) + 1
	}
	fromDate := pgtype.Date{Time: from, Valid: true}
	toDate := pgtype.Date{Time: to, Valid: true}
	fromTs := pgtype.Timestamptz{Time: from, Valid: true}
	// Клики — до конца последнего дня периода (для сегодняшнего — до «сейчас»).
	end := to.AddDate(0, 0, 1)
	if end.After(now) {
		end = now.Add(time.Second)
	}
	nowTs := pgtype.Timestamptz{Time: end, Valid: true}

	resp := statsResponse{Days: days, From: from.Format("2006-01-02"), To: to.Format("2006-01-02")}

	totals, err := a.Q.GetShopStatsTotals(r.Context(), db.GetShopStatsTotalsParams{
		ShopID: shop.ID,
		Date:   fromDate,
		Date_2: toDate,
	})
	if err != nil {
		a.internalError(w, "stats totals", err)
		return
	}
	resp.Totals.Views = totals.Views
	resp.Totals.UniqueVisitors = totals.UniqueVisitors

	daily, err := a.Q.GetShopStatsDaily(r.Context(), db.GetShopStatsDailyParams{
		ShopID: shop.ID,
		Date:   fromDate,
		Date_2: toDate,
	})
	if err != nil {
		a.internalError(w, "stats daily", err)
		return
	}
	resp.Daily = make([]statsDailyPoint, 0, len(daily))
	for _, d := range daily {
		resp.Daily = append(resp.Daily, statsDailyPoint{
			Date:           d.Date.Time.Format("2006-01-02"),
			Views:          d.Views,
			UniqueVisitors: d.UniqueVisitors,
			LeadClicks:     d.LeadClicks,
		})
	}

	channels, err := a.Q.GetShopLeadsByChannel(r.Context(), db.GetShopLeadsByChannelParams{
		ShopID:      shop.ID,
		CreatedAt:   fromTs,
		CreatedAt_2: nowTs,
	})
	if err != nil {
		a.internalError(w, "stats channels", err)
		return
	}
	resp.Channels = make([]statsChannel, 0, len(channels))
	for _, c := range channels {
		resp.Channels = append(resp.Channels, statsChannel{Channel: string(c.Channel), Clicks: c.Clicks})
		resp.Totals.LeadClicks += c.Clicks
	}

	viewed, err := a.Q.CountAlbumsViewedWeek(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "stats albums viewed", err)
		return
	}
	resp.AlbumsViewedWeek = viewed

	albums, err := a.Q.GetShopTopAlbums(r.Context(), db.GetShopTopAlbumsParams{
		ShopID:      shop.ID,
		Date:        fromDate,
		Date_2:      toDate,
		CreatedAt:   fromTs,
		CreatedAt_2: nowTs,
	})
	if err != nil {
		a.internalError(w, "stats top albums", err)
		return
	}
	resp.TopAlbums = make([]statsTopAlbum, 0, len(albums))
	for _, al := range albums {
		resp.TopAlbums = append(resp.TopAlbums, statsTopAlbum{
			AlbumID: al.AlbumID.UUID.String(),
			Title:   al.Title,
			Views:   al.Views,
			Clicks:  al.Clicks,
		})
	}

	photos, err := a.Q.GetShopTopPhotos(r.Context(), db.GetShopTopPhotosParams{
		ShopID:      shop.ID,
		CreatedAt:   fromTs,
		CreatedAt_2: nowTs,
	})
	if err != nil {
		a.internalError(w, "stats top photos", err)
		return
	}
	resp.TopPhotos = make([]statsTopPhoto, 0, len(photos))
	for _, p := range photos {
		tp := statsTopPhoto{
			PhotoID:    p.PhotoID.UUID.String(),
			Caption:    p.Caption,
			AlbumTitle: p.AlbumTitle,
			Clicks:     p.Clicks,
		}
		if p.Status == db.PhotoStatusReady {
			tp.ThumbURL = a.mediaURLs(shop.MediaRev, shop.ID, p.PhotoID.UUID)["small"]
		}
		resp.TopPhotos = append(resp.TopPhotos, tp)
	}

	writeJSON(w, http.StatusOK, resp)
}

// handleAlbumStats — показатели альбома для его страницы в кабинете:
// просмотры за 7 дней (и за предыдущие 7 — для сравнения) и переходы
// в мессенджер с его фотографий.
func (a *API) handleAlbumStats(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	shop := shopFromCtx(r)
	if !requirePaidPlan(w, shop, "analytics_plan_required", "analytics is not available on the free plan") {
		return
	}
	views, err := a.Q.GetAlbumWeekViews(r.Context(), db.GetAlbumWeekViewsParams{
		ShopID:  shop.ID,
		AlbumID: uuid.NullUUID{UUID: album.ID, Valid: true},
	})
	if err != nil {
		a.internalError(w, "album views", err)
		return
	}
	clicks, err := a.Q.CountAlbumLeadClicks(r.Context(), db.CountAlbumLeadClicksParams{
		ShopID:  shop.ID,
		AlbumID: album.ID,
	})
	if err != nil {
		a.internalError(w, "album lead clicks", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"views_week":      views.Week,
		"views_prev_week": views.PrevWeek,
		"lead_clicks":     clicks,
	})
}
