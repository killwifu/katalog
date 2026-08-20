package worker

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/db"
	"katalog/backend/internal/mail"
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
	suspended, err := p.Q.ShopsEnterSuspended(ctx, int32(p.Cfg.Billing.GraceDays))
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

	// Письма — после смены состояний: продавец узнаёт о переходе один раз,
	// в момент, когда он уже произошёл. Сбой отправки не откатывает биллинг.
	for _, s := range graced {
		views, leads := p.shopMonthTotals(ctx, s.ID)
		p.mailOwner(ctx, s.OwnerID, mail.GraceStarted(
			s.Name, p.Cfg.SiteURL, s.Slug, views, leads, p.Cfg.Billing.GraceDays))
	}
	for _, s := range suspended {
		p.mailOwner(ctx, s.OwnerID, mail.ShopHidden(s.Name, p.Cfg.SiteURL, s.Slug, contentKeepMonths))
	}
	p.notifyStorageLimits(ctx)

	p.Log.Info("billing lifecycle done", "graced", len(graced), "suspended", len(suspended))
	return nil
}

// contentKeepMonths — сколько храним фото после скрытия витрины. Значение
// обещано покупателю в письме, поэтому живёт рядом с ним, а не в env:
// менять его молча нельзя.
const contentKeepMonths = 3

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

// shopMonthTotals — просмотры и переходы за последний месяц для письма
// о неоплате. Нули не беда: шаблон опускает блок с цифрами.
func (p *Processor) shopMonthTotals(ctx context.Context, shopID uuid.UUID) (int64, int64) {
	to := time.Now().UTC()
	rows, err := p.shopsStatsRange(ctx, to.AddDate(0, -1, 0), to)
	if err != nil {
		p.Log.Error("month totals for email", "shop_id", shopID, "error", err)
		return 0, 0
	}
	for _, row := range rows {
		if row.ShopID == shopID {
			return row.Views, row.LeadClicks
		}
	}
	return 0, 0
}

// notifyStorageLimits предупреждает о заканчивающемся месте один раз за
// прогон, а не на каждую загрузку: письмо на каждый файл — верный способ
// научить продавца не читать наши письма.
func (p *Processor) notifyStorageLimits(ctx context.Context) {
	for _, plan := range []string{"basic", "pro"} {
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
		limits := p.Cfg.Billing.Limits(string(sub.Plan))
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
			// Продавцу нужно действие, а не диагноз: письмо говорит, что
			// делать, и сколько ещё работает витрина.
			if shop, serr := p.Q.GetShopByID(ctx, sub.ShopID); serr == nil {
				p.mailOwner(ctx, shop.OwnerID,
					mail.ChargeFailed(shop.Name, p.Cfg.SiteURL, p.Cfg.Billing.GraceDays))
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
