package integration

import (
	"fmt"
	"net/http"
	"sync"
	"testing"
)

// Параллельно созданные категории, вкладки и разделы получают разные номера
// порядка (раньше max+1 без замка давал одинаковые).
func TestConcurrentCreateUniqueSortOrder(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	base := "/api/v1/shops/" + shop.ID
	var tab struct {
		ID string `json:"id"`
	}
	c.mustJSON("POST", base+"/tabs", map[string]string{"title": "База", "slug": "base-tab"}, http.StatusCreated, &tab)

	const n = 8
	run := func(path string, body func(i int) map[string]string) {
		var wg sync.WaitGroup
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				if code, raw := c.do("POST", path, body(i)); code != http.StatusCreated {
					t.Errorf("POST %s: %d %s", path, code, raw)
				}
			}(i)
		}
		wg.Wait()
	}
	run(base+"/categories", func(i int) map[string]string {
		return map[string]string{"title": fmt.Sprint("К", i), "slug": fmt.Sprint("cat-", i)}
	})
	run(base+"/tabs", func(i int) map[string]string {
		return map[string]string{"title": fmt.Sprint("В", i), "slug": fmt.Sprint("tab-", i)}
	})
	run(base+"/tabs/"+tab.ID+"/sections", func(i int) map[string]string {
		return map[string]string{"title": fmt.Sprint("Р", i)}
	})
	for name, q := range map[string]string{
		"categories": `SELECT count(*) - count(DISTINCT sort_order) FROM categories WHERE shop_id = $1 AND parent_id IS NULL`,
		"tabs":       `SELECT count(*) - count(DISTINCT sort_order) FROM tabs WHERE shop_id = $1`,
		"sections":   `SELECT count(*) - count(DISTINCT s.sort_order) FROM sections s JOIN tabs t ON t.id = s.tab_id WHERE t.shop_id = $1 AND t.slug = 'base-tab'`,
	} {
		var dups int
		if err := env.pool.QueryRow(t.Context(), q, shop.ID).Scan(&dups); err != nil {
			t.Fatal(err)
		}
		if dups != 0 {
			t.Errorf("%s: %d duplicate sort_order values", name, dups)
		}
	}
}
