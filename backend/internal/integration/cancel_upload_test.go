package integration

import (
	"net/http"
	"testing"
)

// TestCancelUpload: «Остановить» посреди пачки. Фото, на которое ссылка
// выдана, а подтверждения не было, убирается совсем: не висит в альбоме,
// не лежит в корзине и не занимает лимит фото.
func TestCancelUpload(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	ready := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 400, 300))

	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000},
		http.StatusOK, &pre)

	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); len(got) != 2 {
		t.Fatalf("после presign в альбоме %d строк, ожидалось 2", len(got))
	}

	if status, body := c.do("DELETE", "/api/v1/photos/"+pre.PhotoID, nil); status != http.StatusNoContent {
		t.Fatalf("cancel upload: status %d, body %s", status, body)
	}

	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); len(got) != 1 || got[0] != ready {
		t.Errorf("отменённая загрузка осталась в альбоме: %v", got)
	}
	var trash trashJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusOK, &trash)
	if trash.Total != 0 {
		t.Errorf("отменённая загрузка попала в корзину: %+v", trash)
	}
	// Повторная отмена — уже нечего отменять.
	if status, _ := c.do("DELETE", "/api/v1/photos/"+pre.PhotoID, nil); status != http.StatusNotFound {
		t.Errorf("повторная отмена: status %d, want 404", status)
	}

	// Готовое фото по-прежнему уходит в корзину, а не исчезает.
	if status, _ := c.do("DELETE", "/api/v1/photos/"+ready, nil); status != http.StatusNoContent {
		t.Fatalf("delete ready photo failed")
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/trash", nil, http.StatusOK, &trash)
	if trash.Total != 1 {
		t.Errorf("готовое фото не попало в корзину: %+v", trash)
	}

	// Чужую незавершённую загрузку отменить нельзя.
	c.mustJSON("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000},
		http.StatusOK, &pre)
	stranger := newClient(t)
	registerUser(stranger)
	createShop(stranger)
	if status, _ := stranger.do("DELETE", "/api/v1/photos/"+pre.PhotoID, nil); status != http.StatusNotFound && status != http.StatusForbidden {
		t.Errorf("чужая отмена: status %d, want 404/403", status)
	}
	if got := albumPhotoIDs(t, c, shop.ID, album.ID, ""); len(got) != 1 || got[0] != pre.PhotoID {
		t.Errorf("чужая отмена сработала: %v", got)
	}
}
