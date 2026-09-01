package integration

import (
	"context"
	"net/http"
	"testing"
)

// TestAlbumLimitPerShop: число альбомов ограничено. Тарифом оно не
// ограничивалось никак, а страница магазина отдаёт их все и на каждый
// заход покупателя — горячий путь зависел от того, сколько их наделали.
func TestAlbumLimitPerShop(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	// Создавать тысячу через API долго: добиваем счётчик напрямую,
	// проверяем именно реакцию обработчика на достигнутый потолок.
	if _, err := env.pool.Exec(ctx, `
		INSERT INTO albums (shop_id, title)
		SELECT $1, 'Альбом ' || i FROM generate_series(1, 1000) AS i`, shop.ID); err != nil {
		t.Fatalf("seed albums: %v", err)
	}

	status, raw := c.do("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Тысяча первый"})
	if status != http.StatusConflict {
		t.Fatalf("альбом сверх потолка создан: status %d, want 409; body: %s", status, raw)
	}

	// Витрина отдаёт не больше потолка независимо от того, что в базе.
	var page struct {
		Albums []albumJSON `json:"albums"`
	}
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusOK, &page)
	if len(page.Albums) > 1000 {
		t.Fatalf("витрина отдала %d альбомов", len(page.Albums))
	}
}

// TestAlbumReparent: вложенность альбома можно изменить после создания.
// Раньше parent_id принимался только при создании, и переложить альбом
// можно было лишь удалив его вместе с фотографиями.
func TestAlbumReparent(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	mk := func(title string, parent *string) albumJSON {
		t.Helper()
		body := map[string]any{"title": title}
		if parent != nil {
			body["parent_id"] = *parent
		}
		var out albumJSON
		c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums", body, http.StatusCreated, &out)
		return out
	}
	patch := func(id string, body map[string]any, want int) {
		t.Helper()
		status, raw := c.do("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+id, body)
		if status != want {
			t.Fatalf("PATCH %s: status %d, want %d; body: %s", id, status, want, raw)
		}
	}

	top := mk("Обувь", nil)
	other := mk("Сумки", nil)
	loose := mk("Кроссовки", nil)

	// Вложение после создания.
	patch(loose.ID, map[string]any{"parent_id": top.ID}, http.StatusOK)
	var albums []albumJSON
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	for _, al := range albums {
		if al.ID == loose.ID && (al.ParentID == nil || *al.ParentID != top.ID) {
			t.Fatalf("вложенность не применилась: %v", al.ParentID)
		}
	}

	// Обратно на верхний уровень.
	patch(loose.ID, map[string]any{"parent_id": ""}, http.StatusOK)
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	for _, al := range albums {
		if al.ID == loose.ID && al.ParentID != nil {
			t.Fatalf("альбом не вынесен наверх: %v", *al.ParentID)
		}
	}

	// Сам себе родитель и третий уровень отклоняются.
	patch(top.ID, map[string]any{"parent_id": top.ID}, http.StatusBadRequest)
	child := mk("Ботинки", &top.ID)
	patch(top.ID, map[string]any{"parent_id": other.ID}, http.StatusBadRequest)
	patch(other.ID, map[string]any{"parent_id": child.ID}, http.StatusBadRequest)
}

// TestSuspendedShopBlocksUploads: заблокированный модератором магазин не
// принимает загрузки. Витрина у него скрыта, а presign продолжал работать —
// снятый по жалобе магазин спокойно набирал новый контент.
func TestSuspendedShopBlocksUploads(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	if _, err := env.pool.Exec(ctx,
		`UPDATE shops SET status = 'suspended' WHERE id = $1`, shop.ID); err != nil {
		t.Fatalf("suspend shop: %v", err)
	}

	status, raw := c.do("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1024})
	if status != http.StatusForbidden {
		t.Fatalf("заблокированный магазин принял загрузку: status %d, want 403; body: %s", status, raw)
	}
}
