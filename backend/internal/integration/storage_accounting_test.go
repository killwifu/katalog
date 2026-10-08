package integration

import (
	"bytes"
	"net/http"
	"testing"
	"time"
)

func shopStorageUsed(c *client, shopID string) int64 {
	c.t.Helper()
	var s shopJSON
	c.mustJSON("GET", "/api/v1/shops/"+shopID, nil, http.StatusOK, &s)
	return s.StorageUsed
}

// Файл не прошёл проверку — его байты не должны занимать тариф. Раньше
// оригинал «не картинки» оставался учтённым, пока продавец сам не удалит
// фото и не очистит корзину.
func TestFailedPhotoReleasesStorage(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	junk := bytes.Repeat([]byte("A"), 200_000)
	id := uploadPhoto(c, shop.ID, album.ID, junk)
	waitPhotoStatus(c, shop.ID, album.ID, id, "failed", 30*time.Second)
	if got := shopStorageUsed(c, shop.ID); got != 0 {
		t.Fatalf("storage_used after failed processing = %d, want 0", got)
	}
	// Удаление и очистка корзины не уводят счётчик в минус и не трогают чужие байты.
	c.mustJSON("DELETE", "/api/v1/photos/"+id, nil, http.StatusNoContent, nil)
	c.mustJSON("DELETE", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusNoContent, nil)
	if got := shopStorageUsed(c, shop.ID); got != 0 {
		t.Fatalf("storage_used after purge = %d, want 0", got)
	}
}

// Фото, не дошедшее до confirm, в счётчике не учтено — и его удаление не
// должно списывать байты других фотографий (раньше списывался заявленный размер).
func TestPurgeUnconfirmedPhotoKeepsStorage(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 120, 90))
	before := shopStorageUsed(c, shop.ID)
	if before == 0 {
		t.Fatal("ready photo is not accounted")
	}
	// Неподтверждённое фото — в другом альбоме; удаляем этот альбом и чистим корзину.
	other := createAlbum(c, shop.ID)
	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": other.ID, "size": 5_000_000}, http.StatusOK, &pre)
	c.mustJSON("DELETE", "/api/v1/shops/"+shop.ID+"/albums/"+other.ID, nil, http.StatusNoContent, nil)
	c.mustJSON("DELETE", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusNoContent, nil)
	if got := shopStorageUsed(c, shop.ID); got != before {
		t.Fatalf("storage_used after purging unconfirmed photo = %d, want %d", got, before)
	}
}
