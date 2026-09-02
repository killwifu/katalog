package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// TestTenantIsolation: КАЖДЫЙ приватный эндпоинт с чужим ресурсом
// обязан отвечать 404 (см. инвариант безопасности в CLAUDE.md).
func TestTenantIsolation(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photo := uploadPhoto(owner, shop.ID, album.ID, makeJPEG(t, 640, 480))

	// intruder — авторизованный пользователь с собственным магазином.
	intruder := newClient(t)
	registerUser(intruder)
	intruderShop := createShop(intruder)

	// Категория владельца — чтобы дёргать её id из-под чужой сессии.
	var cat struct {
		ID string `json:"id"`
	}
	owner.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/categories",
		map[string]any{"title": "Кроссовки", "slug": "krossovki"}, http.StatusCreated, &cat)

	// Своя вкладка с секцией — те же ресурсы под чужой сессией.
	var tab tabResp
	owner.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/tabs",
		map[string]any{"title": "Опт", "slug": "opt"}, http.StatusCreated, &tab)
	var section sectionResp
	owner.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/tabs/"+tab.ID+"/sections",
		map[string]any{"title": "Новинки"}, http.StatusCreated, &section)

	tests := []struct {
		method string
		path   string
		body   any
	}{
		{"GET", "/api/v1/shops/" + shop.ID, nil},
		{"PATCH", "/api/v1/shops/" + shop.ID, map[string]any{"name": "hacked"}},
		{"DELETE", "/api/v1/shops/" + shop.ID, nil},
		{"GET", "/api/v1/shops/" + shop.ID + "/albums", nil},
		{"POST", "/api/v1/shops/" + shop.ID + "/albums", map[string]any{"title": "hacked"}},
		{"GET", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID), nil},
		{"PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID), map[string]any{"title": "hacked"}},
		{"DELETE", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID), nil},
		{"GET", fmt.Sprintf("/api/v1/shops/%s/albums/%s/photos", shop.ID, album.ID), nil},
		{"POST", "/api/v1/uploads/presign", map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000}},
		{"POST", "/api/v1/photos/confirm", map[string]any{"shop_id": shop.ID, "photo_ids": []string{photo}}},
		{"PATCH", "/api/v1/photos/" + photo, map[string]any{"caption": "hacked"}},
		{"DELETE", "/api/v1/photos/" + photo, nil},
		{"GET", "/api/v1/shops/" + shop.ID + "/categories", nil},
		{"POST", "/api/v1/shops/" + shop.ID + "/categories", map[string]any{"title": "hacked", "slug": "hacked-cat"}},
		{"PATCH", fmt.Sprintf("/api/v1/shops/%s/categories/%s", shop.ID, cat.ID), map[string]any{"title": "hacked", "slug": "hacked-cat"}},
		{"DELETE", fmt.Sprintf("/api/v1/shops/%s/categories/%s", shop.ID, cat.ID), nil},
		{"PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s/category", shop.ID, album.ID), map[string]any{"category_id": cat.ID}},
		{"GET", "/api/v1/shops/" + shop.ID + "/tabs", nil},
		{"POST", "/api/v1/shops/" + shop.ID + "/tabs", map[string]any{"title": "hacked", "slug": "hacked-tab"}},
		{"PATCH", fmt.Sprintf("/api/v1/shops/%s/tabs/%s", shop.ID, tab.ID), map[string]any{"title": "hacked"}},
		{"DELETE", fmt.Sprintf("/api/v1/shops/%s/tabs/%s", shop.ID, tab.ID), nil},
		{"POST", fmt.Sprintf("/api/v1/shops/%s/tabs/%s/sections", shop.ID, tab.ID), map[string]any{"title": "hacked"}},
		{"GET", "/api/v1/shops/" + shop.ID + "/sections", nil},
		{"PATCH", fmt.Sprintf("/api/v1/shops/%s/sections/%s", shop.ID, section.ID), map[string]any{"title": "hacked"}},
		{"DELETE", fmt.Sprintf("/api/v1/shops/%s/sections/%s", shop.ID, section.ID), nil},
		{"PUT", fmt.Sprintf("/api/v1/shops/%s/sections/%s/albums", shop.ID, section.ID), map[string]any{"album_ids": []string{album.ID}}},
		{"GET", "/api/v1/shops/" + shop.ID + "/stats", nil},
		{"GET", "/api/v1/shops/" + shop.ID + "/billing", nil},
		{"POST", "/api/v1/shops/" + shop.ID + "/billing/cancel", nil},
		{"PUT", fmt.Sprintf("/api/v1/shops/%s/tabs/order", shop.ID), map[string]any{"tab_ids": []string{tab.ID}}},
		{"GET", "/api/v1/shops/" + shop.ID + "/downgrade", nil},
		{"PUT", "/api/v1/shops/" + shop.ID + "/downgrade", map[string]any{"album_ids": []string{album.ID}}},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			status, body := intruder.do(tt.method, tt.path, tt.body)
			if status != http.StatusNotFound {
				t.Errorf("foreign resource: status %d, want 404; body: %s", status, body)
			}
		})
	}

	// Смешанная атака: свой магазин + чужой альбом.
	t.Run("presign with foreign album in own shop", func(t *testing.T) {
		status, body := intruder.do("POST", "/api/v1/uploads/presign",
			map[string]any{"shop_id": intruderShop.ID, "album_id": album.ID, "size": 1000})
		if status != http.StatusNotFound {
			t.Errorf("status %d, want 404; body: %s", status, body)
		}
	})
	// Свой магазин + чужое фото в confirm: не должно перевести чужое фото
	// в processing, ответ — per-item ошибка.
	t.Run("confirm with foreign photo in own shop", func(t *testing.T) {
		var confirm struct {
			Results []struct {
				Status string `json:"status"`
				Error  string `json:"error"`
			} `json:"results"`
		}
		intruder.mustJSON("POST", "/api/v1/photos/confirm",
			map[string]any{"shop_id": intruderShop.ID, "photo_ids": []string{photo}},
			http.StatusOK, &confirm)
		if len(confirm.Results) != 1 || confirm.Results[0].Status != "error" {
			t.Errorf("foreign photo confirm: %+v, want per-item error", confirm.Results)
		}
	})

	// Владелец после всех атак по-прежнему видит свои ресурсы.
	var check shopJSON
	owner.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &check)
	if check.Name == "hacked" {
		t.Fatal("intruder managed to modify foreign shop")
	}
}

