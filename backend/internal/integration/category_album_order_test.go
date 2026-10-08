package integration

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// publicCategoryAlbumIDs — альбомы категории в том порядке, в каком их
// увидит покупатель.
func publicCategoryAlbumIDs(t *testing.T, c *client, shopSlug, categorySlug string) []string {
	t.Helper()
	var albums []struct {
		ID string `json:"id"`
	}
	c.mustJSON("GET", "/api/v1/public/shops/"+shopSlug+"/categories/"+categorySlug, nil, http.StatusOK, &albums)
	ids := make([]string, len(albums))
	for i, a := range albums {
		ids[i] = a.ID
	}
	return ids
}

// TestCategoryAlbumOrder: продавец перетаскивает альбомы внутри категории,
// и в этом порядке они стоят и в кабинете, и на витрине. У каждой категории
// порядок свой: перестановка в одной не трогает другую.
func TestCategoryAlbumOrder(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	jpeg := makeJPEG(t, 400, 300)
	jackets := createCategory(c, shop.ID, "Куртки", "kurtki", nil)
	wholesale := createCategory(c, shop.ID, "Опт", "opt", nil)

	var albums []string
	for i := 0; i < 3; i++ {
		album := createAlbum(c, shop.ID)
		uploadReadyPhoto(t, c, shop.ID, album.ID, jpeg)
		c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID, map[string]any{"status": "published"}, http.StatusOK, nil)
		for _, cat := range []string{jackets.ID, wholesale.ID} {
			if status, body := c.do("PUT", "/api/v1/shops/"+shop.ID+"/categories/"+cat+"/albums/"+album.ID, nil); status != http.StatusNoContent {
				t.Fatalf("add to category: status %d, body %s", status, body)
			}
		}
		albums = append(albums, album.ID)
	}
	join := func(ids []string) string { return strings.Join(ids, ",") }

	// Добавленные встают в конец категории — в порядке добавления.
	if got := publicCategoryAlbumIDs(t, c, shop.Slug, "kurtki"); join(got) != join(albums) {
		t.Fatalf("исходный порядок %v, ожидался %v", got, albums)
	}

	orderPath := "/api/v1/shops/" + shop.ID + "/categories/" + jackets.ID + "/albums/order"
	want := []string{albums[2], albums[0], albums[1]}
	if status, body := c.do("PUT", orderPath, map[string]any{"album_ids": want}); status != http.StatusNoContent {
		t.Fatalf("set order: status %d, body %s", status, body)
	}
	if got := publicCategoryAlbumIDs(t, c, shop.Slug, "kurtki"); join(got) != join(want) {
		t.Errorf("витрина, «Куртки»: порядок %v, ожидался %v", got, want)
	}
	// Вторая категория осталась как была.
	if got := publicCategoryAlbumIDs(t, c, shop.Slug, "opt"); join(got) != join(albums) {
		t.Errorf("витрина, «Опт»: порядок изменился: %v", got)
	}

	// Кабинет и сетка магазина отдают место альбома в категории.
	_, raw := c.do("GET", "/api/v1/shops/"+shop.ID+"/albums", nil)
	var mine []struct {
		ID          string           `json:"id"`
		CategoryPos map[string]int32 `json:"category_pos"`
	}
	if err := json.Unmarshal(raw, &mine); err != nil {
		t.Fatalf("decode albums: %v", err)
	}
	for _, a := range mine {
		for i, id := range want {
			if a.ID == id && a.CategoryPos[jackets.ID] != int32(i+1) {
				t.Errorf("кабинет: альбом %s на месте %d, ожидалось %d", id, a.CategoryPos[jackets.ID], i+1)
			}
		}
	}
	var grid struct {
		Albums []struct {
			ID          string           `json:"id"`
			CategoryPos map[string]int32 `json:"category_pos"`
		} `json:"albums"`
	}
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusOK, &grid)
	for _, a := range grid.Albums {
		for i, id := range want {
			if a.ID == id && a.CategoryPos["kurtki"] != int32(i+1) {
				t.Errorf("витрина: альбом %s на месте %d, ожидалось %d", id, a.CategoryPos["kurtki"], i+1)
			}
		}
	}

	// --- мусор на входе ---
	for name, body := range map[string]any{
		"пустой список": map[string]any{"album_ids": []string{}},
		"не uuid":       map[string]any{"album_ids": []string{"nope"}},
		"повтор":        map[string]any{"album_ids": []string{albums[0], albums[0]}},
	} {
		if status, _ := c.do("PUT", orderPath, body); status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, status)
		}
	}
}

// Чужую категорию переставить нельзя, а чужие альбомы в своём запросе
// не сдвигаются.
func TestCategoryAlbumOrderTenantIsolation(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	jpeg := makeJPEG(t, 400, 300)
	cat := createCategory(owner, shop.ID, "Куртки", "kurtki", nil)
	var albums []string
	for i := 0; i < 2; i++ {
		album := createAlbum(owner, shop.ID)
		uploadReadyPhoto(t, owner, shop.ID, album.ID, jpeg)
		owner.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID, map[string]any{"status": "published"}, http.StatusOK, nil)
		if status, _ := owner.do("PUT", "/api/v1/shops/"+shop.ID+"/categories/"+cat.ID+"/albums/"+album.ID, nil); status != http.StatusNoContent {
			t.Fatalf("add to category: status %d", status)
		}
		albums = append(albums, album.ID)
	}

	stranger := newClient(t)
	registerUser(stranger)
	theirShop := createShop(stranger)
	theirCat := createCategory(stranger, theirShop.ID, "Своё", "svoe", nil)
	swapped := map[string]any{"album_ids": []string{albums[1], albums[0]}}

	// Чужой магазин в адресе.
	status, _ := stranger.do("PUT", "/api/v1/shops/"+shop.ID+"/categories/"+cat.ID+"/albums/order", swapped)
	if status != http.StatusNotFound && status != http.StatusForbidden {
		t.Errorf("чужой магазин: status %d, want 404/403", status)
	}
	// Свой магазин, чужая категория.
	status, _ = stranger.do("PUT", "/api/v1/shops/"+theirShop.ID+"/categories/"+cat.ID+"/albums/order", swapped)
	if status != http.StatusNotFound {
		t.Errorf("чужая категория: status %d, want 404", status)
	}
	// Своя категория, чужие альбомы в списке: запрос проходит, но их не трогает.
	status, _ = stranger.do("PUT", "/api/v1/shops/"+theirShop.ID+"/categories/"+theirCat.ID+"/albums/order", swapped)
	if status != http.StatusNoContent {
		t.Errorf("своя категория с чужими id: status %d, want 204", status)
	}

	if got := publicCategoryAlbumIDs(t, owner, shop.Slug, "kurtki"); strings.Join(got, ",") != strings.Join(albums, ",") {
		t.Errorf("порядок владельца изменился: %v", got)
	}
}
