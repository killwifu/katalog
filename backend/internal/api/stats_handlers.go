package api

import (
	"fmt"
	"net/http"
	"time"

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
	Days   int `json:"days"`
	Totals struct {
		Views          int64 `json:"views"`
		UniqueVisitors int64 `json:"unique_visitors"`
		LeadClicks     int64 `json:"lead_clicks"`
	} `json:"totals"`
	Daily     []statsDailyPoint `json:"daily"`
	Channels  []statsChannel    `json:"channels"`
	TopAlbums []statsTopAlbum   `json:"top_albums"`
	TopPhotos []statsTopPhoto   `json:"top_photos"`
}

type statsChannel struct {
	Channel string `json:"channel"`
	Clicks  int64  `json:"clicks"`
}

type statsTopAlbum struct {
	AlbumID string `json:"album_id"`
	Title   string `json:"title"`
	Views   int64  `json:"views"`
}

type statsTopPhoto struct {
	PhotoID  string `json:"photo_id"`
	Caption  string `json:"caption"`
	Clicks   int64  `json:"clicks"`
	ThumbURL string `json:"thumb_url,omitempty"`
}

// handleShopStats — GET /shops/{shopID}/stats?days=7|30|90.
func (a *API) handleShopStats(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	days := queryInt(r, "days", 30, 1, 365)

	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	from := today.AddDate(0, 0, -days+1)
	fromDate := pgtype.Date{Time: from, Valid: true}
	toDate := pgtype.Date{Time: today, Valid: true}
	fromTs := pgtype.Timestamptz{Time: from, Valid: true}
	nowTs := pgtype.Timestamptz{Time: now.Add(time.Second), Valid: true}

	resp := statsResponse{Days: days}

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

	albums, err := a.Q.GetShopTopAlbums(r.Context(), db.GetShopTopAlbumsParams{
		ShopID: shop.ID,
		Date:   fromDate,
		Date_2: toDate,
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
			PhotoID: p.PhotoID.UUID.String(),
			Caption: p.Caption,
			Clicks:  p.Clicks,
		}
		if p.Status == db.PhotoStatusReady {
			tp.ThumbURL = fmt.Sprintf("/media/%s/%s/300.webp", shop.ID, p.PhotoID.UUID)
		}
		resp.TopPhotos = append(resp.TopPhotos, tp)
	}

	writeJSON(w, http.StatusOK, resp)
}
