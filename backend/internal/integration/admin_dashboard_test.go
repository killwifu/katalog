package integration

import (
	"net/http"
	"testing"
	"time"
)

func TestAdminDashboard(t *testing.T) {
	seller := newClient(t)
	sellerUser := registerUser(seller)
	shop := createShop(seller)
	album := createAlbum(seller, shop.ID)
	photo := uploadPhoto(seller, shop.ID, album.ID, makeJPEG(t, 320, 240))
	// Счётчики считают только ready — ждём, пока воркер обработает фото.
	waitPhotoStatus(seller, shop.ID, album.ID, photo, "ready", 30*time.Second)

	t.Run("не-админ не видит админ-зону", func(t *testing.T) {
		for _, path := range []string{"/api/v1/admin/overview", "/api/v1/admin/shops"} {
			status, body := seller.do("GET", path, nil)
			if status != http.StatusNotFound {
				t.Errorf("%s: status %d, want 404; body: %s", path, status, body)
			}
		}
	})

	admin := newClient(t)
	adminUser := registerUser(admin)
	makeAdmin(t, adminUser.ID)
	_ = sellerUser

	t.Run("сводка платформы", func(t *testing.T) {
		var overview struct {
			ActiveShops    int64 `json:"active_shops"`
			ReadyPhotos    int64 `json:"ready_photos"`
			OpenComplaints int64 `json:"open_complaints"`
			StorageUsed    int64 `json:"storage_used"`
		}
		admin.mustJSON("GET", "/api/v1/admin/overview", nil, http.StatusOK, &overview)
		if overview.ActiveShops < 1 {
			t.Errorf("активных магазинов %d, ожидался хотя бы один", overview.ActiveShops)
		}
		if overview.ReadyPhotos < 1 {
			t.Errorf("готовых фото %d, ожидалось хотя бы одно", overview.ReadyPhotos)
		}
	})

	t.Run("список продавцов с историей жалоб", func(t *testing.T) {
		var shops []struct {
			ID         string `json:"id"`
			Slug       string `json:"slug"`
			Email      string `json:"email"`
			Photos     int64  `json:"photos"`
			Complaints int64  `json:"complaints"`
		}
		admin.mustJSON("GET", "/api/v1/admin/shops", nil, http.StatusOK, &shops)
		found := false
		for _, s := range shops {
			if s.ID == shop.ID {
				found = true
				if s.Photos < 1 {
					t.Errorf("фото у магазина %d, ожидалось хотя бы одно", s.Photos)
				}
				if s.Email == "" {
					t.Error("почта продавца нужна модератору, чтобы написать")
				}
			}
		}
		if !found {
			t.Fatalf("магазин %s не попал в список", shop.ID)
		}
	})
}
