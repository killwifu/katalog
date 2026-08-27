package integration

import (
	"fmt"
	"net/http"
	"testing"
)

// TestShopSlugChange: смена адреса рвёт разосланные покупателям ссылки,
// поэтому она ограничена по частоте (макет: не чаще раза в полгода),
// а старый адрес обязан перестать открываться сразу.
func TestShopSlugChange(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))

	oldSlug := shop.Slug
	newSlug := oldSlug + "-new"

	t.Run("название меняется без ограничений", func(t *testing.T) {
		var out struct {
			Name string `json:"name"`
		}
		c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID,
			map[string]any{"name": "Переименован"}, http.StatusOK, &out)
		if out.Name != "Переименован" {
			t.Fatalf("имя %q", out.Name)
		}
	})

	t.Run("адрес меняется, старый перестаёт открываться", func(t *testing.T) {
		var out struct {
			Slug             string  `json:"slug"`
			SlugChangeableAt *string `json:"slug_changeable_at"`
		}
		c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID,
			map[string]any{"slug": newSlug}, http.StatusOK, &out)
		if out.Slug != newSlug {
			t.Fatalf("адрес %q, want %q", out.Slug, newSlug)
		}
		if out.SlugChangeableAt == nil {
			t.Error("после смены должен появиться срок следующей смены")
		}
		if status, _ := c.do("GET", "/api/v1/public/shops/"+oldSlug, nil); status != http.StatusNotFound {
			t.Errorf("старый адрес: %d, want 404", status)
		}
		if status, _ := c.do("GET", "/api/v1/public/shops/"+newSlug, nil); status != http.StatusOK {
			t.Errorf("новый адрес: %d, want 200", status)
		}
	})

	t.Run("повторная смена сразу — отказ", func(t *testing.T) {
		status, body := c.do("PATCH", "/api/v1/shops/"+shop.ID,
			map[string]any{"slug": newSlug + "-again"})
		if status != http.StatusConflict {
			t.Fatalf("status %d, want 409; body: %s", status, body)
		}
	})

	t.Run("отказ по частоте не откатывает остальные поля", func(t *testing.T) {
		// Имя в том же запросе должно сохраниться: смена адреса идёт
		// последней и её отказ не должен терять уже принятые правки.
		status, _ := c.do("PATCH", "/api/v1/shops/"+shop.ID,
			map[string]any{"name": "Ещё раз", "slug": "sovsem-drugoy"})
		if status != http.StatusConflict {
			t.Fatalf("status %d, want 409", status)
		}
		var out struct {
			Name string `json:"name"`
			Slug string `json:"slug"`
		}
		c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &out)
		if out.Name != "Ещё раз" {
			t.Errorf("имя не сохранилось: %q", out.Name)
		}
		if out.Slug != newSlug {
			t.Errorf("адрес всё-таки сменился: %q", out.Slug)
		}
	})

	t.Run("зарезервированные и кривые адреса отклоняются", func(t *testing.T) {
		other := newClient(t)
		registerUser(other)
		s2 := createShop(other)
		for _, bad := range []string{"admin", "ab", "Верх", "-dash"} {
			status, _ := other.do("PATCH", "/api/v1/shops/"+s2.ID, map[string]any{"slug": bad})
			if status != http.StatusBadRequest {
				t.Errorf("адрес %q: status %d, want 400", bad, status)
			}
		}
	})

	t.Run("занятый адрес — 409", func(t *testing.T) {
		third := newClient(t)
		registerUser(third)
		s3 := createShop(third)
		status, _ := third.do("PATCH", "/api/v1/shops/"+s3.ID, map[string]any{"slug": newSlug})
		if status != http.StatusConflict {
			t.Errorf("status %d, want 409", status)
		}
		_ = fmt.Sprint(s3.ID)
	})
}
