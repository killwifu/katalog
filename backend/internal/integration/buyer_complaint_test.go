package integration

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// TestBuyerComplaint: анонимная жалоба покупателя с витрины (макет 15 ·
// «Жалоба») на витрину, альбом и фото. Объект и ссылку определяет сервер,
// скрытое и чужое — 404, причина из списка, «Другое» требует комментарий.
func TestBuyerComplaint(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photoID := uploadReadyPhoto(t, owner, shop.ID, album.ID, makeJPEG(t, 640, 480))
	// Альбом и фото другого магазина.
	other := newClient(t)
	registerUser(other)
	otherShop := createShop(other)
	otherAlbum := createAlbum(other, otherShop.ID)
	otherPhoto := uploadReadyPhoto(t, other, otherShop.ID, otherAlbum.ID, makeJPEG(t, 320, 240))

	path := "/api/v1/public/shops/" + shop.Slug + "/complaints"
	buyer := newClient(t)
	post := func(body map[string]string) (int, string) {
		t.Helper()
		var out struct {
			ID    string `json:"id"`
			Error string `json:"error"`
		}
		status, raw := buyer.do("POST", path, body)
		_ = json.Unmarshal(raw, &out)
		if out.ID != "" {
			return status, out.ID
		}
		return status, out.Error
	}

	t.Run("валидация", func(t *testing.T) {
		cases := []struct {
			name string
			body map[string]string
			code string
		}{
			{"нет причины", map[string]string{"target": "shop"}, "invalid_reason"},
			{"причина не из списка", map[string]string{"target": "shop", "reason": "boring"}, "invalid_reason"},
			{"неизвестный объект", map[string]string{"target": "tab", "reason": "spam"}, "invalid_target"},
			{"«Другое» без комментария", map[string]string{"target": "shop", "reason": "other", "comment": "   "}, "comment_required"},
			{"комментарий длиннее 500", map[string]string{"target": "shop", "reason": "spam", "comment": strings.Repeat("а", 501)}, "invalid_comment"},
		}
		for _, tc := range cases {
			if status, code := post(tc.body); status != http.StatusBadRequest || code != tc.code {
				t.Errorf("%s: %d %s, want 400 %s", tc.name, status, code, tc.code)
			}
		}
	})

	t.Run("чужой и скрытый объект — 404", func(t *testing.T) {
		cases := []map[string]string{
			{"target": "album", "target_id": otherAlbum.ID, "reason": "spam"},
			{"target": "photo", "target_id": otherPhoto, "reason": "spam"},
			{"target": "album", "target_id": "not-a-uuid", "reason": "spam"},
		}
		for _, body := range cases {
			if status, _ := post(body); status != http.StatusNotFound {
				t.Errorf("%v: status %d, want 404", body, status)
			}
		}
		if status, _ := buyer.do("POST", "/api/v1/public/shops/no-such-shop-xyz/complaints",
			map[string]string{"target": "shop", "reason": "spam"}); status != http.StatusNotFound {
			t.Errorf("unknown shop: status %d, want 404", status)
		}
	})

	var shopC, albumC, photoC string
	t.Run("жалобы приняты", func(t *testing.T) {
		var status int
		if status, shopC = post(map[string]string{"target": "shop", "reason": "fraud"}); status != http.StatusCreated {
			t.Fatalf("shop complaint: %d %s", status, shopC)
		}
		if status, albumC = post(map[string]string{"target": "album", "target_id": album.ID, "reason": "adult",
			"comment": "Откровенные снимки"}); status != http.StatusCreated {
			t.Fatalf("album complaint: %d %s", status, albumC)
		}
		if status, photoC = post(map[string]string{"target": "photo", "target_id": photoID, "reason": "other",
			"comment": "Чужой водяной знак"}); status != http.StatusCreated {
			t.Fatalf("photo complaint: %d %s", status, photoC)
		}
	})

	t.Run("в админке: объект, причина, ссылка", func(t *testing.T) {
		admin := newClient(t)
		adminUser := registerUser(admin)
		makeAdmin(t, adminUser.ID)
		var list []struct {
			complaintJSON
			Reason        string  `json:"reason"`
			ReporterEmail string  `json:"reporter_email"`
			TargetType    *string `json:"target_type"`
			ReasonCode    *string `json:"reason_code"`
		}
		admin.mustJSON("GET", "/api/v1/admin/complaints?status=open", nil, http.StatusOK, &list)
		albumURL := "http://katalog.test/" + shop.Slug + "/katalog"
		want := map[string]struct{ target, reason, comment, url string }{
			shopC:  {"shop", "fraud", "", "http://katalog.test/" + shop.Slug},
			albumC: {"album", "adult", "Откровенные снимки", albumURL},
			photoC: {"photo", "other", "Чужой водяной знак", albumURL + "?p=" + photoID},
		}
		found := 0
		for _, c := range list {
			w, ok := want[c.ID]
			if !ok {
				continue
			}
			found++
			if c.TargetType == nil || *c.TargetType != w.target || c.ReasonCode == nil || *c.ReasonCode != w.reason ||
				c.Reason != w.comment || c.ContentURL != w.url || c.ReporterEmail != "" {
				t.Errorf("complaint %s: %+v, want %+v", c.ID, c, w)
			}
			if c.ShopID == nil || *c.ShopID != shop.ID {
				t.Errorf("complaint %s: shop_id %v", c.ID, c.ShopID)
			}
			// Жалоба на альбом даёт модератору «Скрыть альбом».
			if w.target != "shop" && (c.PhotoAlbumID == nil || *c.PhotoAlbumID != album.ID) {
				t.Errorf("complaint %s: album id %v, want %s", c.ID, c.PhotoAlbumID, album.ID)
			}
		}
		if found != 3 {
			t.Fatalf("found %d of 3 complaints in admin list", found)
		}
	})

	t.Run("скрытый альбом и его фото — 404", func(t *testing.T) {
		owner.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID,
			map[string]any{"status": "draft"}, http.StatusOK, &struct{}{})
		for _, body := range []map[string]string{
			{"target": "album", "target_id": album.ID, "reason": "spam"},
			{"target": "photo", "target_id": photoID, "reason": "spam"},
		} {
			if status, _ := post(body); status != http.StatusNotFound {
				t.Errorf("%v: status %d, want 404", body, status)
			}
		}
	})
}

