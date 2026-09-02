package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/tasks"
)

// fakeYooKassa — минимальный эмулятор API ЮKassa для интеграционных тестов:
// POST /payments создаёт платёж, GET /payments/{id} отдаёт его состояние.
// Рекуррентный платёж (с payment_method_id) «оплачивается» сразу; обычный
// висит в pending, пока тест не вызовет succeed().
type fakeYooKassa struct {
	mu       sync.Mutex
	seq      int
	payments map[string]*billing.Payment
	srv      *httptest.Server
}

func newFakeYooKassa() *fakeYooKassa {
	f := &fakeYooKassa{payments: map[string]*billing.Payment{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	return f
}

func (f *fakeYooKassa) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/payments":
		var req struct {
			Amount            billing.Amount    `json:"amount"`
			SavePaymentMethod bool              `json:"save_payment_method"`
			PaymentMethodID   string            `json:"payment_method_id"`
			Metadata          map[string]string `json:"metadata"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.seq++
		p := &billing.Payment{
			ID:       fmt.Sprintf("yk-%d", f.seq),
			Status:   billing.StatusPending,
			Amount:   req.Amount,
			Metadata: req.Metadata,
		}
		if req.PaymentMethodID != "" {
			// Автосписание по сохранённому способу оплаты проходит сразу.
			p.Status = billing.StatusSucceeded
			p.PaymentMethod = &billing.PaymentMethod{ID: req.PaymentMethodID, Saved: true}
		} else {
			p.Confirmation = &billing.Confirmation{
				Type:            "redirect",
				ConfirmationURL: "https://yookassa.test/confirm/" + p.ID,
			}
			if req.SavePaymentMethod {
				p.PaymentMethod = &billing.PaymentMethod{ID: "pm-" + p.ID, Saved: false}
			}
		}
		f.payments[p.ID] = p
		writeFakeJSON(w, p)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/payments/"):
		id := strings.TrimPrefix(r.URL.Path, "/payments/")
		p, ok := f.payments[id]
		if !ok {
			http.Error(w, `{"type":"error","code":"not_found"}`, http.StatusNotFound)
			return
		}
		writeFakeJSON(w, p)
	default:
		http.Error(w, "unexpected request: "+r.Method+" "+r.URL.Path, http.StatusNotFound)
	}
}

func writeFakeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// succeedByOurID «оплачивает» pending-платёж, найденный по metadata
// payment_id (id нашей записи payments), и сохраняет способ оплаты.
func (f *fakeYooKassa) succeedByOurID(t *testing.T, ourPaymentID string) *billing.Payment {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.payments {
		if p.Metadata["payment_id"] == ourPaymentID {
			p.Status = billing.StatusSucceeded
			if p.PaymentMethod != nil {
				p.PaymentMethod.Saved = true
			}
			return p
		}
	}
	t.Fatalf("fake yookassa: payment with metadata payment_id=%s not found", ourPaymentID)
	return nil
}

func (f *fakeYooKassa) get(t *testing.T, id string) *billing.Payment {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.payments[id]
	if !ok {
		t.Fatalf("fake yookassa: payment %s not found", id)
	}
	return p
}

// notification — тело вебхука ЮKassa для платежа.
func ykNotification(event string, p *billing.Payment) map[string]any {
	return map[string]any{
		"type":   "notification",
		"event":  event,
		"object": p,
	}
}

// postWebhook доставляет вебхук ЮKassa в API (без сессии, как сама ЮKassa).
func postWebhook(c *client, body map[string]any, wantStatus int) {
	c.t.Helper()
	status, raw := c.do("POST", "/api/v1/billing/webhooks/yookassa", body)
	if status != wantStatus {
		c.t.Fatalf("webhook: status %d, want %d; body: %s", status, wantStatus, raw)
	}
}

type billingJSON struct {
	Plan         string  `json:"plan"`
	BillingState string  `json:"billing_state"`
	PaidUntil    *string `json:"paid_until"`
	Usage        struct {
		Photos      int64 `json:"photos"`
		StorageUsed int64 `json:"storage_used"`
	} `json:"usage"`
	Limits struct {
		MaxPhotos  int64 `json:"max_photos"`
		MaxStorage int64 `json:"max_storage"`
	} `json:"limits"`
	Subscription *struct {
		Plan      string    `json:"plan"`
		Status    string    `json:"status"`
		PeriodEnd time.Time `json:"period_end"`
		AutoRenew bool      `json:"auto_renew"`
	} `json:"subscription"`
	Plans []struct {
		ID       string `json:"id"`
		PriceRub int64  `json:"price_rub"`
	} `json:"plans"`
}

func getBilling(c *client, shopID string) billingJSON {
	c.t.Helper()
	var b billingJSON
	c.mustJSON("GET", "/api/v1/shops/"+shopID+"/billing", nil, http.StatusOK, &b)
	return b
}

// TestSubscribeAndWebhook: оплата тарифа через ЮKassa активирует подписку,
// повторная доставка вебхука идемпотентна, отмена отключает автопродление.
func TestSubscribeAndWebhook(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	free := getBilling(c, shop.ID)
	if free.Plan != "free" || free.BillingState != "ok" || free.Subscription != nil {
		t.Fatalf("fresh shop billing: %+v", free)
	}
	if len(free.Plans) != 3 {
		t.Fatalf("plans list: %+v", free.Plans)
	}

	var sub struct {
		PaymentID       string `json:"payment_id"`
		ConfirmationURL string `json:"confirmation_url"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/subscribe",
		map[string]string{"plan": "basic"}, http.StatusOK, &sub)
	if sub.ConfirmationURL == "" {
		t.Fatal("subscribe: empty confirmation_url")
	}

	// «Оплата» на стороне ЮKassa + вебхук payment.succeeded.
	p := env.yk.succeedByOurID(t, sub.PaymentID)
	postWebhook(c, ykNotification("payment.succeeded", p), http.StatusOK)

	paid := getBilling(c, shop.ID)
	if paid.Plan != "basic" || paid.BillingState != "ok" || paid.PaidUntil == nil {
		t.Fatalf("after payment: %+v", paid)
	}
	if paid.Subscription == nil || paid.Subscription.Status != "active" || !paid.Subscription.AutoRenew {
		t.Fatalf("after payment subscription: %+v", paid.Subscription)
	}
	wantEnd := time.Now().Add(30 * 24 * time.Hour)
	if d := paid.Subscription.PeriodEnd.Sub(wantEnd); d < -time.Hour || d > time.Hour {
		t.Fatalf("period_end %s, want ~%s", paid.Subscription.PeriodEnd, wantEnd)
	}

	// Повторная доставка того же вебхука — 200 и никакого второго продления.
	postWebhook(c, ykNotification("payment.succeeded", p), http.StatusOK)
	again := getBilling(c, shop.ID)
	if !again.Subscription.PeriodEnd.Equal(paid.Subscription.PeriodEnd) {
		t.Fatalf("webhook redelivery extended period: %s -> %s",
			paid.Subscription.PeriodEnd, again.Subscription.PeriodEnd)
	}
	if *again.PaidUntil != *paid.PaidUntil {
		t.Fatalf("webhook redelivery moved paid_until: %s -> %s", *paid.PaidUntil, *again.PaidUntil)
	}

	// Отмена: тариф действует до конца периода, автопродление выключено.
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/cancel", nil, http.StatusNoContent, nil)
	canceled := getBilling(c, shop.ID)
	if canceled.Subscription.Status != "canceled" || canceled.Subscription.AutoRenew {
		t.Fatalf("after cancel: %+v", canceled.Subscription)
	}
	if canceled.Plan != "basic" || canceled.BillingState != "ok" {
		t.Fatalf("cancel must not drop the plan immediately: %+v", canceled)
	}
}

// TestBillingTenantIsolation: чужой магазин в биллинговых эндпоинтах — 404.
func TestBillingTenantIsolation(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)

	stranger := newClient(t)
	registerUser(stranger)
	for _, probe := range []struct{ method, path string }{
		{"GET", "/api/v1/shops/" + shop.ID + "/billing"},
		{"POST", "/api/v1/shops/" + shop.ID + "/billing/subscribe"},
		{"POST", "/api/v1/shops/" + shop.ID + "/billing/cancel"},
	} {
		status, body := stranger.do(probe.method, probe.path, map[string]string{"plan": "basic"})
		if status != http.StatusNotFound {
			t.Fatalf("%s %s: status %d, want 404; body: %s", probe.method, probe.path, status, body)
		}
	}
}

