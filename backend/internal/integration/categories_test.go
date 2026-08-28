package integration

import (
	"fmt"
	"net/http"
	"testing"
)

type categoryResp struct {
	ID        string  `json:"id"`
	ParentID  *string `json:"parent_id"`
	Title     string  `json:"title"`
	Slug      string  `json:"slug"`
	SortOrder int32   `json:"sort_order"`
}

func createCategory(c *client, shopID, title, slug string, parentID *string) categoryResp {
	body := map[string]any{"title": title, "slug": slug}
	if parentID != nil {
		body["parent_id"] = *parentID
	}
	var out categoryResp
	c.mustJSON("POST", "/api/v1/shops/"+shopID+"/categories", body, http.StatusCreated, &out)
	return out
}

func TestCategories(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	root := createCategory(c, shop.ID, "Обувь", "obuv", nil)
	child := createCategory(c, shop.ID, "Кроссовки", "krossovki", &root.ID)

	t.Run("вложенность максимум 2 уровня", func(t *testing.T) {
		status, body := c.do("POST", "/api/v1/shops/"+shop.ID+"/categories",
			map[string]any{"title": "Беговые", "slug": "begovye", "parent_id": child.ID})
		if status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400; body: %s", status, body)
		}
	})

	t.Run("slug уникален в пределах магазина", func(t *testing.T) {
		status, body := c.do("POST", "/api/v1/shops/"+shop.ID+"/categories",
			map[string]any{"title": "Дубль", "slug": "obuv"})
		if status != http.StatusConflict {
			t.Fatalf("status %d, want 409; body: %s", status, body)
		}
	})

	t.Run("тот же slug в другом магазине разрешён", func(t *testing.T) {
		other := createShop(c)
		createCategory(c, other.ID, "Обувь", "obuv", nil)
	})

	// Альбом относится к категории; витрина отдаёт его по слагу категории,
	// причём у родителя видны и альбомы вложенной категории.
	album := createAlbum(c, shop.ID)
	uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))
	c.mustJSON("PATCH", fmt.Sprintf("/api/v1/shops/%s/albums/%s/category", shop.ID, album.ID),
		map[string]any{"category_id": child.ID}, http.StatusOK, &struct{}{})

	t.Run("витрина: альбом виден и в дочерней, и в родительской", func(t *testing.T) {
		for _, slug := range []string{child.Slug, root.Slug} {
			var albums []struct {
				ID string `json:"id"`
			}
			c.mustJSON("GET", fmt.Sprintf("/api/v1/public/shops/%s/categories/%s", shop.Slug, slug),
				nil, http.StatusOK, &albums)
			if len(albums) != 1 || albums[0].ID != album.ID {
				t.Fatalf("категория %s: получено %v, ожидался альбом %s", slug, albums, album.ID)
			}
		}
	})

	t.Run("витрина: дерево без приватных полей", func(t *testing.T) {
		var tree []map[string]any
		c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/categories", nil, http.StatusOK, &tree)
		if len(tree) != 2 {
			t.Fatalf("категорий в дереве %d, want 2", len(tree))
		}
		for _, item := range tree {
			for _, leaked := range []string{"shop_id", "id", "created_at", "updated_at"} {
				if _, ok := item[leaked]; ok {
					t.Errorf("публичное дерево отдаёт %q: %v", leaked, item)
				}
			}
		}
	})

	// Удаление категории не должно уносить альбомы (kit: «Просто удалять нельзя»).
	t.Run("удаление переносит альбомы в указанную категорию", func(t *testing.T) {
		status, body := c.do("DELETE",
			fmt.Sprintf("/api/v1/shops/%s/categories/%s?move_to=%s", shop.ID, child.ID, root.ID), nil)
		if status != http.StatusNoContent {
			t.Fatalf("status %d, want 204; body: %s", status, body)
		}
		var albums []struct {
			ID string `json:"id"`
		}
		c.mustJSON("GET", fmt.Sprintf("/api/v1/public/shops/%s/categories/%s", shop.Slug, root.Slug),
			nil, http.StatusOK, &albums)
		if len(albums) != 1 || albums[0].ID != album.ID {
			t.Fatalf("альбом потерялся при удалении категории: %v", albums)
		}
	})

	t.Run("удаление без move_to оставляет альбом без категории", func(t *testing.T) {
		status, _ := c.do("DELETE", fmt.Sprintf("/api/v1/shops/%s/categories/%s", shop.ID, root.ID), nil)
		if status != http.StatusNoContent {
			t.Fatalf("status %d, want 204", status)
		}
		// Альбом жив — просто больше не привязан к категории.
		status, _ = c.do("GET", fmt.Sprintf("/api/v1/shops/%s/albums/%s", shop.ID, album.ID), nil)
		if status != http.StatusOK {
			t.Fatalf("альбом удалён вместе с категорией: status %d", status)
		}
	})

	t.Run("move_to в саму себя отклоняется", func(t *testing.T) {
		cat := createCategory(c, shop.ID, "Сумки", "sumki", nil)
		status, _ := c.do("DELETE",
			fmt.Sprintf("/api/v1/shops/%s/categories/%s?move_to=%s", shop.ID, cat.ID, cat.ID), nil)
		if status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", status)
		}
	})
}

// TestCategoryReparent: смена родителя категории применяется, а не молча
// теряется, и не даёт построить третий уровень или цикл.
func TestCategoryReparent(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	mk := func(title, slug string, parent *string) categoryResp {
		t.Helper()
		body := map[string]any{"title": title, "slug": slug}
		if parent != nil {
			body["parent_id"] = *parent
		}
		var out categoryResp
		c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/categories", body, http.StatusCreated, &out)
		return out
	}
	patch := func(id string, body map[string]any, want int) {
		t.Helper()
		status, raw := c.do("PATCH", "/api/v1/shops/"+shop.ID+"/categories/"+id, body)
		if status != want {
			t.Fatalf("PATCH %s: status %d, want %d; body: %s", id, status, want, raw)
		}
	}

	top := mk("Верх", "top-cat", nil)
	other := mk("Другой верх", "other-top", nil)
	child := mk("Ребёнок", "child-cat", &top.ID)

	// Перенос под другого родителя действительно применяется.
	patch(child.ID, map[string]any{"title": "Ребёнок", "slug": "child-cat", "parent_id": other.ID}, http.StatusOK)
	var list []categoryResp
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/categories", nil, http.StatusOK, &list)
	for _, cat := range list {
		if cat.ID != child.ID {
			continue
		}
		if cat.ParentID == nil || *cat.ParentID != other.ID {
			t.Fatalf("родитель не сменился: %v", cat.ParentID)
		}
	}

	// Сама себе родитель — цикл.
	patch(top.ID, map[string]any{"title": "Верх", "slug": "top-cat", "parent_id": top.ID}, http.StatusBadRequest)

	// Категория с детьми не может уехать на второй уровень: дети окажутся
	// на третьем.
	grand := mk("Внук", "grand-cat", &other.ID)
	_ = grand
	patch(other.ID, map[string]any{"title": "Другой верх", "slug": "other-top", "parent_id": top.ID}, http.StatusBadRequest)

	// Родителем не может стать вложенная категория.
	patch(top.ID, map[string]any{"title": "Верх", "slug": "top-cat", "parent_id": child.ID}, http.StatusBadRequest)
}
