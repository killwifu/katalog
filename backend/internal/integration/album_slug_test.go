package integration

import (
	"net/http"
	"testing"
)

// TestAlbumSlug: адрес альбома на витрине — транслит названия, уникальный
// в магазине, не занимающий пути витрины и не меняющийся при
// переименовании; публичная ручка находит альбом и по слагу, и по id
// (старые ссылки /{shop}/a/{uuid}).
func TestAlbumSlug(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	base := "/api/v1/shops/" + shop.ID + "/albums"

	create := func(title string) (id, slug string) {
		t.Helper()
		var al struct {
			ID   string `json:"id"`
			Slug string `json:"slug"`
		}
		c.mustJSON("POST", base, map[string]any{"title": title}, http.StatusCreated, &al)
		return al.ID, al.Slug
	}

	cases := []struct{ title, want string }{
		{"Stone Island · осень", "stone-island-osen"},
		{"Stone Island · осень", "stone-island-osen-2"},
		{"Stüssy · футболки", "stussy-futbolki"},
		{"Щука ёж", "schuka-ezh"},
		// Пути витрины: /{shop}/search, /{shop}/c/… и т.д.
		{"Search", "search-2"},
		{"C", "c-2"},
		{"!!!", "album"},
	}
	ids := map[string]string{}
	for _, tc := range cases {
		id, slug := create(tc.title)
		if slug != tc.want {
			t.Errorf("%q: slug %q, want %q", tc.title, slug, tc.want)
		}
		ids[slug] = id
	}

	// Переименование слаг не трогает: ссылки уже у покупателей.
	first := ids["stone-island-osen"]
	var renamed struct {
		Slug string `json:"slug"`
	}
	c.mustJSON("PATCH", base+"/"+first, map[string]any{"title": "Другое имя"}, http.StatusOK, &renamed)
	if renamed.Slug != "stone-island-osen" {
		t.Errorf("после переименования slug %q", renamed.Slug)
	}

	// Публичная ручка: по слагу и по id — один и тот же альбом.
	pub := "/api/v1/public/shops/" + shop.Slug + "/albums/"
	for _, key := range []string{"stone-island-osen", first} {
		var page struct {
			Album struct {
				ID   string `json:"id"`
				Slug string `json:"slug"`
			} `json:"album"`
		}
		c.mustJSON("GET", pub+key, nil, http.StatusOK, &page)
		if page.Album.ID != first || page.Album.Slug != "stone-island-osen" {
			t.Errorf("GET %s: %+v", key, page.Album)
		}
	}
	if status, _ := c.do("GET", pub+"net-takogo", nil); status != http.StatusNotFound {
		t.Errorf("несуществующий слаг: status %d, want 404", status)
	}

	// Слаг чужого магазина в этом магазине не находится.
	other := newClient(t)
	registerUser(other)
	otherShop := createShop(other)
	var al struct {
		Slug string `json:"slug"`
	}
	other.mustJSON("POST", "/api/v1/shops/"+otherShop.ID+"/albums", map[string]any{"title": "Только у соседа"}, http.StatusCreated, &al)
	if status, _ := c.do("GET", pub+al.Slug, nil); status != http.StatusNotFound {
		t.Errorf("слаг чужого магазина: status %d, want 404", status)
	}
}

// TestAlbumUnlockLockout: 5 неверных паролей подряд закрывают ввод на
// 15 минут — даже верный пароль до конца блокировки не принимается.
func TestAlbumUnlockLockout(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 200, 200))
	mustExec(t, "UPDATE shops SET plan = 'standard', paid_until = now() + interval '30 days' WHERE id = $1", shop.ID)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID, map[string]any{"password": "opt2026"}, http.StatusOK, nil)

	buyer := newClient(t)
	unlock := "/api/v1/public/shops/" + shop.Slug + "/albums/" + album.ID + "/unlock"
	const ip = "203.0.113.77"
	for i := 1; i <= 4; i++ {
		if status, _ := buyer.doWithXFF("POST", unlock, map[string]any{"password": "nope"}, ip); status != http.StatusForbidden {
			t.Fatalf("попытка %d: status %d, want 403", i, status)
		}
	}
	if status, body := buyer.doWithXFF("POST", unlock, map[string]any{"password": "nope"}, ip); status != http.StatusTooManyRequests {
		t.Fatalf("пятая неверная: status %d %s, want 429", status, body)
	}
	if status, _ := buyer.doWithXFF("POST", unlock, map[string]any{"password": "opt2026"}, ip); status != http.StatusTooManyRequests {
		t.Fatalf("верный пароль во время блокировки: status %d, want 429", status)
	}
	// Другой адрес блокировка не задевает.
	if status, _ := buyer.doWithXFF("POST", unlock, map[string]any{"password": "opt2026"}, "203.0.113.78"); status != http.StatusOK {
		t.Fatalf("другой адрес: status %d, want 200", status)
	}
}
