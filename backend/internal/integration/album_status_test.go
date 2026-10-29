package integration

import (
	"fmt"
	"net/http"
	"testing"
)

// TestAlbumStatus: три статуса из kit. Смысл «по ссылке» в том, что альбом
// не виден в списках, но открывается по прямой ссылке — иначе он ничем
// не отличался бы от черновика.
func TestAlbumStatus(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 320, 240))

	setStatus := func(status string) {
		c.mustJSON("PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID),
			map[string]any{"status": status}, http.StatusOK, &struct{}{})
	}

	inList := func() bool {
		var page struct {
			Albums []struct {
				ID string `json:"id"`
			} `json:"albums"`
		}
		c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusOK, &page)
		for _, a := range page.Albums {
			if a.ID == album.ID {
				return true
			}
		}
		return false
	}

	byLink := func() int {
		status, _ := c.do("GET",
			fmt.Sprintf("/api/v1/public/shops/%s/albums/%s", shop.Slug, album.ID), nil)
		return status
	}

	t.Run("по умолчанию опубликован", func(t *testing.T) {
		if !inList() {
			t.Error("новый альбом должен быть в списке")
		}
		if got := byLink(); got != http.StatusOK {
			t.Errorf("прямая ссылка: %d, want 200", got)
		}
	})

	t.Run("по ссылке: нет в списке, но открывается", func(t *testing.T) {
		setStatus("unlisted")
		if inList() {
			t.Error("альбом «по ссылке» не должен быть в списке витрины")
		}
		if got := byLink(); got != http.StatusOK {
			t.Errorf("прямая ссылка: %d, want 200 — иначе статус бессмысленен", got)
		}
	})

	t.Run("черновик: не виден нигде", func(t *testing.T) {
		setStatus("draft")
		if inList() {
			t.Error("черновик не должен быть в списке")
		}
		if got := byLink(); got != http.StatusNotFound {
			t.Errorf("прямая ссылка на черновик: %d, want 404", got)
		}
	})

	t.Run("возврат в published восстанавливает выдачу", func(t *testing.T) {
		setStatus("published")
		if !inList() {
			t.Error("альбом не вернулся в список")
		}
	})

	t.Run("неизвестный статус отклоняется", func(t *testing.T) {
		status, body := c.do("PATCH",
			fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID),
			map[string]any{"status": "hidden"})
		if status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400; body: %s", status, body)
		}
	})
}

// TestAlbumCreateStatus: окно «Новый альбом» создаёт черновик сразу, а не
// «опубликован» с последующей сменой — обрыв посреди цепочки запросов
// оставлял пустой альбом открытым на витрине.
func TestAlbumCreateStatus(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	var al albumJSON
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Черновик", "status": "draft"}, http.StatusCreated, &al)
	var got struct {
		Status string `json:"status"`
	}
	c.mustJSON("GET", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, al.ID), nil, http.StatusOK, &got)
	if got.Status != "draft" {
		t.Fatalf("status %q, want draft", got.Status)
	}
	if st, _ := c.do("GET", fmt.Sprintf("/api/v1/public/shops/%s/albums/%s", shop.Slug, al.ID), nil); st != http.StatusNotFound {
		t.Errorf("черновик по прямой ссылке: %d, want 404", st)
	}

	var albums []struct{}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	before := len(albums)
	if st, body := c.do("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Плохой", "status": "hidden"}); st != http.StatusBadRequest {
		t.Fatalf("неизвестный статус: %d, want 400; body: %s", st, body)
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	if len(albums) != before {
		t.Error("на 400 альбом всё равно создался")
	}
}
