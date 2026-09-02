package integration

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"katalog/backend/internal/tasks"
)

type shopStatsJSON struct {
	Days   int `json:"days"`
	Totals struct {
		Views          int64 `json:"views"`
		UniqueVisitors int64 `json:"unique_visitors"`
		LeadClicks     int64 `json:"lead_clicks"`
	} `json:"totals"`
	Daily []struct {
		Date       string `json:"date"`
		Views      int64  `json:"views"`
		LeadClicks int64  `json:"lead_clicks"`
	} `json:"daily"`
	Channels []struct {
		Channel string `json:"channel"`
		Clicks  int64  `json:"clicks"`
	} `json:"channels"`
	TopAlbums []struct {
		AlbumID string `json:"album_id"`
		Title   string `json:"title"`
		Views   int64  `json:"views"`
	} `json:"top_albums"`
	TopPhotos []struct {
		PhotoID  string `json:"photo_id"`
		Clicks   int64  `json:"clicks"`
		ThumbURL string `json:"thumb_url"`
	} `json:"top_photos"`
}

// TestShopStatsDashboard: агрегаты за период — просмотры/уникальные из
// daily_stats, клики по каналам и топ фото из lead_clicks, топ альбомов.
func TestShopStatsDashboard(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	var album2 albumJSON
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Новинки"}, http.StatusCreated, &album2)

	photoID := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))
	waitPhotoStatus(c, shop.ID, album.ID, photoID, "ready", 60*time.Second)

	// daily_stats, как их пишет ночная агрегация: 3 дня уровня магазина
	// (просмотры/уникальные/лиды) + разбивка по двум альбомам.
	// Просмотры небольшие, чтобы не задеть тест traffic-алерта (порог 100).
	for i, views := range []int64{30, 20, 10} {
		mustExec(t, `INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
			VALUES ($1, current_date - $2::int, NULL, $3, $4, 0)`,
			shop.ID, i+1, views, views/2)
	}
	mustExec(t, `INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
		VALUES ($1, current_date - 1, $2, 25, 0, 0)`, shop.ID, album.ID)
	mustExec(t, `INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
		VALUES ($1, current_date - 1, $2, 5, 0, 0)`, shop.ID, album2.ID)

	// Клики «написать» в реальном времени: 2 telegram (по фото) + 1 whatsapp.
	for _, click := range []map[string]any{
		{"shop_id": shop.ID, "photo_id": photoID, "channel": "telegram"},
		{"shop_id": shop.ID, "photo_id": photoID, "channel": "telegram"},
		{"shop_id": shop.ID, "channel": "whatsapp"},
	} {
		if s, body := c.do("POST", "/api/v1/public/lead-click", click); s != http.StatusNoContent {
			t.Fatalf("lead click: status %d, body %s", s, body)
		}
	}

	var stats shopStatsJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/stats?days=30", nil, http.StatusOK, &stats)

	if stats.Totals.Views != 60 || stats.Totals.UniqueVisitors != 30 {
		t.Fatalf("totals: %+v (want views 60, uv 30)", stats.Totals)
	}
	if stats.Totals.LeadClicks != 3 {
		t.Fatalf("total lead clicks: %d, want 3", stats.Totals.LeadClicks)
	}
	if len(stats.Daily) != 3 {
		t.Fatalf("daily points: %d, want 3", len(stats.Daily))
	}
	if len(stats.Channels) != 2 || stats.Channels[0].Channel != "telegram" || stats.Channels[0].Clicks != 2 {
		t.Fatalf("channels: %+v", stats.Channels)
	}
	if len(stats.TopAlbums) != 2 || stats.TopAlbums[0].AlbumID != album.ID || stats.TopAlbums[0].Views != 25 {
		t.Fatalf("top albums: %+v", stats.TopAlbums)
	}
	if len(stats.TopPhotos) != 1 || stats.TopPhotos[0].PhotoID != photoID ||
		stats.TopPhotos[0].Clicks != 2 || stats.TopPhotos[0].ThumbURL == "" {
		t.Fatalf("top photos: %+v", stats.TopPhotos)
	}

	// Тенант-изоляция: чужому — 404.
	stranger := newClient(t)
	registerUser(stranger)
	if status, _ := stranger.do("GET", "/api/v1/shops/"+shop.ID+"/stats", nil); status != http.StatusNotFound {
		t.Fatalf("stats as stranger: status %d, want 404", status)
	}
}

