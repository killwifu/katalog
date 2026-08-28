package integration

import (
	"fmt"
	"net/http"
	"testing"
)

type photoPageJSON struct {
	Photos  []photoJSON `json:"photos"`
	Page    int         `json:"page"`
	PerPage int         `json:"per_page"`
	Total   int64       `json:"total"`
}

// TestCabinetPhotosPagination: альбом на тарифе «Продавец» вмещает до 5000
// фотографий. Выдача целиком вешала кабинет на секунды — у витрины пагинация
// была с самого начала, у кабинета её не было.
func TestCabinetPhotosPagination(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	const n = 3
	for i := 0; i < n; i++ {
		uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 64, 64))
	}

	get := func(query string) photoPageJSON {
		var out photoPageJSON
		c.mustJSON("GET",
			fmt.Sprintf("/api/v1/shops/%s/albums/%s/photos%s", shop.ID, album.ID, query),
			nil, http.StatusOK, &out)
		return out
	}

	t.Run("отдаёт счётчик и страницу", func(t *testing.T) {
		p := get("")
		if p.Total != n {
			t.Errorf("total = %d, want %d", p.Total, n)
		}
		if p.Page != 1 || p.PerPage <= 0 {
			t.Errorf("страница %d, per_page %d", p.Page, p.PerPage)
		}
		if len(p.Photos) != n {
			t.Errorf("фото на странице %d, want %d", len(p.Photos), n)
		}
	})

	t.Run("per_page режет выдачу, page листает", func(t *testing.T) {
		first := get("?per_page=2&page=1")
		if len(first.Photos) != 2 {
			t.Fatalf("на первой странице %d фото, want 2", len(first.Photos))
		}
		second := get("?per_page=2&page=2")
		if len(second.Photos) != 1 {
			t.Fatalf("на второй странице %d фото, want 1", len(second.Photos))
		}
		// Страницы не должны пересекаться: иначе продавец увидит дубли.
		for _, a := range first.Photos {
			for _, b := range second.Photos {
				if a.ID == b.ID {
					t.Errorf("фото %s попало на обе страницы", a.ID)
				}
			}
		}
		// total не зависит от размера страницы.
		if second.Total != n {
			t.Errorf("total на второй странице = %d, want %d", second.Total, n)
		}
	})

	t.Run("страница за пределами — пусто, но не ошибка", func(t *testing.T) {
		p := get("?per_page=2&page=99")
		if len(p.Photos) != 0 {
			t.Errorf("ожидалась пустая страница, получено %d", len(p.Photos))
		}
		if p.Total != n {
			t.Errorf("total = %d, want %d", p.Total, n)
		}
	})
}
