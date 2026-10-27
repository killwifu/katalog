package integration

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestAlbumWatermark: у альбома свой знак (макет 11–13) — задаётся при
// создании и изменении, null возвращает к знаку магазина, неверное
// положение отклоняется; чужой альбом не меняется.
func TestAlbumWatermark(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	makePaid(t, shop.ID)

	type wm struct {
		Enabled  bool   `json:"enabled"`
		Position string `json:"position"`
	}
	var created struct {
		ID        string `json:"id"`
		Watermark *wm    `json:"watermark"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Со знаком", "watermark": map[string]any{"enabled": true, "position": "tl"}},
		http.StatusCreated, &created)
	if created.Watermark == nil || !created.Watermark.Enabled || created.Watermark.Position != "tl" {
		t.Fatalf("created watermark = %+v, want enabled tl", created.Watermark)
	}

	var updated struct {
		Watermark *wm `json:"watermark"`
	}
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+created.ID,
		map[string]any{"watermark": map[string]any{"enabled": false, "position": "br"}}, http.StatusOK, &updated)
	if updated.Watermark == nil || updated.Watermark.Enabled {
		t.Fatalf("updated watermark = %+v, want disabled", updated.Watermark)
	}
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+created.ID,
		map[string]any{"watermark": nil}, http.StatusOK, &updated)
	if updated.Watermark != nil {
		t.Fatalf("reset watermark = %+v, want null (as shop)", updated.Watermark)
	}
	if st, _ := c.do("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+created.ID,
		map[string]any{"watermark": map[string]any{"enabled": true, "position": "middle"}}); st != http.StatusBadRequest {
		t.Fatalf("bad position: status %d, want 400", st)
	}

	// Отказ по знаку ничего не меняет: ни новое название (PATCH), ни сам
	// альбом (POST) — раньше 400 приходил уже после записи.
	if st, _ := c.do("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+created.ID,
		map[string]any{"title": "Переименован", "watermark": map[string]any{"enabled": true, "position": "zz"}}); st != http.StatusBadRequest {
		t.Fatalf("bad position with title: status %d, want 400", st)
	}
	var got struct {
		Title string `json:"title"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums/"+created.ID, nil, http.StatusOK, &got)
	if got.Title != "Со знаком" {
		t.Fatalf("title after rejected PATCH = %q, want unchanged", got.Title)
	}
	if st, _ := c.do("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Не создастся", "watermark": map[string]any{"enabled": true, "position": "zz"}}); st != http.StatusBadRequest {
		t.Fatalf("create with bad watermark: status %d, want 400", st)
	}
	var list []struct {
		Title string `json:"title"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &list)
	for _, al := range list {
		if al.Title == "Не создастся" {
			t.Fatal("album was created despite 400 on watermark")
		}
	}

	// Чужой альбом: 404, знак не меняется.
	other := newClient(t)
	registerUser(other)
	otherShop := createShop(other)
	if st, _ := other.do("PATCH", "/api/v1/shops/"+otherShop.ID+"/albums/"+created.ID,
		map[string]any{"watermark": map[string]any{"enabled": true, "position": "tl"}}); st != http.StatusNotFound {
		t.Fatalf("foreign album: status %d, want 404", st)
	}
}

// TestAlbumWatermarkAppliedByWorker: у магазина знак включён, у одного
// альбома свой — выключен. Одно и то же фото в двух альбомах даёт разные
// деривативы: в «своём» альбоме знака нет.
func TestAlbumWatermarkAppliedByWorker(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	makePaid(t, shop.ID)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, map[string]any{"settings": map[string]any{
		"watermark": map[string]any{"enabled": true, "text": "QA WATERMARK", "opacity": 1, "position": "br"},
	}}, http.StatusOK, nil)

	withShop := createAlbum(c, shop.ID)
	var off struct {
		ID string `json:"id"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Без знака", "watermark": map[string]any{"enabled": false, "position": "br"}},
		http.StatusCreated, &off)

	img := makeJPEG(t, 1200, 900)
	a := uploadReadyPhoto(t, c, shop.ID, withShop.ID, img)
	b := uploadReadyPhoto(t, c, shop.ID, off.ID, img)

	read := func(photoID string) []byte {
		t.Helper()
		key := "drv/" + shop.ID + "/" + photoID + "/large.webp"
		data, err := env.store.Download(t.Context(), key)
		if err != nil {
			t.Fatalf("download %s: %v", key, err)
		}
		return data
	}
	if string(read(a)) == string(read(b)) {
		t.Fatal("derivatives are identical: album watermark override (enabled=false) was ignored")
	}
}

// TestAlbumWatermarkRerendersReadyPhotos: знак «запекается» в деривативы,
// поэтому выключение знака альбома перерисовывает уже готовые фото, а адрес
// картинки меняется (?v=N) — иначе кеш на год показывал бы старый знак.
// Заодно — несколько точек и «по всему кадру» проходят проверку.
func TestAlbumWatermarkRerendersReadyPhotos(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	makePaid(t, shop.ID)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, map[string]any{"settings": map[string]any{
		"watermark": map[string]any{"enabled": true, "text": "QA WATERMARK", "opacity": 1, "position": "tl,br"},
	}}, http.StatusOK, nil)
	album := createAlbum(c, shop.ID)
	photo := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 1200, 900))
	key := "drv/" + shop.ID + "/" + photo + "/large.webp"
	before, err := env.store.Download(t.Context(), key)
	if err != nil {
		t.Fatalf("download: %v", err)
	}

	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID,
		map[string]any{"watermark": map[string]any{"enabled": true, "position": "tile"}}, http.StatusOK, nil)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID,
		map[string]any{"watermark": map[string]any{"enabled": false, "position": "br"}}, http.StatusOK, nil)

	deadline := time.Now().Add(30 * time.Second)
	for {
		var page struct {
			Photos []struct {
				Urls map[string]string `json:"urls"`
			} `json:"photos"`
		}
		c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/photos", nil, http.StatusOK, &page)
		photos := page.Photos
		after, err := env.store.Download(t.Context(), key)
		if err != nil {
			t.Fatalf("download: %v", err)
		}
		if len(photos) == 1 && strings.HasSuffix(photos[0].Urls["large"], "?v=2") && !bytes.Equal(before, after) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("photo not rerendered: url %v, derivative changed %v", photos, !bytes.Equal(before, after))
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Без знака дериватив совпадает с обработкой без знака вовсе.
	off := createAlbum(c, shop.ID)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+off.ID,
		map[string]any{"watermark": map[string]any{"enabled": false, "position": "br"}}, http.StatusOK, nil)
	plainID := uploadReadyPhoto(t, c, shop.ID, off.ID, makeJPEG(t, 1200, 900))
	plain, _ := env.store.Download(t.Context(), "drv/"+shop.ID+"/"+plainID+"/large.webp")
	after, _ := env.store.Download(t.Context(), key)
	if !bytes.Equal(plain, after) {
		t.Fatal("after disabling watermark the derivative still differs from an unmarked one")
	}

	if st, _ := c.do("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID,
		map[string]any{"watermark": map[string]any{"enabled": true, "position": "tl,tl"}}); st != http.StatusBadRequest {
		t.Fatalf("duplicate cells: status %d, want 400", st)
	}
}
