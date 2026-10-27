package integration

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"katalog/backend/internal/tasks"
)

// Тарифы v2 (макет 18 · «Подписка»). Цены тестового конфига: standard 390,
// pro 890, business 1 690 ₽/мес; месяц — 30 дней, год — 365 дней и −25%.

type quoteJSON struct {
	Action    string    `json:"action"`
	Kind      string    `json:"kind"`
	Period    string    `json:"period"`
	AmountRub int64     `json:"amount_rub"`
	Days      int       `json:"days"`
	PeriodEnd time.Time `json:"period_end"`
}

func getQuote(c *client, shopID, plan, period string) quoteJSON {
	c.t.Helper()
	var q quoteJSON
	c.mustJSON("GET", "/api/v1/shops/"+shopID+"/billing/quote?plan="+plan+"&period="+period, nil, http.StatusOK, &q)
	return q
}

func subscribe(c *client, shopID, plan, period string) string {
	c.t.Helper()
	var sub struct {
		PaymentID string `json:"payment_id"`
		Scheduled bool   `json:"scheduled"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shopID+"/billing/subscribe",
		map[string]string{"plan": plan, "period": period}, http.StatusOK, &sub)
	return sub.PaymentID
}

// paidShop — магазин на оплаченном помесячном тарифе, до конца периода
// daysLeft дней (+1 час, чтобы округление вверх дало ровно daysLeft).
func paidShop(t *testing.T, c *client, plan string, daysLeft int, pm string) shopJSON {
	t.Helper()
	shop := createShop(c)
	end := time.Now().Add(time.Duration(daysLeft)*24*time.Hour - time.Hour)
	mustExec(t, "UPDATE shops SET plan = $2, paid_until = $3 WHERE id = $1", shop.ID, plan, end)
	mustExec(t, `INSERT INTO subscriptions (shop_id, plan, status, period_start, period_end, payment_method_id)
		VALUES ($1, $2, 'active', $3::timestamptz - interval '30 days', $3, $4)`, shop.ID, plan, end, pm)
	return shop
}

func payByOurID(c *client, paymentID string) {
	c.t.Helper()
	postWebhook(c, ykNotification("payment.succeeded", env.yk.succeedByOurID(c.t, paymentID)), http.StatusOK)
}

func ykAmount(t *testing.T, paymentID string) string {
	t.Helper()
	env.yk.mu.Lock()
	defer env.yk.mu.Unlock()
	for _, p := range env.yk.payments {
		if p.Metadata["payment_id"] == paymentID {
			return p.Amount.Value
		}
	}
	t.Fatalf("payment %s not found in fake yookassa", paymentID)
	return ""
}

// TestUpgradeProration: переход выше — доплата разницы за оставшиеся дни,
// дата следующего списания не меняется: (1 690 − 890) ÷ 30 × 9 = 240 ₽.
func TestUpgradeProration(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := paidShop(t, c, "pro", 9, "pm-up-1")
	before := getBilling(c, shop.ID)

	q := getQuote(c, shop.ID, "business", "month")
	if q.Action != "pay" || q.Kind != "upgrade" || q.Days != 9 || q.AmountRub != 240 {
		t.Fatalf("quote: %+v, want pay/upgrade 9 days 240 ₽", q)
	}
	pid := subscribe(c, shop.ID, "business", "month")
	if got := ykAmount(t, pid); got != "240.00" {
		t.Fatalf("yookassa amount %s, want 240.00", got)
	}
	payByOurID(c, pid)

	b := getBilling(c, shop.ID)
	if b.Plan != "business" || b.Subscription.Plan != "business" {
		t.Fatalf("after upgrade: %+v", b)
	}
	if !b.Subscription.PeriodEnd.Equal(before.Subscription.PeriodEnd) {
		t.Fatalf("upgrade moved period_end: %s -> %s", before.Subscription.PeriodEnd, b.Subscription.PeriodEnd)
	}

	// История: доплата отдельной строкой, с прежним тарифом.
	var hist struct {
		Payments []struct {
			Plan      string  `json:"plan"`
			FromPlan  *string `json:"from_plan"`
			Kind      string  `json:"kind"`
			AmountRub int64   `json:"amount_rub"`
			Status    string  `json:"status"`
			PeriodEnd *string `json:"period_end"`
		} `json:"payments"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/billing/payments", nil, http.StatusOK, &hist)
	if len(hist.Payments) != 1 {
		t.Fatalf("history: %+v", hist.Payments)
	}
	h := hist.Payments[0]
	if h.Kind != "upgrade" || h.FromPlan == nil || *h.FromPlan != "pro" || h.AmountRub != 240 ||
		h.Status != "succeeded" || h.PeriodEnd == nil {
		t.Fatalf("history row: %+v", h)
	}
}

// TestSwitchToYear: переход с помесячной на годовую — год начинается сразу,
// остаток месяца засчитан: 8 010 − 890 ÷ 30 × 9 = 7 743 ₽.
func TestSwitchToYear(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := paidShop(t, c, "pro", 9, "pm-year-1")

	q := getQuote(c, shop.ID, "pro", "year")
	if q.Action != "pay" || q.Kind != "switch" || q.AmountRub != 7743 {
		t.Fatalf("quote: %+v, want pay/switch 7743 ₽", q)
	}
	payByOurID(c, subscribe(c, shop.ID, "pro", "year"))
	b := getBilling(c, shop.ID)
	if b.Plan != "pro" || b.Subscription.Period != "year" {
		t.Fatalf("after switch: %+v", b.Subscription)
	}
	if d := time.Until(b.Subscription.PeriodEnd) - 365*24*time.Hour; d < -time.Hour || d > time.Hour {
		t.Fatalf("year period_end %s, want ~now+365d", b.Subscription.PeriodEnd)
	}
	// Тот же тариф и период — это текущий тариф.
	if q := getQuote(c, shop.ID, "pro", "year"); q.Action != "current" {
		t.Fatalf("quote for current plan: %+v", q)
	}
	// С бесплатного годовая оплата — полная цена за год.
	other := newClient(t)
	registerUser(other)
	free := createShop(other)
	if q := getQuote(other, free.ID, "standard", "year"); q.Action != "pay" || q.AmountRub != 3510 {
		t.Fatalf("free -> standard yearly: %+v, want 3510 ₽", q)
	}
}

// TestDowngradeScheduled: переход ниже — с конца оплаченного периода,
// без оплаты; при автосписании берётся цена нового тарифа.
func TestDowngradeScheduled(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := paidShop(t, c, "pro", 1, "pm-down-1")

	if q := getQuote(c, shop.ID, "standard", "month"); q.Action != "schedule" {
		t.Fatalf("quote standard: %+v, want schedule", q)
	}
	subscribe(c, shop.ID, "standard", "month")
	b := getBilling(c, shop.ID)
	if b.Plan != "pro" || b.Subscription.NextPlan == nil || *b.Subscription.NextPlan != "standard" {
		t.Fatalf("after scheduling: plan %s, sub %+v", b.Plan, b.Subscription)
	}

	if err := env.processor.HandleBillingRenew(ctx, tasks.NewBillingRenew()); err != nil {
		t.Fatalf("renew: %v", err)
	}
	var providerID, plan string
	if err := env.pool.QueryRow(ctx,
		"SELECT provider_payment_id, plan::text FROM payments WHERE shop_id = $1 AND recurring", shop.ID).
		Scan(&providerID, &plan); err != nil {
		t.Fatalf("recurring payment: %v", err)
	}
	p := env.yk.get(t, providerID)
	if plan != "standard" || p.Amount.Value != "390.00" {
		t.Fatalf("renewal charged %s for %s, want 390.00 for standard", p.Amount.Value, plan)
	}
	postWebhook(c, ykNotification("payment.succeeded", p), http.StatusOK)
	b = getBilling(c, shop.ID)
	if b.Plan != "standard" || b.Subscription.NextPlan != nil {
		t.Fatalf("after renewal: plan %s, sub %+v", b.Plan, b.Subscription)
	}

	// На Бесплатный = отключить автопродление; включить обратно — без оплаты.
	subscribe(c, shop.ID, "free", "month")
	if b := getBilling(c, shop.ID); b.Subscription.Status != "canceled" || b.Subscription.AutoRenew {
		t.Fatalf("after downgrade to free: %+v", b.Subscription)
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/resume", nil, http.StatusNoContent, nil)
	if b := getBilling(c, shop.ID); b.Subscription.Status != "active" || !b.Subscription.AutoRenew {
		t.Fatalf("after resume: %+v", b.Subscription)
	}
}

// TestRenewalFailedNoRetry: автосписание не прошло — повторов нет, тариф
// заканчивается в срок, аккаунт на Бесплатном; строка «Не прошёл» в истории.
func TestRenewalFailedNoRetry(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := paidShop(t, c, "pro", 1, "pm-fail-1")

	if err := env.processor.HandleBillingRenew(ctx, tasks.NewBillingRenew()); err != nil {
		t.Fatalf("renew: %v", err)
	}
	var providerID string
	if err := env.pool.QueryRow(ctx,
		"SELECT provider_payment_id FROM payments WHERE shop_id = $1 AND recurring", shop.ID).Scan(&providerID); err != nil {
		t.Fatalf("recurring payment: %v", err)
	}
	postWebhook(c, ykNotification("payment.canceled", env.yk.get(t, providerID)), http.StatusOK)

	if err := env.processor.HandleBillingRenew(ctx, tasks.NewBillingRenew()); err != nil {
		t.Fatalf("renew 2: %v", err)
	}
	var n int
	if err := env.pool.QueryRow(ctx, "SELECT count(*) FROM payments WHERE shop_id = $1", shop.ID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("payments after failed renewal: %d, want 1 (no retry)", n)
	}

	mustExec(t, "UPDATE subscriptions SET period_end = now() - interval '1 minute' WHERE shop_id = $1", shop.ID)
	mustExec(t, "UPDATE shops SET paid_until = now() - interval '1 minute' WHERE id = $1", shop.ID)
	if err := env.processor.HandleBillingLifecycle(ctx, tasks.NewBillingLifecycle()); err != nil {
		t.Fatalf("lifecycle: %v", err)
	}
	if b := getBilling(c, shop.ID); b.Plan != "free" || b.Subscription.Status != "expired" {
		t.Fatalf("after failed renewal: %+v", b)
	}
}

// TestFailedManualPayment: отменённая оплата — плашка «Оплата не прошла».
func TestFailedManualPayment(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	pid := subscribe(c, shop.ID, "pro", "month")
	postWebhook(c, ykNotification("payment.canceled", env.yk.cancelByOurID(t, pid)), http.StatusOK)
	b := getBilling(c, shop.ID)
	if b.Plan != "free" || b.FailedPayment == nil || b.FailedPayment.Plan != "pro" {
		t.Fatalf("failed payment not reported: %+v", b)
	}
}

// TestTrial: пробный «Про» 7 дней без карты, один раз на аккаунт; оплата
// во время пробного начинается после него; по окончании — Бесплатный.
func TestTrial(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	if b := getBilling(c, shop.ID); !b.TrialAvailable {
		t.Fatal("trial not offered to a new shop")
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/trial", nil, http.StatusNoContent, nil)
	b := getBilling(c, shop.ID)
	if b.Plan != "pro" || b.TrialEndsAt == nil || b.TrialAvailable {
		t.Fatalf("after trial start: %+v", b)
	}
	if status, body := c.do("POST", "/api/v1/shops/"+shop.ID+"/billing/trial", nil); status != http.StatusConflict ||
		!strings.Contains(string(body), "trial_unavailable") {
		t.Fatalf("second trial: %d %s", status, body)
	}
	// Аналитика на пробном доступна.
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/stats?days=7", nil, http.StatusOK, nil)

	// Оплата «Про» во время пробного: оставшиеся дни сохраняются.
	q := getQuote(c, shop.ID, "pro", "month")
	if q.Action != "pay" || q.AmountRub != 890 {
		t.Fatalf("quote during trial: %+v", q)
	}
	if d := time.Until(q.PeriodEnd) - 37*24*time.Hour; d < -time.Hour || d > time.Hour {
		t.Fatalf("paid period after trial ends %s, want ~now+37d", q.PeriodEnd)
	}

	// Не оплатили — 7 дней прошли, аккаунт на Бесплатном.
	mustExec(t, "UPDATE shops SET paid_until = now() - interval '1 minute', trial_ends_at = now() - interval '1 minute' WHERE id = $1", shop.ID)
	if err := env.processor.HandleBillingLifecycle(ctx, tasks.NewBillingLifecycle()); err != nil {
		t.Fatalf("lifecycle: %v", err)
	}
	if b := getBilling(c, shop.ID); b.Plan != "free" || b.TrialAvailable || b.TrialEndsAt == nil {
		t.Fatalf("after trial end: %+v", b)
	}
}

// TestFreePlanRestrictions: на Бесплатном аналитика и включение водяного
// знака закрыты на сервере (403 с кодом), не только в кабинете.
func TestFreePlanRestrictions(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	wmSettings := map[string]any{"settings": map[string]any{
		"watermark": map[string]any{"enabled": true, "text": "shop", "opacity": 0.5, "position": "br"},
	}}
	albumWM := map[string]any{"watermark": map[string]any{"enabled": true, "position": "br"}}

	for _, probe := range []struct {
		method, path string
		body         any
		code         string
	}{
		{"GET", "/api/v1/shops/" + shop.ID + "/stats?days=7", nil, "analytics_plan_required"},
		{"GET", "/api/v1/shops/" + shop.ID + "/albums/" + album.ID + "/stats", nil, "analytics_plan_required"},
		{"PATCH", "/api/v1/shops/" + shop.ID, wmSettings, "watermark_plan_required"},
		{"PATCH", "/api/v1/shops/" + shop.ID + "/albums/" + album.ID, albumWM, "watermark_plan_required"},
		{"POST", "/api/v1/shops/" + shop.ID + "/albums", map[string]any{"title": "x", "watermark": albumWM["watermark"]}, "watermark_plan_required"},
		{"PATCH", "/api/v1/shops/" + shop.ID + "/albums/" + album.ID, map[string]any{"password": "secret1"}, "password_plan_required"},
	} {
		status, body := c.do(probe.method, probe.path, probe.body)
		if status != http.StatusForbidden || !strings.Contains(string(body), probe.code) {
			t.Errorf("%s %s on free: %d %s, want 403 %s", probe.method, probe.path, status, body, probe.code)
		}
	}

	// На платном — можно; после перехода на Бесплатный включённый знак
	// остаётся и сохранение прочих настроек не ломается.
	mustExec(t, "UPDATE shops SET plan = 'standard' WHERE id = $1", shop.ID)
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/stats?days=7", nil, http.StatusOK, nil)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, wmSettings, http.StatusOK, nil)
	mustExec(t, "UPDATE shops SET plan = 'free' WHERE id = $1", shop.ID)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, wmSettings, http.StatusOK, nil)
}
