package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
	"katalog/backend/internal/mail"
)

// Хендлеры тарифов и платежей. Поток оплаты:
// subscribe -> платёж в ЮKassa -> redirect на confirmation_url ->
// вебхук payment.succeeded -> подписка активна, план и paid_until на магазине.
//
// Модель (макет 18 · «Подписка»): 4 тарифа, оплата за месяц или год (−25%),
// переход выше — доплата разницы по дням до конца периода, переход ниже —
// с конца оплаченного периода, окончание оплаты — переход на Бесплатный.

// billingPlanIDs — тарифы по возрастанию: индекс — уровень тарифа.
var billingPlanIDs = []string{"free", "standard", "pro", "business"}

func planRank(plan string) int {
	for i, id := range billingPlanIDs {
		if id == plan {
			return i
		}
	}
	return -1
}

type planInfo struct {
	ID         string `json:"id"`
	MaxPhotos  int64  `json:"max_photos"`
	MaxStorage int64  `json:"max_storage"`
	PriceRub   int64  `json:"price_rub"`
	// PriceYearRub — цена за год со скидкой 25%.
	PriceYearRub int64 `json:"price_year_rub"`
}

type subscriptionInfo struct {
	Plan       string    `json:"plan"`
	Status     string    `json:"status"`
	Period     string    `json:"period"`
	PeriodEnd  time.Time `json:"period_end"`
	AutoRenew  bool      `json:"auto_renew"`
	NextPlan   *string   `json:"next_plan"`
	NextPeriod *string   `json:"next_period"`
}

type failedPaymentInfo struct {
	Plan   string `json:"plan"`
	Period string `json:"period"`
}

type billingResponse struct {
	Plan         string     `json:"plan"`
	BillingState string     `json:"billing_state"`
	PaidUntil    *time.Time `json:"paid_until"`
	// TrialEndsAt — когда кончится (или кончился) пробный «Про»; null — не брали.
	TrialEndsAt *time.Time `json:"trial_ends_at"`
	// TrialAvailable — пробный период ещё можно включить.
	TrialAvailable bool `json:"trial_available"`
	Usage          struct {
		Photos      int64 `json:"photos"`
		StorageUsed int64 `json:"storage_used"`
		TrashPhotos int64 `json:"trash_photos"`
		TrashBytes  int64 `json:"trash_bytes"`
	} `json:"usage"`
	Limits       planInfo          `json:"limits"`
	Subscription *subscriptionInfo `json:"subscription"`
	Plans        []planInfo        `json:"plans"`
	// FailedPayment — последняя оплата продавца не прошла (сутки после
	// попытки): кабинет показывает плашку «Оплата не прошла».
	FailedPayment *failedPaymentInfo `json:"failed_payment"`
}

func (a *API) toPlanInfo(id string) planInfo {
	l := a.Cfg.Billing.Limits(id)
	return planInfo{
		ID:           id,
		MaxPhotos:    l.MaxPhotos,
		MaxStorage:   l.MaxStorage,
		PriceRub:     l.PriceKopecks / 100,
		PriceYearRub: a.Cfg.Billing.Price(id, true) / 100,
	}
}