// TestBuyerComplaintRateLimit: анонимную жалобу ограничивает жёсткий лимит
// по IP (как вход), а не щедрый общий лимит витрины.
func TestBuyerComplaintRateLimit(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	c := newClient(t)
	waitFreshRateWindow()
	for i := 0; i < 35; i++ {
		status, _ := c.do("POST", "/api/v1/public/shops/"+shop.Slug+"/complaints",
			map[string]string{"target": "shop", "reason": "spam"})
		if status == http.StatusTooManyRequests {
			return
		}
		if status != http.StatusCreated {
			t.Fatalf("attempt %d: status %d", i, status)
		}
	}
	t.Fatal("rate limit did not trigger after 35 complaints (limit is 30/min)")
}

func TestBuyerComplaintLockedPhoto(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photo := uploadReadyPhoto(t, owner, shop.ID, album.ID, makeJPEG(t, 320, 240))
	mustExec(t, "UPDATE shops SET plan = 'standard', paid_until = now() + interval '30 days' WHERE id = $1", shop.ID)
	owner.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID, map[string]any{"password": "secret123"}, http.StatusOK, nil)
	buyer := newClient(t)
	path := "/api/v1/public/shops/" + shop.Slug + "/complaints"
	body := map[string]string{"target": "photo", "target_id": photo, "reason": "spam"}
	if status, _ := buyer.do("POST", path, body); status != http.StatusNotFound {
		t.Fatalf("locked photo without token: %d, want 404", status)
	}
	var pass struct {
		Token string `json:"token"`
	}
	buyer.mustJSON("POST", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID+"/unlock", map[string]string{"password": "secret123"}, http.StatusOK, &pass)
	buyer.headers = map[string]string{"X-Album-Token": pass.Token}
	buyer.mustJSON("POST", path, body, http.StatusCreated, nil)
}
