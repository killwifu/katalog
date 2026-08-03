package integration

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"katalog/backend/internal/tasks"
)

// TestStatsAggregation: Redis-счётчики просмотров + lead_clicks из PG
// сворачиваются в daily_stats; обработанные ключи удаляются.
func TestStatsAggregation(t *testing.T) {
	ctx := t.Context()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	// Лид сегодняшним днём (created_at = now()).
	if s, _ := c.do("POST", "/api/v1/public/lead-click",
		map[string]any{"shop_id": shop.ID, "channel": "telegram"}); s != http.StatusNoContent {
		t.Fatalf("lead click: status %d", s)
	}

	// Счётчики просмотров, как их пишет Next route handler /t.
	date := time.Now().UTC().Format("2006-01-02")
	shopKey := "views:" + date + ":" + shop.ID + ":-"
	albumKey := "views:" + date + ":" + shop.ID + ":" + album.ID
	uvKey := "uv:" + date + ":" + shop.ID
	if err := env.rdb.IncrBy(ctx, shopKey, 5).Err(); err != nil {
		t.Fatalf("seed views: %v", err)
	}
	if err := env.rdb.IncrBy(ctx, albumKey, 3).Err(); err != nil {
		t.Fatalf("seed album views: %v", err)
	}
	if err := env.rdb.PFAdd(ctx, uvKey, "visitor-a", "visitor-b").Err(); err != nil {
		t.Fatalf("seed uv: %v", err)
	}

	task, err := tasks.NewStatsAggregate(date)
	if err != nil {
		t.Fatalf("build task: %v", err)
	}
	if err := env.processor.HandleStatsAggregate(ctx, asynq.NewTask(task.Type(), task.Payload())); err != nil {
		t.Fatalf("aggregate: %v", err)
	}

	var views, uv, leads int64
	err = env.pool.QueryRow(ctx,
		"SELECT views, unique_visitors, lead_clicks FROM daily_stats WHERE shop_id = $1 AND date = $2 AND album_id IS NULL",
		uuid.MustParse(shop.ID), date).Scan(&views, &uv, &leads)
	if err != nil {
		t.Fatalf("query shop daily_stats: %v", err)
	}
	if views != 5 || uv != 2 || leads != 1 {
		t.Errorf("shop stats: views %d (want 5), uv %d (want 2), leads %d (want 1)", views, uv, leads)
	}

	var albumViews int64
	err = env.pool.QueryRow(ctx,
		"SELECT views FROM daily_stats WHERE shop_id = $1 AND date = $2 AND album_id = $3",
		uuid.MustParse(shop.ID), date, uuid.MustParse(album.ID)).Scan(&albumViews)
	if err != nil {
		t.Fatalf("query album daily_stats: %v", err)
	}
	if albumViews != 3 {
		t.Errorf("album views %d, want 3", albumViews)
	}

	// Идемпотентность: повторный запуск (ключи Redis уже удалены)
	// не обнуляет и не задваивает значения.
	if err := env.processor.HandleStatsAggregate(ctx, asynq.NewTask(task.Type(), task.Payload())); err != nil {
		t.Fatalf("re-aggregate: %v", err)
	}
	err = env.pool.QueryRow(ctx,
		"SELECT views, lead_clicks FROM daily_stats WHERE shop_id = $1 AND date = $2 AND album_id IS NULL",
		uuid.MustParse(shop.ID), date).Scan(&views, &leads)
	if err != nil {
		t.Fatalf("query after rerun: %v", err)
	}
	if views != 5 || leads != 1 {
		t.Errorf("after rerun: views %d (want 5), leads %d (want 1)", views, leads)
	}

	if n, err := env.rdb.Exists(ctx, shopKey, albumKey, uvKey).Result(); err != nil || n != 0 {
		t.Errorf("redis keys not cleaned up: exists=%d err=%v", n, err)
	}
}
