package integration

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

type albumWithCats struct {
	ID          string   `json:"id"`
	CategoryID  *string  `json:"category_id"`
	CategoryIDs []string `json:"category_ids"`
}

func albumCats(t *testing.T, c *client, shopID, albumID string) albumWithCats {
	t.Helper()
	_, raw := c.do("GET", "/api/v1/shops/"+shopID+"/albums", nil)
	var list []albumWithCats
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatalf("decode albums: %v", err)
	}
	for _, a := range list {
		if a.ID == albumID {
			return a
		}
	}
	t.Fatalf("album %s not in list", albumID)
	return albumWithCats{}
}

// TestAlbumInSeveralCategories: альбом лежит сразу в нескольких категориях,
// виден покупателю в каждой, а убранный из одной — остаётся в остальных.
func TestAlbumInSeveralCategories(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 400, 300))
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID, map[string]any{"status": "published"}, http.StatusOK, nil)

	jackets := createCategory(c, shop.ID, "Куртки", "kurtki", nil)
	wholesale := createCategory(c, shop.ID, "Опт", "opt", nil)
	link := func(catID string) string {
		return "/api/v1/shops/" + shop.ID + "/categories/" + catID + "/albums/" + album.ID
	}
	pubCat := func(slug string) string {
		_, body := c.do("GET", "/api/v1/public/shops/"+shop.Slug+"/categories/"+slug, nil)
		return string(body)
	}

	// --- в две категории ---
	for _, id := range []string{jackets.ID, wholesale.ID} {
		if status, body := c.do("PUT", link(id), nil); status != http.StatusNoContent {
			t.Fatalf("add to category: status %d, body %s", status, body)
		}
	}
	// Повторное добавление — не ошибка.
	if status, _ := c.do("PUT", link(jackets.ID), nil); status != http.StatusNoContent {
		t.Errorf("повторное добавление: status %d, want 204", status)
	}
	got := albumCats(t, c, shop.ID, album.ID)
	if len(got.CategoryIDs) != 2 || got.CategoryID == nil || *got.CategoryID != jackets.ID {
		t.Fatalf("после добавления в две категории: %+v", got)
	}
	for _, slug := range []string{"kurtki", "opt"} {
		if !strings.Contains(pubCat(slug), album.ID) {
			t.Errorf("покупатель не видит альбом в категории %s", slug)
		}
	}
	_, shopRaw := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
	if !strings.Contains(string(shopRaw), `"category_slugs":["kurtki","opt"]`) {
		t.Errorf("в сетке магазина нет обеих категорий альбома: %s", shopRaw)
	}
	_, tree := c.do("GET", "/api/v1/public/shops/"+shop.Slug+"/categories", nil)
	if strings.Count(string(tree), `"album_count":1`) != 2 {
		t.Errorf("счётчики категорий: %s", tree)
	}

	// --- убрали из одной: в другой остался ---
	if status, _ := c.do("DELETE", link(jackets.ID), nil); status != http.StatusNoContent {
		t.Fatalf("remove from category failed")
	}
	got = albumCats(t, c, shop.ID, album.ID)
	if len(got.CategoryIDs) != 1 || got.CategoryIDs[0] != wholesale.ID || got.CategoryID == nil || *got.CategoryID != wholesale.ID {
		t.Errorf("после удаления из одной категории: %+v", got)
	}
	if strings.Contains(pubCat("kurtki"), album.ID) || !strings.Contains(pubCat("opt"), album.ID) {
		t.Errorf("витрина не отразила удаление из категории")
	}
	if status, _ := c.do("DELETE", link(jackets.ID), nil); status != http.StatusNotFound {
		t.Errorf("повторное удаление: status %d, want 404", status)
	}

	// --- «задать категорию» оставляет ровно одну ---
	c.mustJSON("PUT", link(jackets.ID), nil, http.StatusNoContent, nil)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/category",
		map[string]any{"category_id": jackets.ID}, http.StatusOK, nil)
	got = albumCats(t, c, shop.ID, album.ID)
	if len(got.CategoryIDs) != 1 || got.CategoryIDs[0] != jackets.ID {
		t.Errorf("после set category: %+v", got)
	}

	// --- удаление категории с переносом и без ---
	c.mustJSON("PUT", link(wholesale.ID), nil, http.StatusNoContent, nil)
	c.mustJSON("DELETE", "/api/v1/shops/"+shop.ID+"/categories/"+jackets.ID, nil, http.StatusNoContent, nil)
	got = albumCats(t, c, shop.ID, album.ID)
	if len(got.CategoryIDs) != 1 || got.CategoryIDs[0] != wholesale.ID || got.CategoryID == nil || *got.CategoryID != wholesale.ID {
		t.Errorf("после удаления одной из двух категорий: %+v", got)
	}
	extra := createCategory(c, shop.ID, "Новинки", "new", nil)
	c.mustJSON("DELETE", "/api/v1/shops/"+shop.ID+"/categories/"+wholesale.ID+"?move_to="+extra.ID, nil, http.StatusNoContent, nil)
	got = albumCats(t, c, shop.ID, album.ID)
	if len(got.CategoryIDs) != 1 || got.CategoryIDs[0] != extra.ID {
		t.Errorf("после удаления с переносом: %+v", got)
	}

	// --- чужие альбом и категория ---
	stranger := newClient(t)
	registerUser(stranger)
	their := createShop(stranger)
	theirAlbum := createAlbum(stranger, their.ID)
	theirCat := createCategory(stranger, their.ID, "Чужая", "alien", nil)
	for _, probe := range []struct {
		who          *client
		method, path string
	}{
		{stranger, "PUT", link(extra.ID)},
		{stranger, "DELETE", link(extra.ID)},
		{stranger, "PUT", "/api/v1/shops/" + their.ID + "/categories/" + extra.ID + "/albums/" + theirAlbum.ID},
		{stranger, "PUT", "/api/v1/shops/" + their.ID + "/categories/" + theirCat.ID + "/albums/" + album.ID},
		{c, "PUT", "/api/v1/shops/" + shop.ID + "/categories/" + theirCat.ID + "/albums/" + album.ID},
	} {
		status, _ := probe.who.do(probe.method, probe.path, nil)
		if status != http.StatusNotFound && status != http.StatusForbidden {
			t.Errorf("%s %s: status %d, want 404/403", probe.method, probe.path, status)
		}
	}
	got = albumCats(t, c, shop.ID, album.ID)
	if len(got.CategoryIDs) != 1 || got.CategoryIDs[0] != extra.ID {
		t.Errorf("чужие запросы изменили категории альбома: %+v", got)
	}
}
