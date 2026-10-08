package integration

import (
	"net/http"
	"sync"
	"testing"
)

// Потолок магазинов на владельца держится и под параллельными запросами
// (раньше подсчёт без замка пропускал: из 20 одновременных создавалось 9).
func TestConcurrentCreateShopRespectsLimit(t *testing.T) {
	c := newClient(t)
	registerUser(c)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, raw := c.do("POST", "/api/v1/shops", map[string]any{"slug": uniqueSlug(), "name": "Test Shop"})
			if code != http.StatusCreated && code != http.StatusConflict {
				t.Errorf("POST /shops: %d %s", code, raw)
			}
		}()
	}
	wg.Wait()

	var shops []shopJSON
	c.mustJSON("GET", "/api/v1/shops", nil, http.StatusOK, &shops)
	if len(shops) != 5 {
		t.Fatalf("owner has %d shops, want exactly 5", len(shops))
	}
}

// То же для потолка альбомов в магазине (1000): пачка у самого потолка не
// должна проходить проверку целиком.
func TestConcurrentCreateAlbumRespectsLimit(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	mustExec(t, `INSERT INTO albums (shop_id, title) SELECT $1, 'a' || g FROM generate_series(1, 995) g`, shop.ID)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, raw := c.do("POST", "/api/v1/shops/"+shop.ID+"/albums", map[string]any{"title": "x"})
			if code != http.StatusCreated && code != http.StatusConflict {
				t.Errorf("POST albums: %d %s", code, raw)
			}
		}()
	}
	wg.Wait()

	var n int
	if err := env.pool.QueryRow(t.Context(),
		`SELECT count(*) FROM albums WHERE shop_id = $1 AND deleted_at IS NULL`, shop.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1000 {
		t.Fatalf("shop has %d albums, want exactly 1000", n)
	}
}
