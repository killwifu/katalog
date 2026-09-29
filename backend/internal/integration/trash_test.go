package integration

import (
	"net/http"
	"testing"
)

type trashJSON struct {
	Photos   []photoJSON `json:"photos"`
	Total    int64       `json:"total"`
	KeepDays int64       `json:"keep_days"`
}

// TestTrashLifecycle: удаление обратимо и не течёт на витрину.
//
// Главное здесь — не «кнопка работает», а два инварианта, которые молча
// ломаются при правке любого запроса: удалённое фото не должно попадать
// покупателю, а место в хранилище не должно возвращаться раньше, чем
// объекты реально уйдут из S3.
func TestTrashLifecycle(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	jpeg := makeJPEG(t, 800, 600)
	keepID := uploadReadyPhoto(t, c, shop.ID, album.ID, jpeg)
	dropID := uploadReadyPhoto(t, c, shop.ID, album.ID, jpeg)

	var before shopJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &before)

	// --- удаление: фото уезжает в корзину ---
	status, body := c.do("DELETE", "/api/v1/photos/"+dropID, nil)
	if status != http.StatusNoContent {
		t.Fatalf("delete photo: status %d, body %s", status, body)
	}

	var page struct {
		Photos []photoJSON `json:"photos"`
		Total  int64       `json:"total"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/photos", nil, http.StatusOK, &page)
	if page.Total != 1 || len(page.Photos) != 1 || page.Photos[0].ID != keepID {
		t.Errorf("кабинет показывает удалённое фото: %+v", page)
	}

	var pub struct {
		Photos []photoJSON `json:"photos"`
		Total  int64       `json:"total"`
	}
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil, http.StatusOK, &pub)
	for _, p := range pub.Photos {
		if p.ID == dropID {
			t.Fatalf("удалённое фото видно покупателю: %+v", p)
		}
	}

	// Счётчик альбома снялся, а место осталось занятым: файлы ещё в S3.
	var albums []albumJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	if albums[0].PhotoCount != 1 {
		t.Errorf("photo_count = %d, want 1", albums[0].PhotoCount)
	}
	var afterDelete shopJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &afterDelete)
	if afterDelete.StorageUsed != before.StorageUsed {
		t.Errorf("место вернулось до окончательного удаления: было %d, стало %d",
			before.StorageUsed, afterDelete.StorageUsed)
	}

	var trash trashJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusOK, &trash)
	if trash.Total != 1 || len(trash.Photos) != 1 || trash.Photos[0].ID != dropID {
		t.Fatalf("корзина: %+v", trash)
	}
	if trash.KeepDays <= 0 {
		t.Errorf("keep_days = %d, want > 0", trash.KeepDays)
	}

	// --- возврат: фото снова в альбоме и на витрине ---
	status, body = c.do("POST", "/api/v1/shops/"+shop.ID+"/trash/"+dropID+"/restore", nil)
	if status != http.StatusOK {
		t.Fatalf("restore: status %d, body %s", status, body)
	}
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil, http.StatusOK, &pub)
	if pub.Total != 2 {
		t.Errorf("после возврата на витрине %d фото, want 2", pub.Total)
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	if albums[0].PhotoCount != 2 {
		t.Errorf("после возврата photo_count = %d, want 2", albums[0].PhotoCount)
	}

	// --- окончательное удаление: место возвращается ---
	if status, body = c.do("DELETE", "/api/v1/photos/"+dropID, nil); status != http.StatusNoContent {
		t.Fatalf("повторное удаление: status %d, body %s", status, body)
	}
	if status, body = c.do("DELETE", "/api/v1/shops/"+shop.ID+"/trash/"+dropID, nil); status != http.StatusNoContent {
		t.Fatalf("purge: status %d, body %s", status, body)
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusOK, &trash)
	if trash.Total != 0 {
		t.Errorf("корзина не пуста после окончательного удаления: %+v", trash)
	}
	var afterPurge shopJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &afterPurge)
	if afterPurge.StorageUsed >= before.StorageUsed {
		t.Errorf("место не вернулось: было %d, стало %d", before.StorageUsed, afterPurge.StorageUsed)
	}
}

// TestTrashTenantIsolation: чужая корзина недоступна — обязательная проверка
// для каждого приватного эндпоинта.
func TestTrashTenantIsolation(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photoID := uploadReadyPhoto(t, owner, shop.ID, album.ID, makeJPEG(t, 400, 300))
	if status, _ := owner.do("DELETE", "/api/v1/photos/"+photoID, nil); status != http.StatusNoContent {
		t.Fatalf("delete by owner failed")
	}

	stranger := newClient(t)
	registerUser(stranger)
	createShop(stranger)

	for _, tt := range []struct{ method, path string }{
		{"GET", "/api/v1/shops/" + shop.ID + "/trash"},
		{"DELETE", "/api/v1/shops/" + shop.ID + "/trash"},
		{"POST", "/api/v1/shops/" + shop.ID + "/trash/" + photoID + "/restore"},
		{"DELETE", "/api/v1/shops/" + shop.ID + "/trash/" + photoID},
	} {
		status, _ := stranger.do(tt.method, tt.path, nil)
		if status != http.StatusNotFound && status != http.StatusForbidden {
			t.Errorf("%s %s: status %d, want 404/403", tt.method, tt.path, status)
		}
	}

	// Фото осталось в корзине владельца нетронутым.
	var trash trashJSON
	owner.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusOK, &trash)
	if trash.Total != 1 {
		t.Errorf("корзина владельца пострадала: %+v", trash)
	}
}