// loadSubscription — подписка магазина или nil, если её не было.
func loadSubscription(ctx context.Context, q *db.Queries, shopID uuid.UUID) (*db.Subscription, error) {
	sub, err := q.GetSubscriptionByShop(ctx, shopID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sub, nil
}

// handleGetBilling — тариф, лимиты, использование и подписка магазина.
func (a *API) handleGetBilling(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	photos, err := a.Q.CountShopPhotos(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "count shop photos", err)
		return
	}
	trash, err := a.Q.TrashUsage(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "trash usage", err)
		return
	}
	sub, err := loadSubscription(r.Context(), a.Q, shop.ID)
	if err != nil {
		a.internalError(w, "load subscription", err)
		return
	}

	resp := billingResponse{
		Plan:         string(shop.Plan),
		BillingState: string(shop.BillingState),
		Limits:       a.toPlanInfo(string(shop.Plan)),
		Plans:        make([]planInfo, 0, len(billingPlanIDs)),
		// После платного тарифа пробный не предлагается (заметка макета 18).
		TrialAvailable: shop.Plan == db.ShopPlanFree && !shop.TrialEndsAt.Valid && sub == nil,
	}
	if shop.PaidUntil.Valid {
		resp.PaidUntil = &shop.PaidUntil.Time
	}
	if shop.TrialEndsAt.Valid {
		resp.TrialEndsAt = &shop.TrialEndsAt.Time
	}
	resp.Usage.Photos = photos
	resp.Usage.StorageUsed = shop.StorageUsed
	resp.Usage.TrashPhotos = trash.Photos
	resp.Usage.TrashBytes = trash.Bytes
	for _, id := range billingPlanIDs {
		resp.Plans = append(resp.Plans, a.toPlanInfo(id))
	}
	if sub != nil {
		info := &subscriptionInfo{
			Plan:      string(sub.Plan),
			Status:    string(sub.Status),
			Period:    string(sub.Period),
			PeriodEnd: sub.PeriodEnd.Time,
			AutoRenew: sub.Status == db.SubscriptionStatusActive && sub.PaymentMethodID != nil,
		}
		if sub.NextPlan.Valid {
			np, npd := string(sub.NextPlan.ShopPlan), string(sub.NextPeriod.BillingPeriod)
			info.NextPlan, info.NextPeriod = &np, &npd
		}
		resp.Subscription = info
	}

	last, err := a.Q.LastManualPayment(r.Context(), shop.ID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		a.internalError(w, "last payment", err)
		return
	}
	if err == nil && last.Status == db.PaymentStatusCanceled && time.Since(last.CreatedAt.Time) < 24*time.Hour {
		resp.FailedPayment = &failedPaymentInfo{Plan: string(last.Plan), Period: string(last.Period)}
	}
	writeJSON(w, http.StatusOK, resp)
}

// planQuote — что произойдёт при выборе тарифа и периода.
type planQuote struct {
	// Action: pay — нужна оплата; schedule — переход ниже с конца периода
	// (без оплаты); current — это и есть текущий тариф.
	Action string `json:"action"`
	// Kind — вид платежа для pay: period / upgrade / switch.
	Kind          string    `json:"kind,omitempty"`
	Plan          string    `json:"plan"`
	Period        string    `json:"period"`
	AmountKopecks int64     `json:"-"`
	AmountRub     int64     `json:"amount_rub"`
	// Days — за сколько оставшихся дней доплата (upgrade) или зачёт (switch).
	Days int `json:"days"`
	// PeriodEnd — до какого числа будет оплачен тариф (pay) или когда
	// вступит в силу переход ниже (schedule).
	PeriodEnd time.Time `json:"period_end"`
	// FromPlan — текущий оплаченный тариф (для upgrade/switch).
	FromPlan string `json:"from_plan,omitempty"`
}

// roundRub округляет копейки до целых рублей: доплаты по дням дают дробные
// суммы, а продавцу показываем и списываем рубли.
func roundRub(k int64) int64 {
	return (k + 50) / 100 * 100
}

// paidPeriodActive — у магазина идёт оплаченный период этой подписки.
func paidPeriodActive(shop db.Shop, sub *db.Subscription, now time.Time) bool {
	return sub != nil && sub.Status != db.SubscriptionStatusExpired &&
		sub.PeriodEnd.Time.After(now) && shop.Plan == sub.Plan
}

