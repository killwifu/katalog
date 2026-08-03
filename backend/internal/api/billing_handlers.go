package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/db"
)

// Хендлеры тарифов и платежей. Поток оплаты:
// subscribe -> платёж в ЮKassa -> redirect на confirmation_url ->
// вебхук payment.succeeded -> подписка активна, план и paid_until на магазине.

// billingPlanIDs — порядок тарифов для витрины тарифов в кабинете.
var billingPlanIDs = []string{"free", "basic", "pro"}

type planInfo struct {
	ID         string `json:"id"`
	MaxPhotos  int64  `json:"max_photos"`
	MaxStorage int64  `json:"max_storage"`
	PriceRub   int64  `json:"price_rub"`
}

type subscriptionInfo struct {
	Plan      string    `json:"plan"`
	Status    string    `json:"status"`
	PeriodEnd time.Time `json:"period_end"`
	AutoRenew bool      `json:"auto_renew"`
}

type billingResponse struct {
	Plan         string     `json:"plan"`
	BillingState string     `json:"billing_state"`
	PaidUntil    *time.Time `json:"paid_until"`
	Usage        struct {
		Photos      int64 `json:"photos"`
		StorageUsed int64 `json:"storage_used"`
	} `json:"usage"`
	Limits       planInfo          `json:"limits"`
	Subscription *subscriptionInfo `json:"subscription"`
	Plans        []planInfo        `json:"plans"`
}

func (a *API) toPlanInfo(id string) planInfo {
	l := a.Cfg.Billing.Limits(id)
	return planInfo{
		ID:         id,
		MaxPhotos:  l.MaxPhotos,
		MaxStorage: l.MaxStorage,
		PriceRub:   l.PriceKopecks / 100,
	}
}

