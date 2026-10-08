package integration

import (
	"net/http"
	"sync"
	"testing"
)

// TestConcurrentAddAlbumsKeepsDistinctPositions: кабинет кладёт пачку
// альбомов в категорию параллельными запросами (окно «Добавить альбомы»,
// «Отменить» после «Убрать»). Каждый должен получить своё место — раньше
// max(sort_order)+1 в параллели выдавал всем одно и то же, и порядок
// альбомов в категории становился случайным.
func TestConcurrentAddAlbumsKeepsDistinctPositions(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	cat := createCategory(c, shop.ID, "Пачка", "pachka", nil)

	const n = 12
	ids := make([]string, n)
	for i := range ids {
		ids[i] = createAlbum(c, shop.ID).ID
	}
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if st, body := c.do("PUT", "/api/v1/shops/"+shop.ID+"/categories/"+cat.ID+"/albums/"+id, nil); st != http.StatusNoContent {
				t.Errorf("add %s: status %d %s", id, st, body)
			}
		}(id)
	}
	wg.Wait()

	var list []struct {
		ID          string           `json:"id"`
		CategoryPos map[string]int32 `json:"category_pos"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &list)
	seen := map[int32]string{}
	for _, al := range list {
		pos, ok := al.CategoryPos[cat.ID]
		if !ok {
			continue
		}
		if other, dup := seen[pos]; dup {
			t.Fatalf("albums %s and %s share position %d in the category", other, al.ID, pos)
		}
		seen[pos] = al.ID
	}
	if len(seen) != n {
		t.Fatalf("albums in category = %d, want %d", len(seen), n)
	}
}
