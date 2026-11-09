package integration

import (
	"bytes"
	"errors"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"katalog/backend/internal/tasks"
)

func TestOriginalReplacementAfterConfirm(t *testing.T) {
	for _, tc := range []struct {
		name   string
		size   int
		reason string
	}{
		{"oversized", 11 << 20, "file_too_large"},
		{"larger", 30000, "corrupt"},
		{"smaller", 700, "corrupt"},
		{"same-size-invalid", 0, "unsupported_format"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			c := newClient(t)
			registerUser(c)
			shop := createShop(c)
			album := createAlbum(c, shop.ID)
			// Keep a separate ready photo to catch accidental release of its bytes.
			uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 80, 60))
			before := shopStorageUsed(c, shop.ID)
			inspector := asynq.NewInspector(asynq.RedisClientOpt{Addr: env.rdb.Options().Addr})
			defer func() { _ = inspector.Close() }()
			if err := inspector.PauseQueue("default"); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := inspector.UnpauseQueue("default"); err != nil {
					t.Error(err)
				}
			}()
			original := makeJPEG(t, 320, 240)
			var pre presignJSON
			c.mustJSON("POST", "/api/v1/uploads/presign", map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": len(original)}, http.StatusOK, &pre)
			put := func(data []byte) {
				t.Helper()
				req, err := http.NewRequest(http.MethodPut, pre.URL, bytes.NewReader(data))
				if err != nil {
					t.Fatal(err)
				}
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("PUT: %d", resp.StatusCode)
				}
			}
			put(original)
			c.mustJSON("POST", "/api/v1/photos/confirm", map[string]any{"shop_id": shop.ID, "photo_ids": []string{pre.PhotoID}}, http.StatusOK, nil)
			// A valid JPEG with a changed byte length would otherwise become ready.
			replacement := makeJPEG(t, 20, 20)
			if tc.name == "same-size-invalid" {
				tc.size = len(original)
				replacement = make([]byte, tc.size)
			}
			if len(replacement) > tc.size {
				t.Fatalf("replacement fixture too large: %d", len(replacement))
			}
			replacement = append(replacement, make([]byte, tc.size-len(replacement))...)
			if tc.name == "same-size-invalid" {
				// Signed length still allows different bytes of the same size.
				put(replacement)
			} else if err := env.store.Upload(ctx, "orig/"+shop.ID+"/"+pre.PhotoID, replacement, "image/jpeg"); err != nil {
				// Simulate a legacy unsigned URL from before the deployment.
				t.Fatal(err)
			}
			task, err := tasks.NewPhotoProcess(uuid.MustParse(pre.PhotoID))
			if err != nil {
				t.Fatal(err)
			}
			if err := env.processor.HandlePhotoProcess(ctx, task); !errors.Is(err, asynq.SkipRetry) {
				t.Errorf("processing error = %v, want SkipRetry", err)
			}
			var p photoJSON
			var list struct {
				Photos []photoJSON `json:"photos"`
			}
			c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/photos", nil, http.StatusOK, &list)
			for _, photo := range list.Photos {
				if photo.ID == pre.PhotoID {
					p = photo
				}
			}
			if p.Status != "failed" || p.FailReason != tc.reason {
				t.Errorf("photo = %+v, want failed/%s", p, tc.reason)
			}
			if got := shopStorageUsed(c, shop.ID); got != before {
				t.Errorf("storage_used = %d, want %d", got, before)
			}
			key := "orig/" + shop.ID + "/" + pre.PhotoID
			if _, exists, err := env.store.StatSize(ctx, key); err != nil || exists {
				t.Errorf("original still exists: %v, %v", exists, err)
			}
			photo, err := env.q.GetPhoto(ctx, uuid.MustParse(pre.PhotoID))
			if err != nil {
				t.Fatal(err)
			}
			if photo.OrigSize != 0 || photo.DrvSize != 0 {
				t.Errorf("accounted photo bytes: %d + %d", photo.OrigSize, photo.DrvSize)
			}
			for _, name := range []string{"small", "medium", "large"} {
				key := "drv/" + shop.ID + "/" + pre.PhotoID + "/" + name + ".webp"
				if _, exists, err := env.store.StatSize(ctx, key); err != nil || exists {
					t.Errorf("derivative exists: %s: %v, %v", name, exists, err)
				}
			}
			// A duplicate task must not release the other photo's quota.
			if err := env.processor.HandlePhotoProcess(ctx, task); err != nil {
				t.Error(err)
			}
			if got := shopStorageUsed(c, shop.ID); got != before {
				t.Errorf("storage after duplicate = %d, want %d", got, before)
			}
		})
	}
}

