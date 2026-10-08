package integration

import (
	"net/http"
	"strings"
	"testing"
)

func albumPhotoIDs(t *testing.T, c *client, shopID, albumID, query string) []string {
	t.Helper()
	var page struct {
		Photos []photoJSON `json:"photos"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shopID+"/albums/"+albumID+"/photos"+query, nil, http.StatusOK, &page)
	ids := make([]string, len(page.Photos))
	for i, p := range page.Photos {
		ids[i] = p.ID
	}
	return ids
}

// TestPhotoOrder: продавец перетаскивает фото, и порядок доезжает и до
// кабинета, и до покупателя. Отдельно — перестановка на одной странице:
// она не должна трогать фото с соседних страниц.
func TestPhotoOrder(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	jpeg := makeJPEG(t, 400, 300)
	var ids []string
	for i := 0; i < 5; i++ {
		ids = append(ids, uploadReadyPhoto(t, c, shop.ID, album.ID, jpeg))
	}
	orderPath := "/api/v1/shops/" + shop.ID + "/albums/" + album.ID + "/photos/order"

	// Каждая догрузка встаёт сразу после обложки, поэтому пять загрузок по
	// одной дают: обложка, затем от свежих к старым.
	initial := []string{ids[0], ids[4], ids[3], ids[2], ids[1]}
	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); strings.Join(got, ",") != strings.Join(initial, ",") {
		t.Fatalf("исходный порядок %v, ожидался %v", got, initial)
	}

	// --- альбом целиком: разворот ---
	reversed := []string{ids[4], ids[3], ids[2], ids[1], ids[0]}
	if status, body := c.do("PUT", orderPath, map[string]any{"photo_ids": reversed}); status != http.StatusNoContent {
		t.Fatalf("set order: status %d, body %s", status, body)
	}
	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); strings.Join(got, ",") != strings.Join(reversed, ",") {
		t.Errorf("кабинет: порядок %v, ожидался %v", got, reversed)
	}
	var pub struct {
		Photos []photoJSON `json:"photos"`
	}
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil, http.StatusOK, &pub)
	for i, p := range pub.Photos {
		if p.ID != reversed[i] {
			t.Errorf("витрина: на месте %d фото %s, ожидалось %s", i, p.ID, reversed[i])
		}
	}

	// --- только вторая страница (по два фото): первая и третья не едут ---
	// Сейчас порядок 4 3 2 1 0; на второй странице лежат 2 и 1.
	if status, body := c.do("PUT", orderPath, map[string]any{"photo_ids": []string{ids[1], ids[2]}}); status != http.StatusNoContent {
		t.Fatalf("set page order: status %d, body %s", status, body)
	}
	want := []string{ids[4], ids[3], ids[1], ids[2], ids[0]}
	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("после перестановки страницы порядок %v, ожидался %v", got, want)
	}

	// --- мусор на входе ---
	for name, body := range map[string]any{
		"пустой список": map[string]any{"photo_ids": []string{}},
		"не uuid":       map[string]any{"photo_ids": []string{"nope"}},
		"повтор":        map[string]any{"photo_ids": []string{ids[0], ids[0]}},
	} {
		if status, _ := c.do("PUT", orderPath, body); status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, status)
		}
	}
}

// Чужой альбом переставить нельзя, а чужие фото в своём запросе не
// сдвигаются: запрос ограничен и магазином, и альбомом.
func TestPhotoOrderTenantIsolation(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	jpeg := makeJPEG(t, 400, 300)
	first := uploadReadyPhoto(t, owner, shop.ID, album.ID, jpeg)
	second := uploadReadyPhoto(t, owner, shop.ID, album.ID, jpeg)

	stranger := newClient(t)
	registerUser(stranger)
	theirShop := createShop(stranger)
	theirAlbum := createAlbum(stranger, theirShop.ID)
	theirPhoto := uploadReadyPhoto(t, stranger, theirShop.ID, theirAlbum.ID, jpeg)

	swapped := map[string]any{"photo_ids": []string{second, first}}

	// Чужой магазин в адресе.
	status, _ := stranger.do("PUT", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/photos/order", swapped)
	if status != http.StatusNotFound && status != http.StatusForbidden {
		t.Errorf("чужой магазин: status %d, want 404/403", status)
	}
	// Свой магазин, чужой альбом.
	status, _ = stranger.do("PUT", "/api/v1/shops/"+theirShop.ID+"/albums/"+album.ID+"/photos/order", swapped)
	if status != http.StatusNotFound && status != http.StatusForbidden {
		t.Errorf("чужой альбом: status %d, want 404/403", status)
	}
	// Свой альбом, чужие фото в списке: запрос проходит, но их не трогает.
	status, _ = stranger.do("PUT", "/api/v1/shops/"+theirShop.ID+"/albums/"+theirAlbum.ID+"/photos/order",
		map[string]any{"photo_ids": []string{second, theirPhoto, first}})
	if status != http.StatusNoContent {
		t.Errorf("свой альбом с чужими id: status %d, want 204", status)
	}

	if got := albumPhotoIDs(t, owner, shop.ID, album.ID, ""); len(got) != 2 || got[0] != first || got[1] != second {
		t.Errorf("порядок владельца изменился: %v", got)
	}
}

// TestNewPhotosLandAfterCover: догруженная пачка встаёт сразу после обложки
// и внутри себя сохраняет порядок, в каком продавец выбрал файлы; то, что
// было в альбоме раньше, уезжает за неё.
func TestNewPhotosLandAfterCover(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	jpeg := makeJPEG(t, 400, 300)

	// Первая пачка в пустой альбом: порядок как в запросе, первое — обложка.
	old := []string{
		putPhoto(c, shop.ID, album.ID, jpeg),
		putPhoto(c, shop.ID, album.ID, jpeg),
		putPhoto(c, shop.ID, album.ID, jpeg),
	}
	// Подтверждаем не в том порядке, в каком выдавались ссылки: место
	// определяет список в запросе, а не время создания.
	firstBatch := []string{old[2], old[0], old[1]}
	confirmPhotos(c, shop.ID, firstBatch)
	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); strings.Join(got, ",") != strings.Join(firstBatch, ",") {
		t.Fatalf("первая пачка: порядок %v, ожидался %v", got, firstBatch)
	}

	fresh := []string{
		putPhoto(c, shop.ID, album.ID, jpeg),
		putPhoto(c, shop.ID, album.ID, jpeg),
	}
	confirmPhotos(c, shop.ID, fresh)
	want := []string{firstBatch[0], fresh[0], fresh[1], firstBatch[1], firstBatch[2]}
	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("догрузка: порядок %v, ожидался %v", got, want)
	}

	// Повторное подтверждение ничего не двигает.
	var again struct {
		Results []struct {
			Status string `json:"status"`
		} `json:"results"`
	}
	c.mustJSON("POST", "/api/v1/photos/confirm",
		map[string]any{"shop_id": shop.ID, "photo_ids": fresh}, http.StatusOK, &again)
	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("после повторного подтверждения порядок %v, ожидался %v", got, want)
	}
}