// TestPhotoQuotaExceeded: presign сверх лимита фото тарифа -> мягкий 403.
func TestPhotoQuotaExceeded(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	// Лимит free в тестовом конфиге — 8 фото; слот занимает уже presign.
	for range 8 {
		var pre presignJSON
		c.mustJSON("POST", "/api/v1/uploads/presign",
			map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000},
			http.StatusOK, &pre)
	}
	status, body := c.do("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000})
	if status != http.StatusForbidden || !strings.Contains(string(body), "photo_quota_exceeded") {
		t.Fatalf("presign over photo quota: status %d, body %s", status, body)
	}
}

// TestUploadBlockedWhenSubscriptionInactive: в grace и suspended загрузка
// заблокирована мягким 403 с понятным кодом ошибки.
func TestUploadBlockedWhenSubscriptionInactive(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	for _, state := range []string{"grace", "suspended"} {
		if _, err := env.pool.Exec(context.Background(),
			"UPDATE shops SET billing_state = $2 WHERE id = $1", shop.ID, state); err != nil {
			t.Fatalf("set billing_state %s: %v", state, err)
		}
		status, body := c.do("POST", "/api/v1/uploads/presign",
			map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1000})
		if status != http.StatusForbidden || !strings.Contains(string(body), "subscription_inactive") {
			t.Fatalf("presign in %s: status %d, body %s", state, status, body)
		}
	}
}

