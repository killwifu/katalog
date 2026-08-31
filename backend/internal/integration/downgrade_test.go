package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// TestDowngrade: при понижении тарифа фотографии не удаляются — снимается
// только видимость на витрине, и оплата возвращает всё обратно (kit).
func TestDowngrade(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	keepAlbum := createAlbum(c, shop.ID)
	hideAlbum := createAlbum(c, shop.ID)
	// photo_count растёт после обработки воркером — ждём, иначе счётчики нули.
	p1 := uploadPhoto(c, shop.ID, keepAlbum.ID, makeJPEG(t, 320, 240))
	p2 := uploadPhoto(c, shop.ID, hideAlbum.ID, makeJPEG(t, 320, 240))
	waitPhotoStatus(c, shop.ID, keepAlbum.ID, p1, "ready", 30*time.Second)
	waitPhotoStatus(c, shop.ID, hideAlbum.ID, p2, "ready", 30*time.Second)

	visibleAlbums := func() map[string]bool {
		var page struct {
			Albums []struct {
				ID string `json:"id"`
			} `json:"albums"`
		}
		c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusOK, &page)
		out := map[string]bool{}
		for _, a := range page.Albums {
			out[a.ID] = true
		}
		return out
	}

	t.Run("до выбора видны оба", func(t *testing.T) {
		v := visibleAlbums()
		if !v[keepAlbum.ID] || !v[hideAlbum.ID] {
			t.Fatalf("ожидались оба альбома, получено %v", v)
		}
	})

	t.Run("экран отдаёт альбомы и лимит тарифа", func(t *testing.T) {
		var state struct {
			MaxPhotos   int64 `json:"max_photos"`
			TotalPhotos int64 `json:"total_photos"`
			Albums      []struct {
				ID         string `json:"id"`
				PhotoCount int32  `json:"photo_count"`
			} `json:"albums"`
		}
		c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/downgrade", nil, http.StatusOK, &state)
		if state.MaxPhotos <= 0 {
			t.Error("лимит тарифа не отдан")
		}
		if len(state.Albums) != 2 {
			t.Fatalf("альбомов %d, want 2", len(state.Albums))
		}
		if state.TotalPhotos != 2 {
			t.Errorf("всего фото %d, want 2", state.TotalPhotos)
		}
	})

	t.Run("выбор скрывает невыбранное, но не удаляет", func(t *testing.T) {
		status, body := c.do("PUT", "/api/v1/shops/"+shop.ID+"/downgrade",
			map[string]any{"album_ids": []string{keepAlbum.ID}})
		if status != http.StatusNoContent {
			t.Fatalf("status %d, want 204; body: %s", status, body)
		}
		v := visibleAlbums()
		if !v[keepAlbum.ID] {
			t.Error("выбранный альбом пропал с витрины")
		}
		if v[hideAlbum.ID] {
			t.Error("невыбранный альбом остался на витрине")
		}
		// Кабинет по-прежнему видит оба: ничего не удалено.
		var albums []struct {
			ID string `json:"id"`
		}
		c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
		if len(albums) != 2 {
			t.Fatalf("в кабинете альбомов %d, want 2 — скрытое не должно удаляться", len(albums))
		}
	})

	t.Run("скрытый тарифом не открывается и по прямой ссылке", func(t *testing.T) {
		status, _ := c.do("GET",
			fmt.Sprintf("/api/v1/public/shops/%s/albums/%s", shop.Slug, hideAlbum.ID), nil)
		if status != http.StatusNotFound {
			t.Errorf("прямая ссылка на скрытый тарифом альбом: %d, want 404", status)
		}
	})

	t.Run("чужой альбом в списке ничего не ломает", func(t *testing.T) {
		other := newClient(t)
		registerUser(other)
		otherShop := createShop(other)
		foreign := createAlbum(other, otherShop.ID)

		status, _ := c.do("PUT", "/api/v1/shops/"+shop.ID+"/downgrade",
			map[string]any{"album_ids": []string{keepAlbum.ID, foreign.ID}})
		if status != http.StatusNoContent {
			t.Fatalf("status %d, want 204", status)
		}
		// Чужой альбом не должен был стать видимым в чужой витрине.
		var page struct {
			Albums []struct {
				ID string `json:"id"`
			} `json:"albums"`
		}
		c.mustJSON("GET", "/api/v1/public/shops/"+otherShop.Slug, nil, http.StatusOK, &page)
		for _, a := range page.Albums {
			if a.ID == foreign.ID {
				continue // он и должен быть виден в СВОЁМ магазине
			}
		}
		if v := visibleAlbums(); v[foreign.ID] {
			t.Error("чужой альбом попал в нашу витрину")
		}
	})
}

// TestDowngradeRespectsPlanLimit: сервер не даёт оставить видимым больше,
// чем помещается в тариф. Кабинет блокирует кнопку, но лимит платный —
// одного запроса со списком всех альбомов быть достаточно не должно.
func TestDowngradeRespectsPlanLimit(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	// Реальные фото тут не нужны: экран понижения читает albums.photo_count.
	// Лимит тарифа free в тестовой конфигурации — 8 фотографий.
	var ids []string
	for i := 0; i < 2; i++ {
		al := createAlbum(c, shop.ID)
		ids = append(ids, al.ID)
		if _, err := env.pool.Exec(ctx,
			`UPDATE albums SET photo_count = 5 WHERE id = $1`, al.ID); err != nil {
			t.Fatalf("set photo_count: %v", err)
		}
	}

	// Оба альбома — это 10 фото при лимите 8.
	status, raw := c.do("PUT", "/api/v1/shops/"+shop.ID+"/downgrade",
		map[string]any{"album_ids": ids})
	if status != http.StatusBadRequest {
		t.Fatalf("выбор сверх лимита принят: status %d, want 400; body: %s", status, raw)
	}

	// Один альбом — 5 фото, помещается.
	c.mustJSON("PUT", "/api/v1/shops/"+shop.ID+"/downgrade",
		map[string]any{"album_ids": ids[:1]}, http.StatusNoContent, nil)

	var hidden int
	if err := env.pool.QueryRow(ctx,
		`SELECT count(*) FROM albums WHERE shop_id = $1 AND hidden_by_plan`, shop.ID).Scan(&hidden); err != nil {
		t.Fatalf("count hidden: %v", err)
	}
	if hidden != 1 {
		t.Fatalf("скрыт %d альбомов, ожидался 1", hidden)
	}
}
