package worker

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/db"
	"katalog/backend/internal/mail"
)

// HandleBillingLifecycle — окончание оплаты или пробного периода: аккаунт
// переходит на Бесплатный, витрина работает, контент не трогается
// (макет 18 · «Платный тариф закончился»). Идемпотентен: повторный запуск
// не находит магазинов для перевода.
func (p *Processor) HandleBillingLifecycle(ctx context.Context, _ *asynq.Task) error {
	ended, err := p.Q.ExpirePaidShops(ctx)
	if err != nil {
		return fmt.Errorf("expire paid shops: %w", err)
	}
	if err := p.Q.ExpireSubscriptions(ctx); err != nil {
		return fmt.Errorf("expire subscriptions: %w", err)
	}
	// Письмо — после смены тарифа. Сбой отправки не откатывает биллинг.
	for _, s := range ended {
		p.mailOwner(ctx, s.OwnerID, mail.PlanEnded(s.Name, p.Cfg.SiteURL, s.Slug))
	}
	p.notifyStorageLimits(ctx)

	p.Log.Info("billing lifecycle done", "ended", len(ended))
	return nil
}

// mailOwner отправляет письмо владельцу магазина. Письмо — не критичный
// путь: сбой логируем и идём дальше, иначе одна недоставка остановит
// обработку остальных магазинов.
func (p *Processor) mailOwner(ctx context.Context, ownerID uuid.UUID, tpl mail.Template) {
	user, err := p.Q.GetUserByID(ctx, ownerID)
	if err != nil {
		p.Log.Error("load owner for email", "owner_id", ownerID, "error", err)
		return
	}
	if user.Email == nil || *user.Email == "" {
		return
	}
	if err := p.Mail.Send(ctx, mail.Message{
		To:      *user.Email,
		Subject: tpl.Subject,
		Text:    tpl.Text,
	}); err != nil {
		p.Log.Error("send owner email", "owner_id", ownerID, "subject", tpl.Subject, "error", err)
	}
}

// notifyStorageLimits предупреждает о заканчивающемся месте один раз за
// прогон, а не на каждую загрузку: письмо на каждый файл — верный способ
// научить продавца не читать наши письма.
func (p *Processor) notifyStorageLimits(ctx context.Context) {
	for _, plan := range []string{"standard", "pro", "business"} {
		limits := p.Cfg.Billing.Limits(plan)
		if limits.MaxStorage <= 0 {
			continue
		}
		shops, err := p.Q.ShopsNearStorageLimit(ctx, limits.MaxStorage)
		if err != nil {
			p.Log.Error("shops near storage limit", "plan", plan, "error", err)
			continue
		}
		for _, s := range shops {
			if s.Email == nil || *s.Email == "" {
				continue
			}
			tpl := mail.QuotaWarning(s.Name, p.Cfg.SiteURL, s.StorageUsed, limits.MaxStorage)
			if err := p.Mail.Send(ctx, mail.Message{To: *s.Email, Subject: tpl.Subject, Text: tpl.Text}); err != nil {
				p.Log.Error("send quota warning", "shop_id", s.ID, "error", err)
			}
		}
	}
}

// HandleBillingRenew — рекуррентные списания: по каждой активной подписке
// с сохранённым способом оплаты, истекающей в ближайшие сутки, создаётся
// автосписание в ЮKassa. Продление произойдёт по вебхуку payment.succeeded.
// Одна попытка на период (повторов нет — см. ListSubscriptionsToRenew),
// idempotence-key = id нашей записи платежа. Запланированный переход ниже
// (next_plan/next_period) применяется здесь: списывается цена нового тарифа.
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
		plan, period := sub.Plan, sub.Period
		if sub.NextPlan.Valid {
			plan, period = sub.NextPlan.ShopPlan, sub.NextPeriod.BillingPeriod
		}
		price := p.Cfg.Billing.Price(string(plan), period == db.BillingPeriodYear)
		if price <= 0 {
			p.Log.Warn("skip renew: plan has no price", "shop_id", sub.ShopID, "plan", plan)
			continue
		}
		pay, err := p.Q.CreatePayment(ctx, db.CreatePaymentParams{
			ShopID:    sub.ShopID,
			Plan:      plan,
			Amount:    price,
			Currency:  "RUB",
			Recurring: true,
			Period:    period,
			Kind:      "period",
		})
		if err != nil {
			return fmt.Errorf("create payment for shop %s: %w", sub.ShopID, err)
		}
		yk, err := p.Billing.CreatePayment(ctx, pay.ID.String(), billing.CreatePaymentRequest{
			Amount:          billing.Amount{Value: billing.FormatKopecks(price), Currency: "RUB"},
			Capture:         true,
			Description:     fmt.Sprintf("Продление тарифа «%s»", mail.PlanName(string(plan))),
			PaymentMethodID: *sub.PaymentMethodID,
			Metadata:        map[string]string{"payment_id": pay.ID.String()},
		})
		if err != nil {
			// Платёж закрывается; повторов нет — тариф закончится в срок.
			if serr := p.Q.SetPaymentStatus(ctx, db.SetPaymentStatusParams{
				ID:     pay.ID,
				Status: db.PaymentStatusCanceled,
			}); serr != nil {
				p.Log.Error("renew: cancel failed payment", "payment_id", pay.ID, "error", serr)
			}
			p.Log.Error("renew: yookassa charge failed", "shop_id", sub.ShopID, "error", err)
			// Продавцу нужно действие, а не диагноз: письмо говорит, что
			// делать и до какого числа действует тариф.
			if shop, serr := p.Q.GetShopByID(ctx, sub.ShopID); serr == nil {
				p.mailOwner(ctx, shop.OwnerID,
					mail.ChargeFailed(shop.Name, p.Cfg.SiteURL, sub.PeriodEnd.Time.Format("02.01.2006")))
			}
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
