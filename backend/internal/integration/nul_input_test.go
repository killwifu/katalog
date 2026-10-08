package integration

import (
	"net/http"
	"testing"
)

// NUL в строке (в теле или в адресе) — 400, а не 500 от Postgres.
func TestNULCharacterRejected(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums", map[string]string{"title": "a\x00b"}, http.StatusBadRequest, nil)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID, map[string]string{"description": "x\x00"}, http.StatusBadRequest, nil)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, map[string]string{"name": "\x00"}, http.StatusBadRequest, nil)
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/search?q=a%00b", nil, http.StatusBadRequest, nil)
	c.mustJSON("GET", "/api/v1/public/shops/ab%00cd", nil, http.StatusBadRequest, nil)
	// Обычный текст с обратной косой проходит.
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums", map[string]string{"title": `a\u0000b`}, http.StatusCreated, nil)
}
