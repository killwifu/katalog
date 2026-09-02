package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/hibiken/asynq"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/db"
)

const (
	// stuckPaymentMinutes — с какого возраста платёж считается зависшим.
	// Пятнадцати минут хватает и на оплату картой, и на доставку
	// уведомления; всё, что дольше, стоит перепроверить.
	stuckPaymentMinutes = 15
	// orphanPaymentHours — платёж без provider_payment_id: строку завели,
	// а до ЮKassa запрос не дошёл (или ответ потерялся). Списывать по нему
	// нечего, но он блокирует продление, поэтому закрываем.
	orphanPaymentHours = 2
)

// HandleBillingReconcile — сверка зависших платежей с ЮKassa.
//
// Расчёт платежа запускает вебхук. Если уведомление не дошло — а ретраи
// ЮKassa не вечны, — платёж остаётся в pending навсегда: деньги списаны,
// подписка не продлена, и следующее списание не начнётся, потому что
// незакрытый платёж его блокирует. Магазин тихо уезжает в grace, а потом
// скрывается, хотя карта продавца рабочая.
//
// Задача спрашивает у ЮKassa настоящий статус и, если он финальный,
// переотправляет на наш же вебхук то уведомление, которое не дошло.
// Так расчёт остаётся ровно в одном месте: дублировать в воркере логику,
// которая двигает деньги и подписку, нельзя — разъедется.
func (p *Processor) HandleBillingReconcile(ctx context.Context, _ *asynq.Task) error {
	if !p.Billing.Enabled() {
		return nil
	}
	stuck, err := p.Q.ListStuckPayments(ctx, stuckPaymentMinutes)
	if err != nil {
		return fmt.Errorf("list stuck payments: %w", err)
	}
	var checked, settled, closed int
	for _, pay := range stuck {
		log := p.Log.With("payment_id", pay.ID, "shop_id", pay.ShopID)

		if pay.ProviderPaymentID == nil {
			if time.Since(pay.CreatedAt.Time) < orphanPaymentHours*time.Hour {
				continue
			}
			// Платежа в ЮKassa не существует: закрываем, чтобы не блокировал
			// продление. Списаться по нему уже ничего не может.
			if err := p.Q.SetPaymentStatus(ctx, db.SetPaymentStatusParams{
				ID: pay.ID, Status: db.PaymentStatusCanceled,
			}); err != nil {
				log.Error("reconcile: cancel orphan payment failed", "error", err)
				continue
			}
			closed++
			log.Warn("reconcile: payment without provider id closed")
			continue
		}

		checked++
		remote, err := p.Billing.GetPayment(ctx, *pay.ProviderPaymentID)
		if err != nil {
			// Провайдер недоступен — не наше дело решать за него. Следующий
			// запуск попробует снова, платёж никуда не денется.
			log.Error("reconcile: get payment failed",
				"provider_payment_id", *pay.ProviderPaymentID, "error", err)
			continue
		}
		if remote.Status != billing.StatusSucceeded && remote.Status != billing.StatusCanceled {
			log.Info("reconcile: payment still in flight", "status", remote.Status)
			continue
		}
		if err := p.redeliverNotification(ctx, remote); err != nil {
			log.Error("reconcile: redeliver notification failed", "status", remote.Status, "error", err)
			continue
		}
		settled++
		log.Warn("reconcile: settled payment missed by webhook", "status", remote.Status)
	}
	p.Log.Info("billing reconcile done",
		"stuck", len(stuck), "checked", checked, "settled", settled, "closed", closed)
	return nil
}

// redeliverNotification повторяет доставку уведомления на наш вебхук.
// Тело намеренно минимальное: обработчик всё равно перепроверяет статус
// прямым запросом к ЮKassa и работает только с подтверждённым.
func (p *Processor) redeliverNotification(ctx context.Context, pay billing.Payment) error {
	body, err := json.Marshal(map[string]any{
		"type":   "notification",
		"event":  "payment." + string(pay.Status),
		"object": map[string]string{"id": pay.ID},
	})
	if err != nil {
		return fmt.Errorf("marshal notification: %w", err)
	}
	url := p.Cfg.APIInternalURL + "/api/v1/billing/webhooks/yookassa"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("post webhook: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("webhook answered %d", resp.StatusCode)
	}
	return nil
}
