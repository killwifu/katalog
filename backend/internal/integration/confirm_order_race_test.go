package integration

import (
	"net/http"
	"sync"
	"testing"
	"time"
)

// Параллельные подтверждения в один альбом (кабинет шлёт пачки одновременно)
// не выдают двум фото один номер порядка. Раньше места резервировались пачкой
// вне транзакции, и из двенадцати фото восемь получали номер 2.
func TestConcurrentConfirmUniqueSortOrder(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	mustExec(t, "UPDATE shops SET plan = 'pro', paid_until = now() + interval '30 days' WHERE id = $1", shop.ID)
	for i := 0; i < 2; i++ {
		uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 40+i, 40))
	}
	const n = 12
	ids := make([]string, n)
	for i := range ids {
		ids[i] = putPhoto(c, shop.ID, album.ID, makeJPEG(t, 50+i, 50))
	}
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			code, body := c.do("POST", "/api/v1/photos/confirm", map[string]any{"shop_id": shop.ID, "photo_ids": []string{id}})
			if code != http.StatusOK {
				t.Errorf("confirm %s: %d %s", id, code, body)
			}
		}(id)
	}
	wg.Wait()
	for _, id := range ids {
		waitPhotoStatus(c, shop.ID, album.ID, id, "ready", 60*time.Second)
	}
	rows, err := env.pool.Query(t.Context(), `SELECT sort_order, count(*) FROM photos WHERE album_id = $1 GROUP BY 1 HAVING count(*) > 1`, album.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var pos, cnt int
		_ = rows.Scan(&pos, &cnt)
		t.Errorf("sort_order %d shared by %d photos", pos, cnt)
	}
}
