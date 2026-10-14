package integration

import (
	"context"
	"net/http"
	"testing"
)

// Действие модератора со ссылкой на несуществующую жалобу раньше
// выполнялось, а запись аудита падала на внешнем ключе и терялась.
// Теперь такая ссылка — 400, и действие не выполняется.
func TestAdminActionRejectsUnknownComplaint(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)

	admin := newClient(t)
	adminUser := registerUser(admin)
	makeAdmin(t, adminUser.ID)

	for _, ref := range []string{"00000000-0000-0000-0000-000000000001", "not-a-uuid"} {
		code, raw := admin.do("POST", "/api/v1/admin/albums/"+album.ID+"/hide",
			map[string]string{"complaint_id": ref, "note": "x"})
		if code != http.StatusBadRequest {
			t.Fatalf("complaint_id %q: got %d %s, want 400", ref, code, raw)
		}
	}
	if status, _ := owner.do("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil); status != http.StatusOK {
		t.Fatalf("album must stay visible after rejected action: %d", status)
	}

	// Без ссылки на жалобу действие проходит и попадает в аудит.
	admin.mustJSON("POST", "/api/v1/admin/albums/"+album.ID+"/hide", map[string]string{"note": "x"}, http.StatusNoContent, nil)
	var n int
	if err := env.pool.QueryRow(context.Background(),
		"SELECT count(*) FROM moderation_log WHERE album_id = $1", album.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("moderation_log entries for album: %d, want 1", n)
	}
}