// TestBillingLifecycle: активна -> grace (витрина работает, загрузка
// заблокирована) -> suspended (витрина скрыта). Контент не удаляется.
func TestBillingLifecycle(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	photoID := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))
	waitPhotoStatus(c, shop.ID, album.ID, photoID, "ready", 60*time.Second)

	// Оплаченный basic, срок истёк час назад.
	mustExec(t, "UPDATE shops SET plan = 'basic', paid_until = now() - interval '1 hour' WHERE id = $1", shop.ID)
	mustExec(t, `INSERT INTO subscriptions (shop_id, plan, status, period_start, period_end)
		VALUES ($1, 'basic', 'active', now() - interval '30 days', now() - interval '1 hour')`, shop.ID)

	if err := env.processor.HandleBillingLifecycle(ctx, tasks.NewBillingLifecycle()); err != nil {
		t.Fatalf("lifecycle run 1: %v", err)
	}
	b := getBilling(c, shop.ID)
	if b.BillingState != "grace" || b.Subscription.Status != "past_due" {
		t.Fatalf("after run 1: state %s, sub %+v", b.BillingState, b.Subscription)
	}
	// В grace витрина продолжает работать.
	if status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status != http.StatusOK {
		t.Fatalf("public shop in grace: status %d, want 200", status)
	}

	// Повторный запуск ничего не меняет (идемпотентность).
	if err := env.processor.HandleBillingLifecycle(ctx, tasks.NewBillingLifecycle()); err != nil {
		t.Fatalf("lifecycle run 2: %v", err)
	}
	if b := getBilling(c, shop.ID); b.BillingState != "grace" {
		t.Fatalf("lifecycle not idempotent: state %s", b.BillingState)
	}

	// Grace истёк (14 дней в тестовом конфиге) -> витрина скрывается.
	mustExec(t, "UPDATE shops SET paid_until = now() - interval '15 days' WHERE id = $1", shop.ID)
	if err := env.processor.HandleBillingLifecycle(ctx, tasks.NewBillingLifecycle()); err != nil {
		t.Fatalf("lifecycle run 3: %v", err)
	}
	b = getBilling(c, shop.ID)
	if b.BillingState != "suspended" || b.Subscription.Status != "expired" {
		t.Fatalf("after run 3: state %s, sub %+v", b.BillingState, b.Subscription)
	}
	// 410, а не 404: витрина скрыта, но покупатель должен получить контакты
	// продавца и суметь написать — подробнее в TestShopUnavailable.
	if status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status != http.StatusGone {
		t.Fatalf("public shop when suspended: status %d, want 410", status)
	}

	// Контент не удалён: фото на месте, кабинет работает.
	var photoPage struct {
		Photos []photoJSON `json:"photos"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/photos", nil, http.StatusOK, &photoPage)
	photos := photoPage.Photos
	if len(photos) != 1 || photos[0].Status != "ready" {
		t.Fatalf("content after suspension: %+v", photos)
	}

	// Оплата возвращает магазин в строй: subscribe -> вебхук -> ok + витрина.
	var sub struct {
		PaymentID string `json:"payment_id"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/subscribe",
		map[string]string{"plan": "basic"}, http.StatusOK, &sub)
	p := env.yk.succeedByOurID(t, sub.PaymentID)
	postWebhook(c, ykNotification("payment.succeeded", p), http.StatusOK)
	b = getBilling(c, shop.ID)
	if b.BillingState != "ok" || b.Plan != "basic" {
		t.Fatalf("after repayment: %+v", b)
	}
	if status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status != http.StatusOK {
		t.Fatalf("public shop after repayment: status %d, want 200", status)
	}
}

