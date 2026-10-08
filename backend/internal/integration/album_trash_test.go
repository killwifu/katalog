package integration

import (
	"net/http"
	"strings"
	"testing"
)

type trashWithAlbums struct {
	Albums []struct {
		ID         string `json:"id"`
		Title      string `json:"title"`
		PhotoCount int32  `json:"photo_count"`
	} `json:"albums"`
	Photos []photoJSON `json:"photos"`
	Total  int64       `json:"total"`
}

// TestAlbumTrash: удаление альбома обратимо. Альбом с фотографиями уходит
// в «Удаленное», пропадает из кабинета и с витрины, а восстановление
// возвращает его целиком — кроме фото, удалённых раньше по отдельности.
func TestAlbumTrash(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	jpeg := makeJPEG(t, 400, 300)
	keep := uploadReadyPhoto(t, c, shop.ID, album.ID, jpeg)
	early := uploadReadyPhoto(t, c, shop.ID, album.ID, jpeg)
	setCaption(c, keep, "Пуховик корзинный")
	albumPath := "/api/v1/shops/" + shop.ID + "/albums/" + album.ID
	c.mustJSON("PATCH", albumPath, map[string]any{"status": "published"}, http.StatusOK, nil)
	pubPath := "/api/v1/public/shops/" + shop.Slug + "/albums/" + album.ID

	// Одно фото удалено раньше, отдельно.
	if status, _ := c.do("DELETE", "/api/v1/photos/"+early, nil); status != http.StatusNoContent {
		t.Fatalf("delete photo failed")
	}
	var before shopJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &before)

	// --- удаление альбома ---
	if status, body := c.do("DELETE", albumPath, nil); status != http.StatusNoContent {
		t.Fatalf("delete album: status %d, body %s", status, body)
	}
	var albums []albumJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	if len(albums) != 0 {
		t.Errorf("удалённый альбом остался в кабинете: %+v", albums)
	}
	for _, probe := range []struct{ method, path string }{
		{"GET", albumPath}, {"PATCH", albumPath}, {"GET", albumPath + "/photos"},
	} {
		if status, _ := c.do(probe.method, probe.path, map[string]any{"title": "x"}); status != http.StatusNotFound {
			t.Errorf("%s %s по удалённому альбому: status %d, want 404", probe.method, probe.path, status)
		}
	}
	if status, _ := c.do("GET", pubPath, nil); status != http.StatusNotFound {
		t.Errorf("удалённый альбом открыт на витрине: status %d", status)
	}
	_, shopRaw := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
	if strings.Contains(string(shopRaw), album.ID) {
		t.Errorf("удалённый альбом в сетке витрины: %s", shopRaw)
	}
	_, found := c.do("GET", "/api/v1/public/shops/"+shop.Slug+"/search?q=%D0%BF%D1%83%D1%85%D0%BE%D0%B2%D0%B8%D0%BA", nil)
	if strings.Contains(string(found), keep) {
		t.Errorf("фото удалённого альбома в поиске: %s", found)
	}

	// Корзина: альбом одной строкой, отдельно — только фото, удалённое раньше.
	var trash trashWithAlbums
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusOK, &trash)
	if len(trash.Albums) != 1 || trash.Albums[0].ID != album.ID {
		t.Fatalf("альбома нет в корзине: %+v", trash)
	}
	if len(trash.Photos) != 0 {
		t.Errorf("фото удалённого альбома показаны в корзине по отдельности: %+v", trash.Photos)
	}
	// Вернуть фото в удалённый альбом нельзя.
	if status, _ := c.do("POST", "/api/v1/shops/"+shop.ID+"/trash/"+early+"/restore", nil); status != http.StatusNotFound {
		t.Errorf("фото вернулось в удалённый альбом: status %d", status)
	}
	// Место не освободилось: файлы в S3 на месте.
	var after shopJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &after)
	if after.StorageUsed != before.StorageUsed {
		t.Errorf("место изменилось при удалении в корзину: было %d, стало %d", before.StorageUsed, after.StorageUsed)
	}

	// --- чужой не восстановит и не добьёт ---
	stranger := newClient(t)
	registerUser(stranger)
	createShop(stranger)
	for _, probe := range []struct{ method, path string }{
		{"POST", "/api/v1/shops/" + shop.ID + "/trash/albums/" + album.ID + "/restore"},
		{"DELETE", "/api/v1/shops/" + shop.ID + "/trash/albums/" + album.ID},
	} {
		status, _ := stranger.do(probe.method, probe.path, nil)
		if status != http.StatusNotFound && status != http.StatusForbidden {
			t.Errorf("%s %s: status %d, want 404/403", probe.method, probe.path, status)
		}
	}

	// --- восстановление ---
	if status, body := c.do("POST", "/api/v1/shops/"+shop.ID+"/trash/albums/"+album.ID+"/restore", nil); status != http.StatusOK {
		t.Fatalf("restore album: status %d, body %s", status, body)
	}
	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); len(got) != 1 || got[0] != keep {
		t.Errorf("после восстановления в альбоме %v, ожидалось только %s", got, keep)
	}
	var pub pubAlbumPage
	c.mustJSON("GET", pubPath, nil, http.StatusOK, &pub)
	if len(pub.Photos) != 1 {
		t.Errorf("после восстановления витрина показывает %d фото", len(pub.Photos))
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusOK, &trash)
	if len(trash.Albums) != 0 || len(trash.Photos) != 1 || trash.Photos[0].ID != early {
		t.Errorf("корзина после восстановления: %+v", trash)
	}

	// --- окончательное удаление возвращает место ---
	if status, _ := c.do("DELETE", albumPath, nil); status != http.StatusNoContent {
		t.Fatalf("second delete failed")
	}
	if status, body := c.do("DELETE", "/api/v1/shops/"+shop.ID+"/trash/albums/"+album.ID, nil); status != http.StatusNoContent {
		t.Fatalf("purge album: status %d, body %s", status, body)
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &after)
	if after.StorageUsed != 0 {
		t.Errorf("после окончательного удаления занято %d байт", after.StorageUsed)
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusOK, &trash)
	if len(trash.Albums) != 0 || len(trash.Photos) != 0 {
		t.Errorf("корзина не пуста после окончательного удаления: %+v", trash)
	}
}