// TestMonthlyDigest: письмо с цифрами прошлого месяца и сравнением
// с позапрошлым; магазины без активности дайджест не получают.
func TestMonthlyDigest(t *testing.T) {
	c := newClient(t)
	user := registerUser(c)
	shop := createShop(c)

	// Тихий магазин без статистики — письма быть не должно.
	quiet := newClient(t)
	quietUser := registerUser(quiet)
	createShop(quiet)

	now := time.Now().UTC()
	month := now.AddDate(0, -1, 0).Format("2006-01")
	monthStart, _ := time.ParseInLocation("2006-01", month, time.UTC)
	prevStart := monthStart.AddDate(0, -1, 0)

	// Прошлый месяц: 100 просмотров, 40 уникальных, 6 лидов.
	mustExec(t, `INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
		VALUES ($1, $2, NULL, 100, 40, 6)`, shop.ID, monthStart.Format("2006-01-02"))
	// Позапрошлый: 50 просмотров, 40 уникальных, 0 лидов.
	mustExec(t, `INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
		VALUES ($1, $2, NULL, 50, 40, 0)`, shop.ID, prevStart.Format("2006-01-02"))

	digest, err := tasks.NewStatsDigest(month)
	if err != nil {
		t.Fatalf("build digest task: %v", err)
	}
	if err := env.processor.HandleStatsDigest(t.Context(), digest); err != nil {
		t.Fatalf("digest run: %v", err)
	}

	msg := waitEmail(t, *user.Email, "итоги")
	for _, want := range []string{"100", "+100% к прошлому месяцу", "как в прошлом месяце", "в прошлом месяце 0"} {
		if !strings.Contains(msg.Text, want) {
			t.Fatalf("digest text missing %q:\n%s", want, msg.Text)
		}
	}

	env.mail.mu.Lock()
	for _, m := range env.mail.msgs {
		if m.To == *quietUser.Email && strings.Contains(m.Subject, "итоги") {
			t.Fatalf("quiet shop received digest: %+v", m)
		}
	}
	env.mail.mu.Unlock()
}

// TestTrafficAlert: всплеск дневных просмотров против средненедельных ->
// письмо админу; магазин с ровным трафиком в алерт не попадает.
func TestTrafficAlert(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	spiky := createShop(c)
	steady := createShop(c)

	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	// Спокойная неделя по 20 просмотров, вчера — 600 (x30, порог x5 и >= 100).
	for i := 2; i <= 8; i++ {
		mustExec(t, `INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
			VALUES ($1, current_date - $2::int, NULL, 20, 5, 0)`, spiky.ID, i)
	}
	mustExec(t, `INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
		VALUES ($1, $2, NULL, 600, 100, 0)`, spiky.ID, yesterday)
	// Ровный магазин: каждый день 150 — выше min_views, но без всплеска.
	for i := 1; i <= 8; i++ {
		mustExec(t, `INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
			VALUES ($1, current_date - $2::int, NULL, 150, 30, 0)`, steady.ID, i)
	}

	alert, err := tasks.NewTrafficAlert(yesterday)
	if err != nil {
		t.Fatalf("build alert task: %v", err)
	}
	if err := env.processor.HandleTrafficAlert(t.Context(), alert); err != nil {
		t.Fatalf("alert run: %v", err)
	}

	msg := waitEmail(t, "moderator@test.local", "аномальный CDN-трафик")
	if !strings.Contains(msg.Text, spiky.Slug) {
		t.Fatalf("alert must mention spiky shop %s:\n%s", spiky.Slug, msg.Text)
	}
	if strings.Contains(msg.Text, steady.Slug) {
		t.Fatalf("alert must not mention steady shop %s:\n%s", steady.Slug, msg.Text)
	}
}