// handleGetBilling — тариф, лимиты, использование и подписка магазина.
func (a *API) handleGetBilling(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	photos, err := a.Q.CountShopPhotos(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "count shop photos", err)
		return
	}

	resp := billingResponse{
		Plan:         string(shop.Plan),
		BillingState: string(shop.BillingState),
		Limits:       a.toPlanInfo(string(shop.Plan)),
		Plans:        make([]planInfo, 0, len(billingPlanIDs)),
	}
	if shop.PaidUntil.Valid {
		resp.PaidUntil = &shop.PaidUntil.Time
	}
	resp.Usage.Photos = photos
	resp.Usage.StorageUsed = shop.StorageUsed
	for _, id := range billingPlanIDs {
		resp.Plans = append(resp.Plans, a.toPlanInfo(id))
	}

	sub, err := a.Q.GetSubscriptionByShop(r.Context(), shop.ID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		a.internalError(w, "load subscription", err)
		return
	}
	if err == nil {
		resp.Subscription = &subscriptionInfo{
			Plan:      string(sub.Plan),
			Status:    string(sub.Status),
			PeriodEnd: sub.PeriodEnd.Time,
			AutoRenew: sub.Status == db.SubscriptionStatusActive && sub.PaymentMethodID != nil,
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type subscribeRequest struct {
	Plan string `json:"plan"`
}

type subscribeResponse struct {
	PaymentID       string `json:"payment_id"`
	ConfirmationURL string `json:"confirmation_url"`
}

// handleSubscribe — создаёт платёж ЮKassa за платный тариф и возвращает
// confirmation_url для redirect. Активация тарифа — только по вебхуку.
func (a *API) handleSubscribe(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	if !a.Billing.Enabled() {
		apiError(w, http.StatusServiceUnavailable, "billing_unavailable", "payments are not configured")
		return
	}
	var req subscribeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	limits := a.Cfg.Billing.Limits(req.Plan)
	if limits.PriceKopecks <= 0 {
		apiError(w, http.StatusBadRequest, "invalid_plan", "plan must be a paid plan: basic or pro")
		return
	}

	pay, err := a.Q.CreatePayment(r.Context(), db.CreatePaymentParams{
		ShopID:   shop.ID,
		Plan:     db.ShopPlan(req.Plan),
		Amount:   limits.PriceKopecks,
		Currency: "RUB",
	})
	if err != nil {
		a.internalError(w, "create payment", err)
		return
	}
	yk, err := a.Billing.CreatePayment(r.Context(), pay.ID.String(), billing.CreatePaymentRequest{
		Amount:  billing.Amount{Value: billing.FormatKopecks(limits.PriceKopecks), Currency: "RUB"},
		Capture: true,
		Confirmation: &billing.Confirmation{
			Type:      "redirect",
			ReturnURL: a.Cfg.Billing.ReturnURL,
		},
		SavePaymentMethod: true,
		Description:       fmt.Sprintf("Katalog: тариф %s для %s", req.Plan, shop.Slug),
		Metadata: map[string]string{
			"payment_id": pay.ID.String(),
			"shop_id":    shop.ID.String(),
		},
	})
	if err != nil {
		a.Log.Error("subscribe: yookassa create payment failed", "error", err)
		if serr := a.Q.SetPaymentStatus(r.Context(), db.SetPaymentStatusParams{
			ID:     pay.ID,
			Status: db.PaymentStatusCanceled,
		}); serr != nil {
			a.Log.Error("subscribe: cancel failed payment", "payment_id", pay.ID, "error", serr)
		}
		apiError(w, http.StatusBadGateway, "payment_provider_error", "payment provider is unavailable, try again later")
		return
	}
	if err := a.Q.SetPaymentProvider(r.Context(), db.SetPaymentProviderParams{
		ID:                pay.ID,
		ProviderPaymentID: &yk.ID,
	}); err != nil {
		a.internalError(w, "save provider payment id", err)
		return
	}
	var confirmationURL string
	if yk.Confirmation != nil {
		confirmationURL = yk.Confirmation.ConfirmationURL
	}
	writeJSON(w, http.StatusOK, subscribeResponse{
		PaymentID:       pay.ID.String(),
		ConfirmationURL: confirmationURL,
	})
}

// handleCancelSubscription — отключает автопродление; тариф действует
// до конца оплаченного периода. Идемпотентен.
func (a *API) handleCancelSubscription(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	if _, err := a.Q.CancelSubscription(r.Context(), shop.ID); err != nil {
		a.internalError(w, "cancel subscription", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// yooKassaNotification — тело вебхука ЮKassa.
type yooKassaNotification struct {
	Type   string          `json:"type"`
	Event  string          `json:"event"`
	Object billing.Payment `json:"object"`
}

// handleYooKassaWebhook — приём уведомлений ЮKassa о статусах платежей.
// Уведомления не подписаны, поэтому статус перепроверяется прямым запросом
// GET /payments/{id} к ЮKassa — обрабатывается только подтверждённый статус.
// Идемпотентность: SettlePayment переводит платёж из pending ровно один раз,
// повторная доставка того же события — no-op с 200.
func (a *API) handleYooKassaWebhook(w http.ResponseWriter, r *http.Request) {
	if !a.Billing.Enabled() {
		apiError(w, http.StatusServiceUnavailable, "billing_unavailable", "payments are not configured")
		return
	}
	var note yooKassaNotification
	if !decodeJSON(w, r, &note) {
		return
	}
	if note.Object.ID == "" {
		apiError(w, http.StatusBadRequest, "invalid_notification", "object.id is required")
		return
	}
	verified, err := a.Billing.GetPayment(r.Context(), note.Object.ID)
	if err != nil {
		// Не 2xx -> ЮKassa доставит уведомление повторно.
		a.Log.Error("webhook: verify payment failed", "provider_payment_id", note.Object.ID, "error", err)
		apiError(w, http.StatusBadGateway, "payment_provider_error", "cannot verify payment")
		return
	}

	switch verified.Status {
	case billing.StatusSucceeded:
		err = a.settlePaymentSucceeded(r.Context(), verified)
	case billing.StatusCanceled:
		err = a.settlePaymentCanceled(r.Context(), verified)
	default:
		// pending / waiting_for_capture — ждём финального события.
	}
	if errors.Is(err, errUnknownPayment) {
		// Платёж ещё не привязан у нас (гонка с созданием) — пусть ретраит.
		apiError(w, http.StatusNotFound, "unknown_payment", "payment is not registered yet")
		return
	}
	if err != nil {
		a.internalError(w, "process yookassa webhook", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

var errUnknownPayment = errors.New("unknown provider payment")

// settlePaymentSucceeded — атомарно (в транзакции): платёж succeeded,
// подписка создана/продлена, магазин получает план, paid_until и billing_state
// ok (снятие grace/suspended). Повторный вызов по тому же платежу — no-op.
func (a *API) settlePaymentSucceeded(ctx context.Context, p billing.Payment) error {
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := a.Q.WithTx(tx)

	pay, err := q.SettlePayment(ctx, db.SettlePaymentParams{
		ProviderPaymentID: &p.ID,
		Status:            db.PaymentStatusSucceeded,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Либо повторная доставка (платёж уже не pending), либо чужой id.
		if _, gerr := a.Q.GetPaymentByProviderID(ctx, &p.ID); gerr == nil {
			return nil
		}
		return errUnknownPayment
	}
	if err != nil {
		return fmt.Errorf("settle payment: %w", err)
	}

	var paymentMethodID *string
	if p.PaymentMethod != nil && p.PaymentMethod.Saved {
		paymentMethodID = &p.PaymentMethod.ID
	}
	sub, err := q.UpsertSubscriptionPaid(ctx, db.UpsertSubscriptionPaidParams{
		ShopID:          pay.ShopID,
		Plan:            pay.Plan,
		Days:            int32(a.Cfg.Billing.PeriodDays),
		PaymentMethodID: paymentMethodID,
	})
	if err != nil {
		return fmt.Errorf("upsert subscription: %w", err)
	}
	if err := q.SetShopPaid(ctx, db.SetShopPaidParams{
		ID:        pay.ShopID,
		Plan:      pay.Plan,
		PaidUntil: sub.PeriodEnd,
	}); err != nil {
		return fmt.Errorf("set shop paid: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}

	// Витрина могла быть скрыта (suspended) — ревалидируем после коммита.
	if shop, err := a.Q.GetShopByID(ctx, pay.ShopID); err == nil {
		a.Revalidate.Shop(shop.Slug)
	}
	a.Log.Info("payment succeeded", "shop_id", pay.ShopID, "plan", pay.Plan, "paid_until", sub.PeriodEnd.Time)
	return nil
}

// settlePaymentCanceled — фиксирует отменённый платёж. План не меняется;
// если это было рекуррентное списание, магазин уйдёт в grace по paid_until
// ежедневным джобом жизненного цикла.
func (a *API) settlePaymentCanceled(ctx context.Context, p billing.Payment) error {
	_, err := a.Q.SettlePayment(ctx, db.SettlePaymentParams{
		ProviderPaymentID: &p.ID,
		Status:            db.PaymentStatusCanceled,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		if _, gerr := a.Q.GetPaymentByProviderID(ctx, &p.ID); gerr == nil {
			return nil
		}
		return errUnknownPayment
	}
	if err != nil {
		return fmt.Errorf("settle canceled payment: %w", err)
	}
	return nil
}
