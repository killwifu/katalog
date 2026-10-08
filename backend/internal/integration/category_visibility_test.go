package integration

import (
	"net/http"
	"strings"
	"testing"
)

// TestCategoryVisibility: «Скрыть с витрины» убирает категорию у покупателя
// (меню и её адрес), но не трогает альбомы; «На главной» — признак для
// главной страницы витрины. Чужую категорию переключить нельзя.
func TestCategoryVisibility(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 400, 300))
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID, map[string]any{"status": "published"}, http.StatusOK, nil)

	var cat struct {
		ID       string `json:"id"`
		Slug     string `json:"slug"`
		IsHidden bool   `json:"is_hidden"`
		OnHome   bool   `json:"on_home"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/categories",
		map[string]any{"title": "Куртки", "slug": "kurtki"}, http.StatusCreated, &cat)
	if cat.IsHidden || !cat.OnHome {
		t.Fatalf("новая категория должна быть видимой и на главной: %+v", cat)
	}
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/category",
		map[string]any{"category_id": cat.ID}, http.StatusOK, nil)

	pubList := "/api/v1/public/shops/" + shop.Slug + "/categories"
	pubCat := pubList + "/kurtki"
	visPath := "/api/v1/shops/" + shop.ID + "/categories/" + cat.ID + "/visibility"

	_, body := c.do("GET", pubList, nil)
	if !strings.Contains(string(body), `"slug":"kurtki"`) || !strings.Contains(string(body), `"on_home":true`) {
		t.Fatalf("категории нет в публичном списке: %s", body)
	}

	// --- убрать с главной: категория остаётся в меню ---
	c.mustJSON("PATCH", visPath, map[string]any{"on_home": false}, http.StatusOK, &cat)
	if cat.OnHome || cat.IsHidden {
		t.Errorf("после on_home=false: %+v", cat)
	}
	_, body = c.do("GET", pubList, nil)
	if !strings.Contains(string(body), `"on_home":false`) {
		t.Errorf("публичный список не отразил on_home: %s", body)
	}

	// --- скрыть с витрины ---
	c.mustJSON("PATCH", visPath, map[string]any{"is_hidden": true}, http.StatusOK, &cat)
	if !cat.IsHidden || cat.OnHome {
		t.Errorf("is_hidden не должен трогать on_home: %+v", cat)
	}
	_, body = c.do("GET", pubList, nil)
	if strings.Contains(string(body), "kurtki") {
		t.Errorf("скрытая категория в публичном списке: %s", body)
	}
	_, body = c.do("GET", pubCat, nil)
	if strings.Contains(string(body), album.ID) {
		t.Errorf("скрытая категория отдаёт альбомы по своему адресу: %s", body)
	}
	// Сам альбом доступен по ссылке и в сетке магазина.
	if status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil); status != http.StatusOK {
		t.Errorf("альбом скрытой категории недоступен по ссылке: %d", status)
	}
	_, body = c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
	if !strings.Contains(string(body), album.ID) {
		t.Errorf("альбом скрытой категории пропал из сетки магазина")
	}

	// --- чужой не переключит ---
	stranger := newClient(t)
	registerUser(stranger)
	their := createShop(stranger)
	for _, path := range []string{visPath, "/api/v1/shops/" + their.ID + "/categories/" + cat.ID + "/visibility"} {
		status, _ := stranger.do("PATCH", path, map[string]any{"is_hidden": false})
		if status != http.StatusNotFound && status != http.StatusForbidden {
			t.Errorf("PATCH %s: status %d, want 404/403", path, status)
		}
	}
	_, body = c.do("GET", pubList, nil)
	if strings.Contains(string(body), "kurtki") {
		t.Errorf("чужой вернул категорию на витрину: %s", body)
	}

	// --- вернуть ---
	c.mustJSON("PATCH", visPath, map[string]any{"is_hidden": false, "on_home": true}, http.StatusOK, &cat)
	_, body = c.do("GET", pubCat, nil)
	if !strings.Contains(string(body), album.ID) {
		t.Errorf("после возврата категория не отдаёт альбомы: %s", body)
	}
}