func TestPasswordRotationInvalidatesEmailChanges(t *testing.T) {
	for _, mode := range []string{"change", "reset"} {
		t.Run(mode, func(t *testing.T) {
			ctx := t.Context()
			c := newClient(t)
			user := registerUser(c)
			var tokens []string
			// Both the current and an older superseded link must be invalidated.
			for i := 0; i < 2; i++ {
				next := uniqueEmail()
				if err := env.rdb.Del(ctx, "resend:emchg:"+user.ID).Err(); err != nil {
					t.Fatal(err)
				}
				c.mustJSON("POST", "/api/v1/auth/email/change", map[string]string{"email": next, "password": "password123"}, http.StatusNoContent, nil)
				msg := waitEmail(t, next, "Подтвердите новую почту")
				tokens = append(tokens, extractToken(t, msg.Text, "/app/confirm-email?token="))
			}
			if mode == "change" {
				c.mustJSON("POST", "/api/v1/auth/password/change", map[string]string{"current_password": "password123", "new_password": "newpassword456"}, http.StatusNoContent, nil)
			} else {
				anon := newClient(t)
				anon.mustJSON("POST", "/api/v1/auth/password/forgot", map[string]string{"email": *user.Email}, http.StatusNoContent, nil)
				token := resetTokenFor(t, ctx, *user.Email)
				anon.mustJSON("POST", "/api/v1/auth/password/reset", map[string]string{"token": token, "password": "newpassword456"}, http.StatusOK, nil)
				c = newClient(t)
				c.mustJSON("POST", "/api/v1/auth/login", map[string]string{"email": *user.Email, "password": "newpassword456"}, http.StatusOK, nil)
			}
			for _, token := range tokens {
				status, body := newClient(t).do("POST", "/api/v1/auth/email/confirm", map[string]string{"token": token})
				if status != http.StatusBadRequest {
					t.Errorf("old email link: %d %s, want 400", status, body)
				}
			}
			var me meJSON
			c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
			if me.Email == nil || *me.Email != *user.Email || me.PendingEmail != nil {
				t.Errorf("after rotation: %+v", me)
			}
			// A newly authorized email change must still work.
			next := uniqueEmail()
			env.rdb.Del(ctx, "resend:emchg:"+user.ID)
			c.mustJSON("POST", "/api/v1/auth/email/change", map[string]string{"email": next, "password": "newpassword456"}, http.StatusNoContent, nil)
			msg := waitEmail(t, next, "Подтвердите новую почту")
			token := extractToken(t, msg.Text, "/app/confirm-email?token=")
			newClient(t).mustJSON("POST", "/api/v1/auth/email/confirm", map[string]string{"token": token}, http.StatusNoContent, nil)
		})
	}
}

func TestOversizedLogoStopsRetry(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	var pre struct {
		LogoID string `json:"logo_id"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/logo/presign", map[string]any{"size": 10 << 20}, http.StatusOK, &pre)
	id := uuid.MustParse(pre.LogoID)
	key := "orig/" + shop.ID + "/" + id.String()
	if err := env.store.Upload(t.Context(), key, make([]byte, 11<<20), "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	task, err := tasks.NewShopLogo(uuid.MustParse(shop.ID), id)
	if err != nil {
		t.Fatal(err)
	}
	if err := env.processor.HandleShopLogo(t.Context(), task); !errors.Is(err, asynq.SkipRetry) {
		t.Errorf("oversized logo: %v, want SkipRetry", err)
	}
	var status map[string]string
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/logo/status?logo_id="+id.String(), nil, http.StatusOK, &status)
	if status["status"] != "failed" || status["reason"] != "file_too_large" {
		t.Errorf("logo status: %v", status)
	}
	if _, exists, err := env.store.StatSize(t.Context(), key); err != nil || exists {
		t.Errorf("oversized logo exists=%v, err=%v", exists, err)
	}
}
