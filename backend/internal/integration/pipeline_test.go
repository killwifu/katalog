package integration

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/storage"
)

// TestFullPipeline — полный путь: presign -> PUT в MinIO -> confirm ->
// asynq -> воркер (govips) -> ready + деривативы в бакете + квота обновлена.
func TestFullPipeline(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	jpeg := makeJPEG(t, 1200, 900)
	photoID := uploadPhoto(c, shop.ID, album.ID, jpeg)

	photo := waitPhotoStatus(c, shop.ID, album.ID, photoID, "ready", 30*time.Second)

	if photo.Width != 1200 || photo.Height != 900 {
		t.Errorf("dimensions: %dx%d, want 1200x900", photo.Width, photo.Height)
	}
	for _, key := range []string{"thumb", "medium", "large"} {
		if photo.Urls[key] == "" {
			t.Errorf("missing %s url in ready photo", key)
		}
	}

	// Деривативы существуют в бакете и не пустые.
	ctx := context.Background()
	pid := uuid.MustParse(photoID)
	sid := uuid.MustParse(shop.ID)
	for _, size := range imagingmeta.DerivativeSizes {
		key := storage.DerivativeKey(sid, pid, size)
		n, exists, err := env.store.StatSize(ctx, key)
		if err != nil {
			t.Fatalf("stat %s: %v", key, err)
		}
		if !exists || n == 0 {
			t.Errorf("derivative %s: exists=%v size=%d, want non-empty object", key, exists, n)
		}
	}

	// pHash записан.
	dbPhoto, err := env.q.GetPhoto(ctx, pid)
	if err != nil {
		t.Fatalf("load photo from db: %v", err)
	}
	if !dbPhoto.Phash.Valid {
		t.Error("phash is not set on ready photo")
	}

	// Квота: оригинал + деривативы.
	var updated shopJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &updated)
	if updated.StorageUsed < int64(len(jpeg)) {
		t.Errorf("storage_used = %d, want at least original size %d", updated.StorageUsed, len(jpeg))
	}

	// Счётчик альбома.
	var albums []albumJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	if len(albums) != 1 || albums[0].PhotoCount != 1 {
		t.Errorf("album photo_count: %+v, want 1", albums)
	}

	// Деривативы публично доступны напрямую (эмуляция CDN-пути).
	resp, err := http.Get(env.store.PublicDerivativeURL(sid, pid, 300))
	if err != nil {
		t.Fatalf("GET derivative: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("anonymous GET derivative: status %d, want 200", resp.StatusCode)
	}
}

// TestDecompressionBomb: крошечный PNG, заявляющий 500 мегапикселей,
// должен быть отклонён ДО декодирования.
func TestDecompressionBomb(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	bomb := makePNGBomb(25000, 20000)
	photoID := uploadPhoto(c, shop.ID, album.ID, bomb)

	photo := waitPhotoStatus(c, shop.ID, album.ID, photoID, "failed", 30*time.Second)
	if photo.Status != "failed" {
		t.Fatalf("bomb photo status = %s, want failed", photo.Status)
	}
}

// TestFakeJpeg: текстовый файл под видом .jpg отклоняется по magic bytes.
func TestFakeJpeg(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	fake := []byte("this is definitely not a jpeg, just text with .jpg extension")
	photoID := uploadPhoto(c, shop.ID, album.ID, fake)

	waitPhotoStatus(c, shop.ID, album.ID, photoID, "failed", 30*time.Second)
}

// TestConfirmWithoutUpload: confirm без загрузки объекта -> per-item ошибка.
func TestConfirmWithoutUpload(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000},
		http.StatusOK, &pre)

	var confirm struct {
		Results []struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		} `json:"results"`
	}
	c.mustJSON("POST", "/api/v1/photos/confirm",
		map[string]any{"shop_id": shop.ID, "photo_ids": []string{pre.PhotoID}},
		http.StatusOK, &confirm)
	if len(confirm.Results) != 1 || confirm.Results[0].Status != "error" {
		t.Fatalf("confirm without upload: %+v, want error", confirm.Results)
	}
}

// TestQuotaExceeded: presign сверх лимита тарифа -> 403 quota_exceeded.
func TestQuotaExceeded(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	// Забиваем квоту почти до предела напрямую в БД.
	_, err := env.pool.Exec(context.Background(),
		"UPDATE shops SET storage_used = $2 WHERE id = $1",
		shop.ID, shop.StorageMax-100)
	if err != nil {
		t.Fatalf("set storage_used: %v", err)
	}

	status, body := c.do("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000})
	if status != http.StatusForbidden {
		t.Fatalf("presign over quota: status %d, want 403; body: %s", status, body)
	}
}

// TestFailReasonReachesSeller: причина отказа доезжает до продавца.
// Раньше она только писалась в лог воркера, а в кабинете все провалы
// выглядели одинаково — в пачке из трёхсот снимков по такому сообщению
// нечего чинить.
func TestFailReasonReachesSeller(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	// Декомпрессионная бомба: заголовок обещает сотни мегапикселей.
	photoID := uploadPhoto(c, shop.ID, album.ID, makePNGBomb(30000, 30000))
	photo := waitPhotoStatus(c, shop.ID, album.ID, photoID, "failed", 30*time.Second)
	if photo.FailReason != "too_large" {
		t.Fatalf("причина отказа %q, ожидалась too_large", photo.FailReason)
	}

	// Мусор вместо картинки — другая причина.
	garbage := uploadPhoto(c, shop.ID, album.ID, []byte("это точно не картинка"))
	photo = waitPhotoStatus(c, shop.ID, album.ID, garbage, "failed", 30*time.Second)
	if photo.FailReason != "unsupported_format" {
		t.Fatalf("причина отказа %q, ожидалась unsupported_format", photo.FailReason)
	}
}

// TestConfirmAssignsPhotoOrder: порядок фотографий в альбоме задаёт продавец,
// а не гонка загрузок.
//
// sort_order на presign всегда ставился в 0, поэтому выдача падала на
// created_at — то есть на то, в каком порядке до сервера доехали запросы.
// Загрузчик шлёт их пачками по нескольку штук параллельно, так что внутри
// каждой пачки порядок случайный: все ракурсы одной модели, загруженные
// разом, раскладывались как попало. Переставить фото вручную нельзя —
// ни ручки, ни эндпоинта для этого нет.
func TestConfirmAssignsPhotoOrder(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	// Три файла загружены, но ещё не подтверждены.
	ids := []string{
		presignAndPut(t, c, shop.ID, album.ID, makeJPEG(t, 320, 240)),
		presignAndPut(t, c, shop.ID, album.ID, makeJPEG(t, 320, 241)),
		presignAndPut(t, c, shop.ID, album.ID, makeJPEG(t, 320, 242)),
	}
	// Продавец подтверждает их в своём порядке: третий, первый, второй.
	want := []string{ids[2], ids[0], ids[1]}
	c.mustJSON("POST", "/api/v1/photos/confirm",
		map[string]any{"shop_id": shop.ID, "photo_ids": want}, http.StatusOK, nil)

	var page struct {
		Photos []struct {
			ID        string `json:"id"`
			SortOrder int32  `json:"sort_order"`
		} `json:"photos"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/photos",
		nil, http.StatusOK, &page)

	got := make([]string, 0, len(page.Photos))
	for _, p := range page.Photos {
		got = append(got, p.ID)
	}
	if len(got) != len(want) {
		t.Fatalf("фотографий %d, ожидалось %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("порядок в альбоме %v, ожидался порядок подтверждения %v", got, want)
		}
	}
}
