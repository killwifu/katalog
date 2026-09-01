package integration

import (
	"context"
	"net/http"
	"testing"
)

// TestAlbumLimitPerShop: число альбомов ограничено. Тарифом оно не
// ограничивалось никак, а страница магазина отдаёт их все и на каждый
// заход покупателя — горячий путь зависел от того, сколько их наделали.
func TestAlbumLimitPerShop(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	// Создавать тысячу через API долго: добиваем счётчик напрямую,
	// проверяем именно реакцию обработчика на достигнутый потолок.
	if _, err := env.pool.Exec(ctx, `
		INSERT INTO albums (shop_id, title)
		SELECT $1, 'Альбом ' || i FROM generate_series(1, 1000) AS i`, shop.ID); err != nil {
		t.Fatalf("seed albums: %v", err)
	}

	status, raw := c.do("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Тысяча первый"})
	if status != http.StatusConflict {
		t.Fatalf("альбом сверх потолка создан: status %d, want 409; body: %s", status, raw)
	}

	// Витрина отдаёт не больше потолка независимо от того, что в базе.
	var page struct {
		Albums []albumJSON `json:"albums"`
	}
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusOK, &page)
	if len(page.Albums) > 1000 {
		t.Fatalf("витрина отдала %d альбомов", len(page.Albums))
	}
}
