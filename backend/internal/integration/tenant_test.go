package integration

import (
	"fmt"
	"net/http"
	"testing"
)

// TestTenantIsolation: КАЖДЫЙ приватный эндпоинт с чужим ресурсом
// обязан отвечать 404 (см. инвариант безопасности в CLAUDE.md).
func TestTenantIsolation(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photo := uploadPhoto(owner, shop.ID, album.ID, makeJPEG(t, 640, 480))

	// intruder — авторизованный пользователь с собственным магазином.
	intruder := newClient(t)
	registerUser(intruder)
	intruderShop := createShop(intruder)

	// Категория владельца — чтобы дёргать её id из-под чужой сессии.
	var cat struct {
		ID string `json:"id"`
	}
	owner.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/categories",
		map[string]any{"title": "Кроссовки", "slug": "krossovki"}, http.StatusCreated, &cat)

	tests := []struct {
		method string
		path   string
		body   any
	}{
		{"GET", "/api/v1/shops/" + shop.ID, nil},
		{"PATCH", "/api/v1/shops/" + shop.ID, map[string]any{"name": "hacked"}},
		{"DELETE", "/api/v1/shops/" + shop.ID, nil},
		{"GET", "/api/v1/shops/" + shop.ID + "/albums", nil},
		{"POST", "/api/v1/shops/" + shop.ID + "/albums", map[string]any{"title": "hacked"}},
		{"GET", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID), nil},
		{"PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID), map[string]any{"title": "hacked"}},
		{"DELETE", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID), nil},
		{"GET", fmt.Sprintf("/api/v1/shops/%s/albums/%s/photos", shop.ID, album.ID), nil},
		{"POST", "/api/v1/uploads/presign", map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000}},
		{"POST", "/api/v1/photos/confirm", map[string]any{"shop_id": shop.ID, "photo_ids": []string{photo}}},
		{"PATCH", "/api/v1/photos/" + photo, map[string]any{"caption": "hacked"}},
		{"DELETE", "/api/v1/photos/" + photo, nil},
		{"GET", "/api/v1/shops/" + shop.ID + "/categories", nil},
		{"POST", "/api/v1/shops/" + shop.ID + "/categories", map[string]any{"title": "hacked", "slug": "hacked-cat"}},
		{"PATCH", fmt.Sprintf("/api/v1/shops/%s/categories/%s", shop.ID, cat.ID), map[string]any{"title": "hacked", "slug": "hacked-cat"}},
		{"DELETE", fmt.Sprintf("/api/v1/shops/%s/categories/%s", shop.ID, cat.ID), nil},
		{"PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s/category", shop.ID, album.ID), map[string]any{"category_id": cat.ID}},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			status, body := intruder.do(tt.method, tt.path, tt.body)
			if status != http.StatusNotFound {
				t.Errorf("foreign resource: status %d, want 404; body: %s", status, body)
			}
		})
	}

	// Смешанная атака: свой магазин + чужой альбом.
	t.Run("presign with foreign album in own shop", func(t *testing.T) {
		status, body := intruder.do("POST", "/api/v1/uploads/presign",
			map[string]any{"shop_id": intruderShop.ID, "album_id": album.ID, "size": 1000})
		if status != http.StatusNotFound {
			t.Errorf("status %d, want 404; body: %s", status, body)
		}
	})
	// Свой магазин + чужое фото в confirm: не должно перевести чужое фото
	// в processing, ответ — per-item ошибка.
	t.Run("confirm with foreign photo in own shop", func(t *testing.T) {
		var confirm struct {
			Results []struct {
				Status string `json:"status"`
				Error  string `json:"error"`
			} `json:"results"`
		}
		intruder.mustJSON("POST", "/api/v1/photos/confirm",
			map[string]any{"shop_id": intruderShop.ID, "photo_ids": []string{photo}},
			http.StatusOK, &confirm)
		if len(confirm.Results) != 1 || confirm.Results[0].Status != "error" {
			t.Errorf("foreign photo confirm: %+v, want per-item error", confirm.Results)
		}
	})

	// Владелец после всех атак по-прежнему видит свои ресурсы.
	var check shopJSON
	owner.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &check)
	if check.Name == "hacked" {
		t.Fatal("intruder managed to modify foreign shop")
	}
}