// TestRecurringRenewal: ежедневный джоб создаёт автосписание по сохранённому
// способу оплаты, вебхук продлевает подписку.
func TestRecurringRenewal(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	// Активная подписка с сохранённым способом оплаты, истекает через час.
	mustExec(t, "UPDATE shops SET plan = 'basic', paid_until = now() + interval '1 hour' WHERE id = $1", shop.ID)
	mustExec(t, `INSERT INTO subscriptions (shop_id, plan, status, period_start, period_end, payment_method_id)
		VALUES ($1, 'basic', 'active', now() - interval '29 days', now() + interval '1 hour', 'pm-saved-1')`, shop.ID)

	if err := env.processor.HandleBillingRenew(ctx, tasks.NewBillingRenew()); err != nil {
		t.Fatalf("renew run: %v", err)
	}

	// Джоб создал платёж в ЮKassa по payment_method_id (без confirmation).
	var providerID string
	err := env.pool.QueryRow(ctx,
		"SELECT provider_payment_id FROM payments WHERE shop_id = $1 AND recurring", shop.ID).Scan(&providerID)
	if err != nil {
		t.Fatalf("recurring payment row: %v", err)
	}
	p := env.yk.get(t, providerID)
	if p.Status != billing.StatusSucceeded || p.PaymentMethod == nil || p.PaymentMethod.ID != "pm-saved-1" {
		t.Fatalf("recurring yookassa payment: %+v", p)
	}
	if p.Amount.Value != "490.00" {
		t.Fatalf("recurring amount: %s, want 490.00", p.Amount.Value)
	}

	// Повторный запуск джоба не создаёт второго списания (pending-платёж уже есть).
	if err := env.processor.HandleBillingRenew(ctx, tasks.NewBillingRenew()); err != nil {
		t.Fatalf("renew run 2: %v", err)
	}
	var cnt int
	if err := env.pool.QueryRow(ctx,
		"SELECT count(*) FROM payments WHERE shop_id = $1 AND recurring", shop.ID).Scan(&cnt); err != nil {
		t.Fatalf("count recurring payments: %v", err)
	}
	if cnt != 1 {
		t.Fatalf("recurring payments: %d, want 1", cnt)
	}

	// Вебхук продлевает подписку от прежнего period_end.
	postWebhook(c, ykNotification("payment.succeeded", p), http.StatusOK)
	b := getBilling(c, shop.ID)
	if b.BillingState != "ok" || b.Subscription.Status != "active" {
		t.Fatalf("after renewal webhook: %+v", b)
	}
	wantEnd := time.Now().Add(time.Hour + 30*24*time.Hour)
	if d := b.Subscription.PeriodEnd.Sub(wantEnd); d < -time.Hour || d > time.Hour {
		t.Fatalf("renewed period_end %s, want ~%s", b.Subscription.PeriodEnd, wantEnd)
	}
}

