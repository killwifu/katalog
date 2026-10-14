package integration

import (
	"net/http"
	"testing"
)

// Настоящее уведомление ЮKassa несёт больше полей, чем читает наш код
// (paid, created_at, test, authorization_details, payment_method.card…).
// Строгий разбор с запретом неизвестных полей отвечал на него 400, и оплата
// проходила только ночной сверкой. Тело — по формату из документации ЮKassa.
func TestWebhookAcceptsFullYooKassaPayload(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	var sub struct {
		PaymentID string `json:"payment_id"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/subscribe",
		map[string]string{"plan": "basic"}, http.StatusOK, &sub)
	p := env.yk.succeedByOurID(t, sub.PaymentID)

	body := map[string]any{
		"type":  "notification",
		"event": "payment.succeeded",
		"object": map[string]any{
			"id":            p.ID,
			"status":        "succeeded",
			"paid":          true,
			"amount":        map[string]any{"value": p.Amount.Value, "currency": p.Amount.Currency},
			"income_amount": map[string]any{"value": p.Amount.Value, "currency": p.Amount.Currency},
			"authorization_details": map[string]any{
				"rrn": "10000000000", "auth_code": "000000",
				"three_d_secure": map[string]any{"applied": true},
			},
			"created_at":  "2026-10-08T10:27:54.691Z",
			"captured_at": "2026-10-08T10:28:10.210Z",
			"description": "Подписка Katalog",
			"metadata":    p.Metadata,
			"payment_method": map[string]any{
				"type": "bank_card", "id": p.ID, "saved": true, "title": "Bank card *4444",
				"card": map[string]any{
					"first6": "555555", "last4": "4444", "expiry_month": "07", "expiry_year": "2030",
					"card_type": "MasterCard", "issuer_country": "RU",
				},
			},
			"recipient":       map[string]any{"account_id": "100500", "gateway_id": "100700"},
			"refundable":      true,
			"refunded_amount": map[string]any{"value": "0.00", "currency": "RUB"},
			"test":            false,
		},
	}
	postWebhook(c, body, http.StatusOK)

	if b := getBilling(c, shop.ID); b.Plan != "basic" || b.PaidUntil == nil {
		t.Fatalf("after real-format webhook: plan=%s paid_until=%v", b.Plan, b.PaidUntil)
	}
}
