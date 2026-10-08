package integration

import (
	"bytes"
	"net/http"
	"testing"
)

// TestOversizedOriginalRejectedAtConfirm: presigned PUT размер не
// ограничивает — заявили 1 КБ, залили 11 МБ. Подтверждение обязано
// отказать (воркер читает оригинал в память целиком), убрать объект
// и не учитывать байты в квоте.
func TestOversizedOriginalRejectedAtConfirm(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1024},
		http.StatusOK, &pre)
	big := bytes.Repeat([]byte{0xFF}, 11<<20)
	req, err := http.NewRequest(http.MethodPut, pre.URL, bytes.NewReader(big))
	if err != nil {
		t.Fatalf("build PUT: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Skipf("storage refused oversized PUT itself (status %d) — nothing to confirm", resp.StatusCode)
	}

	var out struct {
		Results []struct {
			Status string `json:"status"`
			Code   string `json:"code"`
		} `json:"results"`
	}
	c.mustJSON("POST", "/api/v1/photos/confirm",
		map[string]any{"shop_id": shop.ID, "photo_ids": []string{pre.PhotoID}}, http.StatusOK, &out)
	if len(out.Results) != 1 || out.Results[0].Status != "failed" || out.Results[0].Code != "file_too_large" {
		t.Fatalf("confirm result = %+v, want failed/file_too_large", out.Results)
	}

	var me struct {
		StorageUsed int64 `json:"storage_used"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &me)
	if me.StorageUsed != 0 {
		t.Fatalf("storage_used = %d after rejected file, want 0", me.StorageUsed)
	}
	if _, exists, err := env.store.StatSize(t.Context(), "orig/"+shop.ID+"/"+pre.PhotoID); err != nil || exists {
		t.Fatalf("oversized original still in storage (exists=%v, err=%v)", exists, err)
	}
}
