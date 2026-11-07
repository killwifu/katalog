package integration

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"net/http"
	"strings"
	"testing"
)

func TestPublicPhotoByID(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	parent := createAlbum(owner, shop.ID)
	var album albumJSON
	owner.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums", map[string]any{"title": "Child", "parent_id": parent.ID}, http.StatusCreated, &album)
	mustExec(t, `INSERT INTO photos (shop_id, album_id, status, sort_order, caption, width, height)
 SELECT $1, $2, 'ready', n, 'Photo ' || n, 800, 600 FROM generate_series(1, 61) n`, shop.ID, album.ID)
	var id string
	if err := env.pool.QueryRow(context.Background(), "SELECT id FROM photos WHERE album_id = $1 AND sort_order = 61", album.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	buyer := newClient(t)
	base := "/api/v1/public/shops/" + shop.Slug + "/albums/" + album.ID
	path := base + "/photos/" + id
	var first pubAlbumPage
	buyer.mustJSON("GET", base, nil, http.StatusOK, &first)
	if len(first.Photos) != 60 {
		t.Fatalf("first page: %d", len(first.Photos))
	}
	for _, p := range first.Photos {
		if p.ID == id {
			t.Fatal("fixture photo must be beyond first page")
		}
	}
	var photo map[string]json.RawMessage
	buyer.mustJSON("GET", path, nil, http.StatusOK, &photo)
	for _, key := range []string{"id", "album_id", "caption", "width", "height", "urls"} {
		if _, ok := photo[key]; !ok {
			t.Fatalf("missing %s", key)
		}
	}
	if len(photo) != 6 {
		t.Fatalf("unexpected public fields: %v", photo)
	}
	var got photoJSON
	raw, _ := json.Marshal(photo)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.ID != id || got.AlbumID != album.ID || got.Caption != "Photo 61" || got.Width != 800 || got.Height != 600 || len(got.Urls) != 3 {
		t.Fatalf("wrong public photo: %+v", got)
	}
	for _, url := range got.Urls {
		if !strings.Contains(url, id) || !strings.Contains(url, ".webp") {
			t.Fatalf("not derivative: %s", url)
		}
	}
	otherOwner := newClient(t)
	registerUser(otherOwner)
	otherShop := createShop(otherOwner)
	otherAlbum := createAlbum(owner, shop.ID)
	for _, badPath := range []string{
		"/api/v1/public/shops/" + otherShop.Slug + "/albums/" + album.ID + "/photos/" + id,
		"/api/v1/public/shops/" + shop.Slug + "/albums/" + otherAlbum.ID + "/photos/" + id,
		base + "/photos/" + uuid.NewString(), base + "/photos/bad-id",
	} {
		buyer.mustJSON("GET", badPath, nil, http.StatusNotFound, nil)
	}
	for _, status := range []string{"uploading", "processing", "failed", "blocked"} {
		mustExec(t, "UPDATE photos SET status = $2 WHERE id = $1", id, status)
		buyer.mustJSON("GET", path, nil, http.StatusNotFound, nil)
	}
	mustExec(t, "UPDATE photos SET status = 'ready', deleted_at = now() WHERE id = $1", id)
	buyer.mustJSON("GET", path, nil, http.StatusNotFound, nil)
	mustExec(t, "UPDATE photos SET deleted_at = NULL, shop_id = $2 WHERE id = $1", id, otherShop.ID)
	buyer.mustJSON("GET", path, nil, http.StatusNotFound, nil)
	mustExec(t, "UPDATE photos SET shop_id = $2 WHERE id = $1", id, shop.ID)
	for _, albumID := range []string{album.ID, parent.ID} {
		for _, change := range []struct{ set, reset string }{
			{"status = 'draft'", "status = 'published'"},
			{"hidden_by_plan = true", "hidden_by_plan = false"},
			{"blocked_by_moderator = true", "blocked_by_moderator = false"},
			{"deleted_at = now()", "deleted_at = NULL"},
		} {
			mustExec(t, "UPDATE albums SET "+change.set+" WHERE id = $1", albumID)
			buyer.mustJSON("GET", path, nil, http.StatusNotFound, nil)
			mustExec(t, "UPDATE albums SET "+change.reset+" WHERE id = $1", albumID)
		}
		mustExec(t, "UPDATE albums SET status = 'unlisted' WHERE id = $1", albumID)
		buyer.mustJSON("GET", path, nil, http.StatusOK, nil)
		mustExec(t, "UPDATE albums SET status = 'published' WHERE id = $1", albumID)
	}
	mustExec(t, "UPDATE shops SET plan = 'standard', paid_until = now() + interval '30 days' WHERE id = $1", shop.ID)
	for _, lockedID := range []string{album.ID, parent.ID} {
		privatePath := "/api/v1/shops/" + shop.ID + "/albums/" + lockedID
		owner.mustJSON("PATCH", privatePath, map[string]any{"password": "secret123"}, http.StatusOK, nil)
		buyer.headers = nil
		buyer.mustJSON("GET", path, nil, http.StatusNotFound, nil)
		buyer.headers = map[string]string{"X-Album-Token": strings.Repeat("0", 64)}
		buyer.mustJSON("GET", path, nil, http.StatusNotFound, nil)
		var pass struct {
			Token string `json:"token"`
		}
		buyer.mustJSON("POST", base+"/unlock", map[string]any{"password": "secret123"}, http.StatusOK, &pass)
		buyer.headers = map[string]string{"X-Album-Token": pass.Token}
		buyer.mustJSON("GET", path, nil, http.StatusOK, nil)
		owner.mustJSON("PATCH", privatePath, map[string]any{"password": "changed123"}, http.StatusOK, nil)
		buyer.mustJSON("GET", path, nil, http.StatusNotFound, nil)
		owner.mustJSON("PATCH", privatePath, map[string]any{"password": ""}, http.StatusOK, nil)
	}
	buyer.headers = nil
	mustExec(t, "UPDATE shops SET status = 'suspended' WHERE id = $1", shop.ID)
	buyer.mustJSON("GET", path, nil, http.StatusNotFound, nil)
	mustExec(t, "UPDATE shops SET status = 'active', billing_state = 'suspended' WHERE id = $1", shop.ID)
	buyer.mustJSON("GET", path, nil, http.StatusGone, nil)
}
