package integration

import (
	"os"
	"testing"
	"time"

	"katalog/backend/internal/imaging"
)

// TestHEICPipeline: айфоны снимают в HEIC по умолчанию, поэтому потеря
// поддержки HEIF в libvips (например, при пересборке образа) означала бы,
// что фотографии половины продавцов молча перестают обрабатываться.
// Тест ловит это на фикстуре — настоящем файле с камеры-формата.
func TestHEICPipeline(t *testing.T) {
	data, err := os.ReadFile("testdata/sample.heic")
	if err != nil {
		t.Fatalf("фикстура не читается: %v", err)
	}

	if format, err := imaging.DetectFormat(data); err != nil || format != "heic" {
		t.Fatalf("DetectFormat = %q, %v; want heic", format, err)
	}

	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	photo := uploadPhoto(c, shop.ID, album.ID, data)
	got := waitPhotoStatus(c, shop.ID, album.ID, photo, "ready", 60*time.Second)
	if got.Status != "ready" {
		t.Fatalf("HEIC не обработался: статус %q — проверьте, что в libvips есть heif", got.Status)
	}
	if got.Width == 0 || got.Height == 0 {
		t.Errorf("размеры не определились: %dx%d", got.Width, got.Height)
	}

	// Покупателю уходит WebP, а не исходный HEIC: браузеры его не показывают.
	var page struct {
		Photos []struct {
			Urls map[string]string `json:"urls"`
		} `json:"photos"`
	}
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil, 200, &page)
	if len(page.Photos) != 1 {
		t.Fatalf("на витрине фото %d, want 1", len(page.Photos))
	}
	for size, url := range page.Photos[0].Urls {
		if len(url) < 5 || url[len(url)-5:] != ".webp" {
			t.Errorf("дериватив %s не webp: %s", size, url)
		}
	}
}
