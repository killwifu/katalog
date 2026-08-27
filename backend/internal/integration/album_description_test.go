package integration

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// TestAlbumDescription: описание — единственное место, где продавец
// объясняет покупателю условия (размеры, цена, отправка). Подписи к фото
// для этого коротки, поэтому описание обязано доезжать до витрины.
func TestAlbumDescription(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))

	const text = "Размеры S–XL.\nЦена 11 500 ₽.\nОтправка из Москвы, 2–4 дня."

	t.Run("сохраняется и возвращается кабинету", func(t *testing.T) {
		var out struct {
			Description string `json:"description"`
		}
		c.mustJSON("PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID),
			map[string]any{"description": text}, http.StatusOK, &out)
		if out.Description != text {
			t.Fatalf("описание %q", out.Description)
		}
	})

	t.Run("доезжает до покупателя на странице альбома", func(t *testing.T) {
		var page struct {
			Album struct {
				Description string `json:"description"`
			} `json:"album"`
		}
		c.mustJSON("GET", fmt.Sprintf("/api/v1/public/shops/%s/albums/%s", shop.Slug, album.ID),
			nil, http.StatusOK, &page)
		if page.Album.Description != text {
			t.Fatalf("витрина отдала %q", page.Album.Description)
		}
	})

	t.Run("в сетке альбомов описания нет", func(t *testing.T) {
		// Ответ витрины кешируется ISR целиком: описания всех альбомов
		// раздули бы его без пользы, в сетке они не показываются.
		var raw map[string]any
		c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusOK, &raw)
		albums, _ := raw["albums"].([]any)
		for _, a := range albums {
			if m, ok := a.(map[string]any); ok {
				if _, has := m["description"]; has {
					t.Error("описание попало в сетку альбомов")
				}
			}
		}
	})

	t.Run("слишком длинное отклоняется", func(t *testing.T) {
		status, _ := c.do("PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID),
			map[string]any{"description": strings.Repeat("я", 2001)})
		if status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", status)
		}
	})
}
