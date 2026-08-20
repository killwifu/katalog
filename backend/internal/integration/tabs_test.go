package integration

import (
	"fmt"
	"net/http"
	"testing"
)

type tabResp struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Slug     string `json:"slug"`
	IsSystem bool   `json:"is_system"`
}

type sectionResp struct {
	ID       string   `json:"id"`
	TabID    string   `json:"tab_id"`
	Title    string   `json:"title"`
	AlbumIDs []string `json:"album_ids"`
}

type publicSection struct {
	Title  string `json:"title"`
	Albums []struct {
		ID string `json:"id"`
	} `json:"albums"`
}

func listTabs(c *client, shopID string) []tabResp {
	var tabs []tabResp
	c.mustJSON("GET", "/api/v1/shops/"+shopID+"/tabs", nil, http.StatusOK, &tabs)
	return tabs
}

func TestTabsAndSections(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	// Системные вкладки заводятся при создании магазина.
	tabs := listTabs(c, shop.ID)
	bySlug := map[string]tabResp{}
	for _, tb := range tabs {
		bySlug[tb.Slug] = tb
	}
	for _, want := range []string{"home", "albums", "contacts"} {
		tb, ok := bySlug[want]
		if !ok {
			t.Fatalf("системная вкладка %q не создана; есть: %+v", want, tabs)
		}
		if !tb.IsSystem {
			t.Errorf("вкладка %q должна быть системной", want)
		}
	}

	t.Run("системную вкладку удалить нельзя", func(t *testing.T) {
		status, _ := c.do("DELETE", "/api/v1/shops/"+shop.ID+"/tabs/"+bySlug["home"].ID, nil)
		if status != http.StatusNotFound {
			t.Fatalf("status %d, want 404", status)
		}
		if len(listTabs(c, shop.ID)) != len(tabs) {
			t.Fatal("системная вкладка всё-таки удалилась")
		}
	})

	var custom tabResp
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/tabs",
		map[string]any{"title": "Опт", "slug": "opt"}, http.StatusCreated, &custom)

	t.Run("свою вкладку удалить можно", func(t *testing.T) {
		var tmp tabResp
		c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/tabs",
			map[string]any{"title": "Временная", "slug": "vremennaya"}, http.StatusCreated, &tmp)
		status, _ := c.do("DELETE", "/api/v1/shops/"+shop.ID+"/tabs/"+tmp.ID, nil)
		if status != http.StatusNoContent {
			t.Fatalf("status %d, want 204", status)
		}
	})

	// Секции вкладки и состав альбомов.
	var sec sectionResp
	c.mustJSON("POST", fmt.Sprintf("/api/v1/shops/%s/tabs/%s/sections", shop.ID, custom.ID),
		map[string]any{"title": "Новинки"}, http.StatusCreated, &sec)

	a1 := createAlbum(c, shop.ID)
	a2 := createAlbum(c, shop.ID)
	uploadPhoto(c, shop.ID, a1.ID, makeJPEG(t, 320, 240))
	uploadPhoto(c, shop.ID, a2.ID, makeJPEG(t, 320, 240))

	setAlbums := func(ids ...string) {
		status, body := c.do("PUT", fmt.Sprintf("/api/v1/shops/%s/sections/%s/albums", shop.ID, sec.ID),
			map[string]any{"album_ids": ids})
		if status != http.StatusNoContent {
			t.Fatalf("status %d, want 204; body: %s", status, body)
		}
	}

	t.Run("порядок в секции ручной, а не по дате", func(t *testing.T) {
		setAlbums(a2.ID, a1.ID)
		var sections []publicSection
		c.mustJSON("GET", fmt.Sprintf("/api/v1/public/shops/%s/tabs/%s", shop.Slug, custom.Slug),
			nil, http.StatusOK, &sections)
		if len(sections) != 1 || len(sections[0].Albums) != 2 {
			t.Fatalf("получено %+v", sections)
		}
		if sections[0].Albums[0].ID != a2.ID || sections[0].Albums[1].ID != a1.ID {
			t.Fatalf("порядок не сохранён: %+v", sections[0].Albums)
		}
	})

	t.Run("альбом может лежать в нескольких секциях", func(t *testing.T) {
		var sec2 sectionResp
		c.mustJSON("POST", fmt.Sprintf("/api/v1/shops/%s/tabs/%s/sections", shop.ID, custom.ID),
			map[string]any{"title": "Хиты", "sort_order": 1}, http.StatusCreated, &sec2)
		status, _ := c.do("PUT", fmt.Sprintf("/api/v1/shops/%s/sections/%s/albums", shop.ID, sec2.ID),
			map[string]any{"album_ids": []string{a1.ID}})
		if status != http.StatusNoContent {
			t.Fatalf("status %d, want 204", status)
		}
		var sections []publicSection
		c.mustJSON("GET", fmt.Sprintf("/api/v1/public/shops/%s/tabs/%s", shop.Slug, custom.Slug),
			nil, http.StatusOK, &sections)
		if len(sections) != 2 {
			t.Fatalf("секций %d, want 2: %+v", len(sections), sections)
		}
		found := false
		for _, s := range sections {
			for _, al := range s.Albums {
				if al.ID == a1.ID {
					found = true
				}
			}
		}
		if !found {
			t.Fatal("альбом не попал во вторую секцию")
		}
	})

	t.Run("пустая секция доезжает до витрины", func(t *testing.T) {
		var empty tabResp
		c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/tabs",
			map[string]any{"title": "Пустая", "slug": "pustaya"}, http.StatusCreated, &empty)
		var s sectionResp
		c.mustJSON("POST", fmt.Sprintf("/api/v1/shops/%s/tabs/%s/sections", shop.ID, empty.ID),
			map[string]any{"title": "Пока пусто"}, http.StatusCreated, &s)
		var sections []publicSection
		c.mustJSON("GET", fmt.Sprintf("/api/v1/public/shops/%s/tabs/%s", shop.Slug, empty.Slug),
			nil, http.StatusOK, &sections)
		if len(sections) != 1 || len(sections[0].Albums) != 0 {
			t.Fatalf("пустая секция потерялась: %+v", sections)
		}
	})

	// Чужой альбом не должен попасть в свою секцию.
	t.Run("чужой альбом в свою секцию не попадает", func(t *testing.T) {
		other := newClient(t)
		registerUser(other)
		otherShop := createShop(other)
		foreign := createAlbum(other, otherShop.ID)

		setAlbums(a1.ID, foreign.ID)
		var sections []publicSection
		c.mustJSON("GET", fmt.Sprintf("/api/v1/public/shops/%s/tabs/%s", shop.Slug, custom.Slug),
			nil, http.StatusOK, &sections)
		for _, s := range sections {
			for _, al := range s.Albums {
				if al.ID == foreign.ID {
					t.Fatal("чужой альбом попал в витрину")
				}
			}
		}
	})

	t.Run("скрытый альбом не отдаётся", func(t *testing.T) {
		setAlbums(a1.ID)
		c.mustJSON("PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, a1.ID),
			map[string]any{"status": "draft"}, http.StatusOK, &struct{}{})
		var sections []publicSection
		c.mustJSON("GET", fmt.Sprintf("/api/v1/public/shops/%s/tabs/%s", shop.Slug, custom.Slug),
			nil, http.StatusOK, &sections)
		for _, s := range sections {
			for _, al := range s.Albums {
				if al.ID == a1.ID {
					t.Fatal("скрытый альбом виден покупателю")
				}
			}
		}
	})
}
