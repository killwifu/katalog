package integration

import (
	"net/http"
	"testing"
	"time"
)

// drainRevalidated очищает канал вебхуков перед проверяемым действием.
func drainRevalidated() {
	for {
		select {
		case <-env.revalidated:
		default:
			return
		}
	}
}

// waitRevalidated ждёт вебхук ревалидации для слага не дольше timeout.
func waitRevalidated(t *testing.T, slug string, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case got := <-env.revalidated:
			if got == slug {
				return
			}
		case <-deadline:
			t.Fatalf("no revalidate webhook for %q within %s", slug, timeout)
		}
	}
}

// TestRevalidateOnPhotoReady — приёмка этапа: «загрузил фото → витрина
// обновилась ≤ 60 сек». Вебхук Go -> Next обязан прийти в пределах минуты
// после подтверждения загрузки (на витрине его дублирует TTL-фолбэк 60с).
func TestRevalidateOnPhotoReady(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	drainRevalidated()
	start := time.Now()
	photoID := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 640, 480))
	waitRevalidated(t, shop.Slug, 60*time.Second)
	t.Logf("revalidate webhook after photo upload: %s", time.Since(start))

	// Фото при этом действительно ready.
	waitPhotoStatus(c, shop.ID, album.ID, photoID, "ready", 60*time.Second)
}

// TestRevalidateOnShopAndAlbumChanges: изменения магазина и альбомов
// тоже инвалидируют витрину.
func TestRevalidateOnShopAndAlbumChanges(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	drainRevalidated()
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID,
		map[string]any{"name": "Новое имя"}, http.StatusOK, nil)
	waitRevalidated(t, shop.Slug, 10*time.Second)

	drainRevalidated()
	album := createAlbum(c, shop.ID)
	waitRevalidated(t, shop.Slug, 10*time.Second)

	drainRevalidated()
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID,
		map[string]any{"title": "Переименован"}, http.StatusOK, nil)
	waitRevalidated(t, shop.Slug, 10*time.Second)
}