// quotePlan считает переход на тариф plan с периодом year. Одна функция
// для предпросмотра (модалка с суммой) и для оплаты: сумма в модалке и
// в ЮKassa не может разойтись.
func (a *API) quotePlan(shop db.Shop, sub *db.Subscription, plan string, year bool, now time.Time) (planQuote, bool) {
	if planRank(plan) < 0 {
		return planQuote{}, false
	}
	bc := a.Cfg.Billing
	period := string(db.BillingPeriodMonth)
	if year {
		period = string(db.BillingPeriodYear)
	}
	q := planQuote{Plan: plan, Period: period}

	if !paidPeriodActive(shop, sub, now) {
		if plan == "free" {
			q.Action = "current"
			if shop.Plan != db.ShopPlanFree {
				// Пробный период: «Про» и так закончится сам.
				q.Action, q.PeriodEnd = "schedule", shop.PaidUntil.Time
			}
			return q, true
		}
		start := now
		if shop.TrialEndsAt.Valid && shop.TrialEndsAt.Time.After(start) {
			// Оставшиеся дни пробного периода сохраняются, оплаченный
			// период начинается после них.
			start = shop.TrialEndsAt.Time
		}
		q.Action, q.Kind = "pay", "period"
		q.AmountKopecks = bc.Price(plan, year)
		q.PeriodEnd = start.AddDate(0, 0, bc.Days(year))
		q.AmountRub = q.AmountKopecks / 100
		return q, true
	}

	cur := string(sub.Plan)
	curYear := sub.Period == db.BillingPeriodYear
	end := sub.PeriodEnd.Time
	days := int(math.Ceil(end.Sub(now).Hours() / 24))
	q.FromPlan = cur
	switch {
	case planRank(plan) < planRank(cur) || (plan == cur && curYear && !year):
		q.Action, q.PeriodEnd = "schedule", end
	case plan == cur && year == curYear:
		q.Action, q.PeriodEnd = "current", end
	case !curYear && year:
		// На год: годовой период начинается сразу, оставшиеся дни месяца
		// засчитываются: 8 010 − 890 ÷ 30 × 9 = 7 743 ₽.
		credit := bc.Price(cur, false) * int64(days) / int64(bc.Days(false))
		q.Action, q.Kind, q.Days = "pay", "switch", days
		q.AmountKopecks = roundRub(bc.Price(plan, true) - credit)
		q.PeriodEnd = now.AddDate(0, 0, config.YearDays)
	default:
		// Выше в том же периоде: разница до конца оплаченного периода по
		// дням, дата списания не меняется: (1 690 − 890) ÷ 30 × 9 = 240 ₽.
		q.Period = string(sub.Period)
		diff := bc.Price(plan, curYear) - bc.Price(cur, curYear)
		q.Action, q.Kind, q.Days = "pay", "upgrade", days
		q.AmountKopecks = roundRub(diff * int64(days) / int64(bc.Days(curYear)))
		q.PeriodEnd = end
	}
	if q.Action == "pay" && q.AmountKopecks < 100 {
		q.AmountKopecks = 100 // ЮKassa не принимает нулевой платёж
	}
	q.AmountRub = q.AmountKopecks / 100
	return q, true
}

type subscribeRequest struct {
	Plan   string `json:"plan"`
	Period string `json:"period"`
}

// parsePlanChoice — тариф и период из запроса; пустой период — месяц.
func parsePlanChoice(w http.ResponseWriter, plan, period string) (bool, bool) {
	if planRank(plan) < 0 {
		apiError(w, http.StatusBadRequest, "invalid_plan", "plan must be one of: free, standard, pro, business")
		return false, false
	}
	switch period {
	case "", "month":
		return false, true
	case "year":
		return true, true
	}
	apiError(w, http.StatusBadRequest, "invalid_period", "period must be month or year")
	return false, false
}

// handleQuoteBilling — предпросмотр перехода: сумма к оплате, дни, даты.
func (a *API) handleQuoteBilling(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	year, ok := parsePlanChoice(w, r.URL.Query().Get("plan"), r.URL.Query().Get("period"))
	if !ok {
		return
	}
	sub, err := loadSubscription(r.Context(), a.Q, shop.ID)
	if err != nil {
		a.internalError(w, "load subscription", err)
		return
	}
	q, _ := a.quotePlan(shop, sub, r.URL.Query().Get("plan"), year, time.Now())
	writeJSON(w, http.StatusOK, q)
}

