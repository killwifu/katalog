package worker

import (
	"context"
	"fmt"

	"github.com/hibiken/asynq"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/db"
)

// HandleBillingLifecycle — ежедневные переходы биллинговых состояний:
// оплата истекла -> grace (загрузка заблокирована, витрина работает),
// grace дольше GraceDays -> suspended (витрина скрыта). Контент не удаляется.
// Идемпотентен: повторный запуск не находит магазинов для перевода.
func (p *Processor) HandleBillingLifecycle(ctx context.Context, _ *asynq.Task) error {
	graced, err := p.Q.ShopsEnterGrace(ctx)
	if err != nil {
		return fmt.Errorf("shops enter grace: %w", err)
	}
	suspended, err := p.Q.ShopsEnterSuspended(ctx, int32(p.BillingCfg.GraceDays))
	if err != nil {
		return fmt.Errorf("shops enter suspended: %w", err)
	}
	// Статусы подписок приводятся к финальным состояниям магазинов.
	if err := p.Q.MarkSubscriptionsPastDue(ctx); err != nil {
		return fmt.Errorf("mark subscriptions past_due: %w", err)
	}
	if err := p.Q.MarkSubscriptionsExpired(ctx); err != nil {
		return fmt.Errorf("mark subscriptions expired: %w", err)
	}
	// Скрытые витрины ревалидируются (ISR перестанет отдавать страницу).
	for _, s := range suspended {
		p.Revalidate.Shop(s.Slug)
	}
	p.Log.Info("billing lifecycle done", "graced", len(graced), "suspended", len(suspended))
	return nil
}

// HandleBillingRenew — рекуррентные списания: по каждой активной подписке
// с сохранённым способом оплаты, истекающей в ближайшие сутки, создаётся
// автосписание в ЮKassa. Продление произойдёт по вебхуку payment.succeeded.
// Дубли исключены: подписка с незавершённым рекуррентным платежом
// не выбирается, idempotence-key = id нашей записи платежа.
func (p *Processor) HandleBillingRenew(ctx context.Context, _ *asynq.Task) error {
	if !p.Billing.Enabled() {
		return nil
	}
	subs, err := p.Q.ListSubscriptionsToRenew(ctx)
	if err != nil {
		return fmt.Errorf("list subscriptions to renew: %w", err)
	}
	var charged int
	for _, sub := range subs {
		limits := p.BillingCfg.Limits(string(sub.Plan))
		if limits.PriceKopecks <= 0 {
			p.Log.Warn("skip renew: plan has no price", "shop_id", sub.ShopID, "plan", sub.Plan)
			continue
		}
		pay, err := p.Q.CreatePayment(ctx, db.CreatePaymentParams{
			ShopID:    sub.ShopID,
			Plan:      sub.Plan,
			Amount:    limits.PriceKopecks,
			Currency:  "RUB",
			Recurring: true,
		})
		if err != nil {
			return fmt.Errorf("create payment for shop %s: %w", sub.ShopID, err)
		}
		yk, err := p.Billing.CreatePayment(ctx, pay.ID.String(), billing.CreatePaymentRequest{
			Amount:          billing.Amount{Value: billing.FormatKopecks(limits.PriceKopecks), Currency: "RUB"},
			Capture:         true,
			Description:     fmt.Sprintf("Katalog: продление тарифа %s", sub.Plan),
			PaymentMethodID: *sub.PaymentMethodID,
			Metadata:        map[string]string{"payment_id": pay.ID.String()},
		})
		if err != nil {
			// Платёж закрывается, следующий запуск джоба попробует снова.
			if serr := p.Q.SetPaymentStatus(ctx, db.SetPaymentStatusParams{
				ID:     pay.ID,
				Status: db.PaymentStatusCanceled,
			}); serr != nil {
				p.Log.Error("renew: cancel failed payment", "payment_id", pay.ID, "error", serr)
			}
			p.Log.Error("renew: yookassa charge failed", "shop_id", sub.ShopID, "error", err)
			continue
		}
		if err := p.Q.SetPaymentProvider(ctx, db.SetPaymentProviderParams{
			ID:                pay.ID,
			ProviderPaymentID: &yk.ID,
		}); err != nil {
			return fmt.Errorf("set provider payment id for %s: %w", pay.ID, err)
		}
		charged++
	}
	p.Log.Info("billing renew done", "due", len(subs), "charged", charged)
	return nil
}