// TestMetricsEndpoint: /metrics отдаёт бизнес-метрики в Prometheus-формате.
func TestMetricsEndpoint(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	// Публичный запрос, чтобы гистограмма латентности была непустой.
	if status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status != http.StatusOK {
		t.Fatalf("public shop: status %d", status)
	}

	resp, err := http.Get(env.srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("get metrics: %v", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read metrics: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("metrics: status %d", resp.StatusCode)
	}
	body := string(raw)
	for _, want := range []string{
		"katalog_uploads_today",
		"katalog_active_shops",
		`katalog_public_request_seconds_bucket{le="+Inf"}`,
		"katalog_public_request_seconds_count",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "katalog_public_request_seconds_count 0\n") {
		t.Fatal("latency histogram is empty after a public request")
	}
}

// TestRetentionPurge: аналитика не копится вечно.
//
// lead_clicks хранит visitor_hash — сведения о посетителях витрин, и держать
// их годами незачем: агрегат за день уходит в daily_stats той же ночью.
// Финансовые записи и журнал модерации задача не трогает: их срок хранения
// определяется не удобством уборки.
func TestRetentionPurge(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	// Старое (за пределами срока) и свежее — по обеим таблицам.
	mustExec(t, `INSERT INTO lead_clicks (shop_id, channel, visitor_hash, created_at)
		VALUES ($1, 'telegram', 'old', now() - interval '400 days'),
		       ($1, 'telegram', 'fresh', now() - interval '2 days')`, shop.ID)
	mustExec(t, `INSERT INTO daily_stats (shop_id, date, views, unique_visitors, lead_clicks)
		VALUES ($1, current_date - 500, 10, 5, 1),
		       ($1, current_date - 10, 20, 7, 2)`, shop.ID)
	// Платёж и запись модерации — их уборка обязана оставить.
	mustExec(t, `INSERT INTO payments (shop_id, plan, amount, currency, status, created_at)
		VALUES ($1, 'basic', 49000, 'RUB', 'canceled', now() - interval '900 days')`, shop.ID)
	admin := newClient(t)
	adminUser := registerUser(admin)
	mustExec(t, `INSERT INTO moderation_log (shop_id, admin_id, action, note, created_at)
		VALUES ($1, $2, 'block_photo', 'старая жалоба', now() - interval '900 days')`,
		shop.ID, adminUser.ID)

	if err := env.processor.HandleRetentionPurge(ctx, tasks.NewRetentionPurge()); err != nil {
		t.Fatalf("retention purge: %v", err)
	}

	count := func(query string) int {
		var n int
		if err := env.pool.QueryRow(ctx, query, shop.ID).Scan(&n); err != nil {
			t.Fatalf("count (%s): %v", query, err)
		}
		return n
	}
	if n := count(`SELECT count(*) FROM lead_clicks WHERE shop_id = $1`); n != 1 {
		t.Errorf("переходов осталось %d, ожидался 1 свежий", n)
	}
	if n := count(`SELECT count(*) FROM lead_clicks WHERE shop_id = $1 AND visitor_hash = 'fresh'`); n != 1 {
		t.Error("уборка снесла свежий переход")
	}
	if n := count(`SELECT count(*) FROM daily_stats WHERE shop_id = $1`); n != 1 {
		t.Errorf("дневных строк осталось %d, ожидалась 1 свежая", n)
	}
	if n := count(`SELECT count(*) FROM payments WHERE shop_id = $1`); n != 1 {
		t.Error("уборка тронула платежи — это финансовые записи")
	}
	if n := count(`SELECT count(*) FROM moderation_log WHERE shop_id = $1`); n != 1 {
		t.Error("уборка тронула журнал модерации — это доказательство по жалобе")
	}
}