type subscribeResponse struct {
	PaymentID       string `json:"payment_id,omitempty"`
	ConfirmationURL string `json:"confirmation_url,omitempty"`
	// Scheduled — переход ниже запланирован на конец периода, оплаты нет.
	Scheduled bool `json:"scheduled"`
}

// handleSubscribe — смена тарифа. Выше или новый период — платёж ЮKassa и
// confirmation_url для redirect (активация — только по вебхуку). Ниже —
// запланировать переход на конец оплаченного периода.
func (a *API) handleSubscribe(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req subscribeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	year, ok := parsePlanChoice(w, req.Plan, req.Period)
	if !ok {
		return
	}
	sub, err := loadSubscription(r.Context(), a.Q, shop.ID)
	if err != nil {
		a.internalError(w, "load subscription", err)
		return
	}
	q, _ := a.quotePlan(shop, sub, req.Plan, year, time.Now())

	switch q.Action {
	case "current":
		apiError(w, http.StatusConflict, "plan_is_current", "this plan is already active")
		return
	case "schedule":
		if sub != nil && paidPeriodActive(shop, sub, time.Now()) {
			if req.Plan == "free" {
				_, err = a.Q.CancelSubscription(r.Context(), shop.ID)
			} else {
				_, err = a.Q.ScheduleSubscriptionChange(r.Context(), db.ScheduleSubscriptionChangeParams{
					ShopID:     shop.ID,
					NextPlan:   db.ShopPlan(req.Plan),
					NextPeriod: db.BillingPeriod(q.Period),
				})
			}
			if err != nil {
				a.internalError(w, "schedule plan change", err)
				return
			}
		}
		writeJSON(w, http.StatusOK, subscribeResponse{Scheduled: true})
		return
	}

	if !a.Billing.Enabled() {
		apiError(w, http.StatusServiceUnavailable, "billing_unavailable", "payments are not configured")
		return
	}
	params := db.CreatePaymentParams{
		ShopID:   shop.ID,
		Plan:     db.ShopPlan(req.Plan),
		Amount:   q.AmountKopecks,
		Currency: "RUB",
		Period:   db.BillingPeriod(q.Period),
		Kind:     q.Kind,
	}
	if q.FromPlan != "" {
		params.FromPlan = db.NullShopPlan{ShopPlan: db.ShopPlan(q.FromPlan), Valid: true}
	}
	if q.Kind == "upgrade" {
		params.PeriodEnd = pgtype.Timestamptz{Time: q.PeriodEnd, Valid: true}
	}
	pay, err := a.Q.CreatePayment(r.Context(), params)
	if err != nil {
		a.internalError(w, "create payment", err)
		return
	}
	// Платёжная страница возвращает продавца с id платежа: кабинет по нему
	// показывает тост «Тариф подключён» или плашку «Оплата не прошла».
	returnURL := a.Cfg.Billing.ReturnURL
	sep := "?"
	if strings.Contains(returnURL, "?") {
		sep = "&"
	}
	returnURL += sep + "payment=" + pay.ID.String()
	yk, err := a.Billing.CreatePayment(r.Context(), pay.ID.String(), billing.CreatePaymentRequest{
		Amount:  billing.Amount{Value: billing.FormatKopecks(q.AmountKopecks), Currency: "RUB"},
		Capture: true,
		Confirmation: &billing.Confirmation{
			Type:      "redirect",
			ReturnURL: returnURL,
		},
		SavePaymentMethod: true,
		Description:       fmt.Sprintf("Тариф «%s» (%s) для %s", mail.PlanName(req.Plan), periodLabel(q.Period), shop.Slug),
		Metadata: map[string]string{
			"payment_id": pay.ID.String(),
			"shop_id":    shop.ID.String(),
			"period":     q.Period,
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

func periodLabel(period string) string {
	if period == string(db.BillingPeriodYear) {
		return "год"
	}
	return "месяц"
}

// handleStartTrial — пробный «Про» на 7 дней без карты, один раз на аккаунт.
func (a *API) handleStartTrial(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	n, err := a.Q.StartTrial(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "start trial", err)
		return
	}
	if n == 0 {
		apiError(w, http.StatusConflict, "trial_unavailable", "trial is available once per account and only on the free plan")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleResumeSubscription — включить автопродление обратно, без оплаты.
func (a *API) handleResumeSubscription(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	n, err := a.Q.ResumeSubscription(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "resume subscription", err)
		return
	}
	if n == 0 {
		apiError(w, http.StatusConflict, "resume_unavailable",
			"auto-renewal can be resumed only for an unexpired subscription with a saved payment method")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type paymentInfo struct {
	ID          string     `json:"id"`
	CreatedAt   time.Time  `json:"created_at"`
	Plan        string     `json:"plan"`
	FromPlan    *string    `json:"from_plan"`
	Kind        string     `json:"kind"`
	Period      string     `json:"period"`
	AmountRub   int64      `json:"amount_rub"`
	Status      string     `json:"status"`
	Recurring   bool       `json:"recurring"`
	PeriodStart *time.Time `json:"period_start"`
	PeriodEnd   *time.Time `json:"period_end"`
}

// handleListPayments — история платежей, новые сверху.
func (a *API) handleListPayments(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	rows, err := a.Q.ListPayments(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "list payments", err)
		return
	}
	out := make([]paymentInfo, 0, len(rows))
	for _, p := range rows {
		info := paymentInfo{
			ID:        p.ID.String(),
			CreatedAt: p.CreatedAt.Time,
			Plan:      string(p.Plan),
			Kind:      p.Kind,
			Period:    string(p.Period),
			AmountRub: p.Amount / 100,
			Status:    string(p.Status),
			Recurring: p.Recurring,
		}
		if p.FromPlan.Valid {
			fp := string(p.FromPlan.ShopPlan)
			info.FromPlan = &fp
		}
		if p.PeriodStart.Valid {
			info.PeriodStart = &p.PeriodStart.Time
		}
		if p.PeriodEnd.Valid {
			info.PeriodEnd = &p.PeriodEnd.Time
		}
		out = append(out, info)
	}
	writeJSON(w, http.StatusOK, map[string]any{"payments": out})
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
	if !decodeExternalJSON(w, r, &note) {
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
	shop, err := q.GetShopByID(ctx, pay.ShopID)
	if err != nil {
		return fmt.Errorf("load shop: %w", err)
	}
	sub, err := loadSubscription(ctx, q, pay.ShopID)
	if err != nil {
		return fmt.Errorf("load subscription: %w", err)
	}
	start, end := a.paidPeriod(pay, shop, sub, time.Now())
	sub2, err := q.UpsertSubscriptionPaid(ctx, db.UpsertSubscriptionPaidParams{
		ShopID:          pay.ShopID,
		Plan:            pay.Plan,
		Period:          pay.Period,
		PeriodStart:     pgtype.Timestamptz{Time: start, Valid: true},
		PeriodEnd:       pgtype.Timestamptz{Time: end, Valid: true},
		PaymentMethodID: paymentMethodID,
	})
	if err != nil {
		return fmt.Errorf("upsert subscription: %w", err)
	}
	if err := q.SetShopPaid(ctx, db.SetShopPaidParams{
		ID:        pay.ShopID,
		Plan:      pay.Plan,
		PaidUntil: sub2.PeriodEnd,
	}); err != nil {
		return fmt.Errorf("set shop paid: %w", err)
	}
	histStart := start
	if pay.Kind == "upgrade" {
		histStart = pay.CreatedAt.Time
	}
	if err := q.SetPaymentPeriod(ctx, db.SetPaymentPeriodParams{
		ID:          pay.ID,
		PeriodStart: pgtype.Timestamptz{Time: histStart, Valid: true},
		PeriodEnd:   sub2.PeriodEnd,
	}); err != nil {
		return fmt.Errorf("set payment period: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}

	// Письмо только после коммита: подтверждать оплату, которая
	// откатилась, хуже, чем не подтвердить её вовсе.
	if user, uerr := a.Q.GetUserByID(ctx, shop.OwnerID); uerr == nil && user.Email != nil {
		tpl := mail.PaymentSucceeded(shop.Name, mail.PlanName(string(pay.Plan)), pay.Amount,
			sub2.PeriodEnd.Time.Format("02.01.2006"))
		a.sendEmail(ctx, *user.Email, tpl.Subject, tpl.Text)
	}
	a.Log.Info("payment succeeded", "shop_id", pay.ShopID, "plan", pay.Plan,
		"kind", pay.Kind, "paid_until", sub2.PeriodEnd.Time)
	return nil
}

// paidPeriod — какой период оплачен платежом:
//   - upgrade: тот же период подписки, меняется только тариф;
//   - switch: годовой период начинается сейчас (остаток месяца засчитан в сумме);
//   - period: продолжает текущий оплаченный период (продление, оплата во
//     время пробного) или начинается сейчас.
func (a *API) paidPeriod(pay db.Payment, shop db.Shop, sub *db.Subscription, now time.Time) (time.Time, time.Time) {
	year := pay.Period == db.BillingPeriodYear
	if pay.Kind == "upgrade" && sub != nil {
		return sub.PeriodStart.Time, sub.PeriodEnd.Time
	}
	if pay.Kind == "switch" {
		return now, now.AddDate(0, 0, config.YearDays)
	}
	start := now
	if sub != nil && sub.Status != db.SubscriptionStatusExpired && sub.PeriodEnd.Time.After(start) {
		start = sub.PeriodEnd.Time
	}
	if shop.TrialEndsAt.Valid && shop.TrialEndsAt.Time.After(start) {
		start = shop.TrialEndsAt.Time
	}
	return start, start.AddDate(0, 0, a.Cfg.Billing.Days(year))
}

// settlePaymentCanceled — фиксирует отменённый платёж. План не меняется;
// если это было автосписание, повторов нет: по окончании периода аккаунт
// перейдёт на Бесплатный (джоб жизненного цикла).
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

// Ограничения Бесплатного тарифа (макет 18 · «Сравнение тарифов»):
// аналитика, водяной знак и пароли альбомов — только на платных. Проверка
// здесь, а не только в кабинете: иначе ограничение обходится одним запросом.

// requirePaidPlan отвечает 403 с кодом ошибки, если магазин на Бесплатном.
func requirePaidPlan(w http.ResponseWriter, shop db.Shop, code, message string) bool {
	if shop.Plan == db.ShopPlanFree {
		apiError(w, http.StatusForbidden, code, message)
		return false
	}
	return true
}

// watermarkEnabled — включён ли знак: raw — {"enabled": …} знака альбома
// или настройки магазина, если nested (знак лежит в settings.watermark).
func watermarkEnabled(raw []byte, nested bool) bool {
	if len(raw) == 0 {
		return false
	}
	var wm struct {
		Enabled bool `json:"enabled"`
	}
	if nested {
		var s struct {
			Watermark *struct {
				Enabled bool `json:"enabled"`
			} `json:"watermark"`
		}
		if json.Unmarshal(raw, &s) != nil || s.Watermark == nil {
			return false
		}
		return s.Watermark.Enabled
	}
	return json.Unmarshal(raw, &wm) == nil && wm.Enabled
}

// watermarkTurnOnForbidden — на Бесплатном знак нельзя включить. Уже
// включённый на платном знак продолжает работать (витрина не меняется),
// его можно выключить — но не включить снова.
func watermarkTurnOnForbidden(w http.ResponseWriter, shop db.Shop, before, after []byte, nested bool) bool {
	if shop.Plan == db.ShopPlanFree && watermarkEnabled(after, nested) && !watermarkEnabled(before, nested) {
		apiError(w, http.StatusForbidden, "watermark_plan_required",
			"watermark is not available on the free plan")
		return true
	}
	return false
}
