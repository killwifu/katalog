package integration

import (
	"context"
	"net/http"
	"testing"
)

// TestShopUnavailable: витрина, скрытая за неоплату, обязана отличаться от
// несуществующей. Покупателю уходит 410 с контактами продавца — иначе связь
// с продавцом рвётся ровно тогда, когда она ему нужнее всего (kit).
func TestShopUnavailable(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))

	// Пока магазин активен — витрина отдаётся.
	if status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status != http.StatusOK {
		t.Fatalf("активная витрина: %d, want 200", status)
	}

	if _, err := env.pool.Exec(context.Background(),
		"UPDATE shops SET billing_state = 'suspended' WHERE id = $1", shop.ID); err != nil {
		t.Fatalf("suspend shop: %v", err)
	}

	t.Run("410 с именем и контактами вместо 404", func(t *testing.T) {
		var body struct {
			Error string `json:"error"`
			Shop  struct {
				Name     string            `json:"name"`
				Contacts map[string]string `json:"contacts"`
			} `json:"shop"`
		}
		c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusGone, &body)
		if body.Error != "shop_unavailable" {
			t.Errorf("код %q, want shop_unavailable", body.Error)
		}
		if body.Shop.Name == "" {
			t.Error("имя продавца не отдано — покупателю не к кому обратиться")
		}
	})

	t.Run("наружу не течёт ничего лишнего", func(t *testing.T) {
		var raw map[string]any
		c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusGone, &raw)
		shopObj, _ := raw["shop"].(map[string]any)
		for _, leaked := range []string{"id", "slug", "storage_used", "plan", "billing_state", "owner_id"} {
			if _, ok := shopObj[leaked]; ok {
				t.Errorf("скрытая витрина отдаёт %q", leaked)
			}
		}
		if _, ok := raw["albums"]; ok {
			t.Error("скрытая витрина отдаёт альбомы")
		}
	})

	t.Run("альбом скрытой витрины тоже не открывается", func(t *testing.T) {
		status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil)
		if status != http.StatusGone {
			t.Errorf("альбом: %d, want 410", status)
		}
	})

	t.Run("заблокированный модератором магазин — обычный 404", func(t *testing.T) {
		if _, err := env.pool.Exec(context.Background(),
			"UPDATE shops SET status = 'suspended' WHERE id = $1", shop.ID); err != nil {
			t.Fatalf("suspend by moderator: %v", err)
		}
		status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
		if status != http.StatusNotFound {
			t.Errorf("заблокированный магазин: %d, want 404 — причину покупателю знать незачем", status)
		}
	})
}
