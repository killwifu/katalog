package integration

import (
	"net/http"
	"strings"
	"testing"
)

// TestShopDescriptionLimit: описание магазина ограничено по длине.
// Оно уходит в публичную выдачу на каждый заход покупателя, а лимита
// не было вовсе — влезали десятки тысяч символов.
func TestShopDescriptionLimit(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	long := strings.Repeat("я", 1001)
	status, raw := c.do("PATCH", "/api/v1/shops/"+shop.ID, map[string]any{"description": long})
	if status != http.StatusBadRequest {
		t.Fatalf("длинное описание принято: status %d, want 400; body: %s", status, raw)
	}

	// Ровно по границе — проходит.
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID,
		map[string]any{"description": strings.Repeat("я", 1000)}, http.StatusOK, nil)

	// И на создании тоже.
	status, raw = c.do("POST", "/api/v1/shops",
		map[string]any{"slug": uniqueSlug(), "name": "X", "description": long})
	if status != http.StatusBadRequest {
		t.Fatalf("длинное описание принято при создании: status %d, want 400; body: %s", status, raw)
	}
}
