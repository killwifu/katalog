package integration

import (
	"bytes"
	"net/http"
	"testing"
	"time"
)

// Обложкой нельзя сделать фото, которое не прошло обработку или удалено:
// у него нет деривативов, и обложка на витрине выходила пустой.
func TestAlbumCoverMustBeLivePhoto(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	path := "/api/v1/shops/" + shop.ID + "/albums/" + album.ID

	failed := uploadPhoto(c, shop.ID, album.ID, bytes.Repeat([]byte("x"), 5000))
	waitPhotoStatus(c, shop.ID, album.ID, failed, "failed", 30*time.Second)
	c.mustJSON("PATCH", path, map[string]string{"cover_photo_id": failed}, http.StatusBadRequest, nil)

	ready := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 60, 60))
	c.mustJSON("PATCH", path, map[string]string{"cover_photo_id": ready}, http.StatusOK, nil)

	trashed := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 61, 60))
	c.mustJSON("DELETE", "/api/v1/photos/"+trashed, nil, http.StatusNoContent, nil)
	c.mustJSON("PATCH", path, map[string]string{"cover_photo_id": trashed}, http.StatusBadRequest, nil)
}