// TestAdminRoutesRequireAdmin: обычный пользователь не должен доставать
// ни один админ-эндпоинт. Существование админ-зоны наружу не раскрывается,
// поэтому ответ — 404, а не 403.
//
// Ресурсы заранее приводятся в состояние, в котором действие модератора
// осмысленно: заблокированное фото, скрытый альбом, приостановленный
// магазин, открытая жалоба. Иначе «снять блокировку» отдаёт 404 само по
// себе — не потому, что доступ закрыт, а потому что снимать нечего, и
// проверка доступа оказывается пустой.
func TestAdminRoutesRequireAdmin(t *testing.T) {
	ctx := context.Background()
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photo := uploadPhoto(owner, shop.ID, album.ID, makeJPEG(t, 64, 64))
	waitPhotoStatus(owner, shop.ID, album.ID, photo, "ready", 60*time.Second)

	admin := newClient(t)
	adminUser := registerUser(admin)
	makeAdmin(t, adminUser.ID)

	// Жалоба нужна настоящая: PATCH по выдуманному id отдаёт 404 всегда.
	reporter := newClient(t)
	var complaint struct {
		ID string `json:"id"`
	}
	reporter.mustJSON("POST", "/api/v1/public/complaints", map[string]string{
		"url":            "http://katalog.test/" + shop.Slug,
		"reporter_name":  "ООО Правообладатель",
		"reporter_email": "legal@brand.test",
		"reason":         "Фотография нарушает наши исключительные права.",
	}, http.StatusCreated, &complaint)

	note := map[string]any{"note": "подготовка состояния"}
	admin.mustJSON("POST", "/api/v1/admin/photos/"+photo+"/block", note, http.StatusOK, nil)
	admin.mustJSON("POST", "/api/v1/admin/albums/"+album.ID+"/hide", note, http.StatusNoContent, nil)
	mustExec(t, "UPDATE photos SET flagged = true WHERE id = $1", photo)
	admin.mustJSON("POST", "/api/v1/admin/shops/"+shop.ID+"/suspend", note, http.StatusNoContent, nil)

	deny := map[string]any{"note": "проверка доступа"}
	routes := []struct {
		method string
		path   string
		body   any
	}{
		{"GET", "/api/v1/admin/overview", nil},
		{"GET", "/api/v1/admin/shops", nil},
		{"GET", "/api/v1/admin/complaints", nil},
		{"PATCH", "/api/v1/admin/complaints/" + complaint.ID, map[string]any{"status": "closed"}},
		{"GET", "/api/v1/admin/photos/flagged", nil},
		{"POST", "/api/v1/admin/photos/" + photo + "/block", deny},
		{"POST", "/api/v1/admin/photos/" + photo + "/unblock", deny},
		{"POST", "/api/v1/admin/photos/" + photo + "/unflag", deny},
		{"POST", "/api/v1/admin/albums/" + album.ID + "/hide", deny},
		{"POST", "/api/v1/admin/albums/" + album.ID + "/unhide", deny},
		{"POST", "/api/v1/admin/shops/" + shop.ID + "/suspend", deny},
		{"POST", "/api/v1/admin/shops/" + shop.ID + "/unsuspend", deny},
	}
	for _, r := range routes {
		t.Run(r.method+" "+r.path, func(t *testing.T) {
			status, body := owner.do(r.method, r.path, r.body)
			if status != http.StatusNotFound {
				t.Errorf("не-админ достал админ-эндпоинт: status %d, want 404; body: %s", status, body)
			}
		})
	}

	// Состояние не сдвинулось: ни одно из действий не выполнилось.
	var photoStatus, shopStatus string
	var hidden, flagged bool
	if err := env.pool.QueryRow(ctx,
		`SELECT p.status::text, p.flagged, a.blocked_by_moderator, s.status::text
		   FROM photos p JOIN albums a ON a.id = p.album_id JOIN shops s ON s.id = p.shop_id
		  WHERE p.id = $1`, photo).Scan(&photoStatus, &flagged, &hidden, &shopStatus); err != nil {
		t.Fatalf("read state: %v", err)
	}
	if photoStatus != "blocked" || !flagged || !hidden || shopStatus != "suspended" {
		t.Fatalf("состояние изменилось запросами не-админа: фото %s, flagged %v, альбом скрыт %v, магазин %s",
			photoStatus, flagged, hidden, shopStatus)
	}
}