// TestWebhookCanceledPayment: отменённый платёж не меняет тариф.
func TestWebhookCanceledPayment(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	var sub struct {
		PaymentID string `json:"payment_id"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/subscribe",
		map[string]string{"plan": "pro"}, http.StatusOK, &sub)

	// Платёж отменён на стороне ЮKassa (пользователь не оплатил).
	env.yk.mu.Lock()
	var p *billing.Payment
	for _, cand := range env.yk.payments {
		if cand.Metadata["payment_id"] == sub.PaymentID {
			p = cand
			p.Status = billing.StatusCanceled
		}
	}
	env.yk.mu.Unlock()
	if p == nil {
		t.Fatal("payment not found in fake yookassa")
	}

	postWebhook(c, ykNotification("payment.canceled", p), http.StatusOK)
	b := getBilling(c, shop.ID)
	if b.Plan != "free" || b.Subscription != nil {
		t.Fatalf("canceled payment must not activate plan: %+v", b)
	}
	var status string
	if err := env.pool.QueryRow(context.Background(),
		"SELECT status FROM payments WHERE id = $1", sub.PaymentID).Scan(&status); err != nil {
		t.Fatalf("payment row: %v", err)
	}
	if status != "canceled" {
		t.Fatalf("payment status %s, want canceled", status)
	}
}

// TestWebhookUnknownPayment: чужой/несуществующий платёж — не 2xx (ретрай).
func TestWebhookUnknownPayment(t *testing.T) {
	c := newClient(t)
	// Платёж существует в ЮKassa, но не зарегистрирован у нас.
	env.yk.mu.Lock()
	env.yk.seq++
	ghost := &billing.Payment{
		ID:     fmt.Sprintf("yk-ghost-%d", env.yk.seq),
		Status: billing.StatusSucceeded,
		Amount: billing.Amount{Value: "490.00", Currency: "RUB"},
	}
	env.yk.payments[ghost.ID] = ghost
	env.yk.mu.Unlock()

	postWebhook(c, ykNotification("payment.succeeded", ghost), http.StatusNotFound)
}

func mustExec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := env.pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

// cancelByOurID «отменяет» платёж в фейке по id нашей записи.
func (f *fakeYooKassa) cancelByOurID(t *testing.T, ourPaymentID string) *billing.Payment {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.payments {
		if p.Metadata["payment_id"] == ourPaymentID {
			p.Status = billing.StatusCanceled
			return p
		}
	}
	t.Fatalf("fake yookassa: payment with metadata payment_id=%s not found", ourPaymentID)
	return nil
}

// TestReconcileStuckPayments: недоставленное уведомление ЮKassa больше
// не замораживает магазин.
//
// Расчёт платежа запускает вебхук, и ретраи ЮKassa не вечны. Потерянное
// уведомление оставляло платёж в pending навсегда: деньги списаны, подписка
// не продлена, а следующее списание не начиналось — незакрытый платёж его
// блокировал. Магазин уезжал в grace и скрывался при рабочей карте.
func TestReconcileStuckPayments(t *testing.T) {
	ctx := context.Background()

	t.Run("оплаченный платёж досчитывается", func(t *testing.T) {
		c := newClient(t)
		registerUser(c)
		shop := createShop(c)

		var sub struct {
			PaymentID string `json:"payment_id"`
		}
		c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/subscribe",
			map[string]string{"plan": "pro"}, http.StatusOK, &sub)

		// В ЮKassa платёж прошёл, а уведомление до нас не доехало.
		env.yk.succeedByOurID(t, sub.PaymentID)
		mustExec(t, "UPDATE payments SET created_at = now() - interval '1 hour' WHERE id = $1", sub.PaymentID)

		before := getBilling(c, shop.ID)
		if before.Plan != "free" {
			t.Fatalf("до сверки тариф уже %s — платёж зачёлся сам", before.Plan)
		}

		if err := env.processor.HandleBillingReconcile(ctx, tasks.NewBillingReconcile()); err != nil {
			t.Fatalf("reconcile: %v", err)
		}

		after := getBilling(c, shop.ID)
		if after.Plan != "pro" || after.BillingState != "ok" {
			t.Fatalf("после сверки тариф %s / %s, ожидался pro / ok", after.Plan, after.BillingState)
		}
		var status string
		if err := env.pool.QueryRow(ctx,
			"SELECT status::text FROM payments WHERE id = $1", sub.PaymentID).Scan(&status); err != nil {
			t.Fatalf("read payment: %v", err)
		}
		if status != "succeeded" {
			t.Fatalf("платёж остался в статусе %q", status)
		}
	})

	t.Run("отменённый платёж закрывается", func(t *testing.T) {
		c := newClient(t)
		registerUser(c)
		shop := createShop(c)

		var sub struct {
			PaymentID string `json:"payment_id"`
		}
		c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/billing/subscribe",
			map[string]string{"plan": "basic"}, http.StatusOK, &sub)
		env.yk.cancelByOurID(t, sub.PaymentID)
		mustExec(t, "UPDATE payments SET created_at = now() - interval '1 hour' WHERE id = $1", sub.PaymentID)

		if err := env.processor.HandleBillingReconcile(ctx, tasks.NewBillingReconcile()); err != nil {
			t.Fatalf("reconcile: %v", err)
		}
		var status string
		if err := env.pool.QueryRow(ctx,
			"SELECT status::text FROM payments WHERE id = $1", sub.PaymentID).Scan(&status); err != nil {
			t.Fatalf("read payment: %v", err)
		}
		if status != "canceled" {
			t.Fatalf("платёж остался в статусе %q, ожидался canceled", status)
		}
		if b := getBilling(c, shop.ID); b.Plan != "free" {
			t.Fatalf("отменённый платёж поменял тариф на %s", b.Plan)
		}
	})

	t.Run("зависший платёж не блокирует продление навсегда", func(t *testing.T) {
		c := newClient(t)
		registerUser(c)
		shop := createShop(c)

		mustExec(t, "UPDATE shops SET plan = 'basic', paid_until = now() + interval '1 hour' WHERE id = $1", shop.ID)
		mustExec(t, `INSERT INTO subscriptions (shop_id, plan, status, period_start, period_end, payment_method_id)
			VALUES ($1, 'basic', 'active', now() - interval '29 days', now() + interval '1 hour', 'pm-stuck-1')`, shop.ID)
		// Платёж, зависший двое суток назад: ЮKassa о нём давно забыла.
		mustExec(t, `INSERT INTO payments (shop_id, plan, amount, currency, status, recurring, created_at)
			VALUES ($1, 'basic', 49000, 'RUB', 'pending', true, now() - interval '2 days')`, shop.ID)

		if err := env.processor.HandleBillingRenew(ctx, tasks.NewBillingRenew()); err != nil {
			t.Fatalf("renew: %v", err)
		}
		var fresh int
		if err := env.pool.QueryRow(ctx,
			`SELECT count(*) FROM payments WHERE shop_id = $1 AND created_at > now() - interval '1 minute'`,
			shop.ID).Scan(&fresh); err != nil {
			t.Fatalf("count payments: %v", err)
		}
		if fresh == 0 {
			t.Fatal("продление не состоялось: зависший платёж заблокировал списание")
		}
	})
}
