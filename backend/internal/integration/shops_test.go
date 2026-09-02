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

// TestWhatsAppNumberValidated: номер WhatsApp обязан быть номером.
//
// Витрина строит ссылку как wa.me/<цифры>, выбрасывая всё остальное. Ник
// или адрес почты превращались в ссылку вообще без получателя: покупатель
// жмёт главную кнопку продукта и попадает в пустоту, а продавец не узнаёт —
// у себя на телефоне ссылка откроется. Кабинет пишет «только цифры», но
// до сих пор ничто этого не проверяло.
func TestWhatsAppNumberValidated(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	bad := map[string]string{
		"ник вместо номера":     "@myshop",
		"почта":                 "shop@example.com",
		"слишком короткий":      "12345",
		"российская запись с 8": "8 999 123-45-67",
	}
	for name, value := range bad {
		t.Run(name, func(t *testing.T) {
			status, body := c.do("PATCH", "/api/v1/shops/"+shop.ID,
				map[string]any{"contacts": map[string]string{"whatsapp": value}})
			if status != http.StatusBadRequest {
				t.Fatalf("значение %q принято: status %d, want 400; body: %s", value, status, body)
			}
		})
	}

	// Международный формат проходит — и с разделителями, которые продавец
	// наверняка наберёт руками.
	for _, ok := range []string{"79991234567", "+7 999 123-45-67"} {
		c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID,
			map[string]any{"contacts": map[string]string{"whatsapp": ok}}, http.StatusOK, nil)
	}

	// Пустое значение — способ убрать канал, он должен остаться рабочим.
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID,
		map[string]any{"contacts": map[string]string{"whatsapp": ""}}, http.StatusOK, nil)
}
