package integration

import (
	"net/http"
	"testing"
)

// Перенос альбомов в подкатегорию удаляемой категории запрещён: подкатегория
// уходит каскадом, и альбомы молча оставались без категории (ответ был 204).
func TestDeleteCategoryMoveIntoOwnChildRejected(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	base := "/api/v1/shops/" + shop.ID
	var parent, child struct {
		ID string `json:"id"`
	}
	c.mustJSON("POST", base+"/categories", map[string]string{"title": "Родитель", "slug": "parent"}, http.StatusCreated, &parent)
	c.mustJSON("POST", base+"/categories", map[string]any{"title": "Дочь", "slug": "child", "parent_id": parent.ID}, http.StatusCreated, &child)
	album := createAlbum(c, shop.ID)
	c.mustJSON("PUT", base+"/categories/"+parent.ID+"/albums/"+album.ID, nil, http.StatusNoContent, nil)

	c.mustJSON("DELETE", base+"/categories/"+parent.ID+"?move_to="+child.ID, nil, http.StatusBadRequest, nil)
	var got struct {
		CategoryIDs []string `json:"category_ids"`
	}
	c.mustJSON("GET", base+"/albums/"+album.ID, nil, http.StatusOK, &got)
	if len(got.CategoryIDs) != 1 || got.CategoryIDs[0] != parent.ID {
		t.Fatalf("album categories after rejected delete = %v, want [%s]", got.CategoryIDs, parent.ID)
	}
}
