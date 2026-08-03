package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgtype"

	"katalog/backend/internal/db"
	"katalog/backend/internal/mail"
	"katalog/backend/internal/tasks"
)

// HandleStatsDigest — ежемесячный email-дайджест продавцам: цифры прошлого
// месяца и сравнение с позапрошлым. Письма шлются напрямую (не через очередь):
// ошибка отправки одному магазину логируется и не валит джоб, поэтому
// ретраи задачи не дублируют уже отправленные письма.
func (p *Processor) HandleStatsDigest(ctx context.Context, t *asynq.Task) error {
	var payload tasks.StatsDigestPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %v: %w", err, asynq.SkipRetry)
	}
	month := payload.Month
	if month == "" {
		month = time.Now().UTC().AddDate(0, -1, 0).Format("2006-01")
	}
	monthStart, err := time.ParseInLocation("2006-01", month, time.UTC)
	if err != nil {
		return fmt.Errorf("parse month %q: %v: %w", month, err, asynq.SkipRetry)
	}
	monthEnd := monthStart.AddDate(0, 1, 0)
	prevStart := monthStart.AddDate(0, -1, 0)

	current, err := p.shopsStatsRange(ctx, monthStart, monthEnd)
	if err != nil {
		return fmt.Errorf("current month stats: %w", err)
	}
	previous, err := p.shopsStatsRange(ctx, prevStart, monthStart)
	if err != nil {
		return fmt.Errorf("previous month stats: %w", err)
	}
	prevByShop := make(map[string]db.ListShopsStatsRangeRow, len(previous))
	for _, row := range previous {
		prevByShop[row.ShopID.String()] = row
	}

	var sent int
	for _, cur := range current {
		prev := prevByShop[cur.ShopID.String()]
		// Мёртвые магазины не спамим: оба месяца по нулям — письма нет.
		if cur.Views == 0 && cur.LeadClicks == 0 && prev.Views == 0 && prev.LeadClicks == 0 {
			continue
		}
		msg := mail.Message{
			To:      *cur.Email,
			Subject: fmt.Sprintf("Katalog: итоги %s для «%s»", monthStart.Format("01.2006"), cur.Name),
			Text:    digestText(p.Cfg.SiteURL, cur, prev, monthStart),
		}
		if err := p.Mail.Send(ctx, msg); err != nil {
			p.Log.Error("digest: send failed", "shop_id", cur.ShopID, "error", err)
			continue
		}
		sent++
	}
	p.Log.Info("monthly digest done", "month", month, "shops", len(current), "sent", sent)
	return nil
}

// digestText — текст дайджеста: цифры месяца и сравнение с прошлым.
func digestText(siteURL string, cur, prev db.ListShopsStatsRangeRow, monthStart time.Time) string {
	return fmt.Sprintf(
		"Здравствуйте!\n\n"+
			"Итоги вашего магазина «%s» за %s:\n\n"+
			"  Просмотры витрины: %d (%s)\n"+
			"  Уникальные посетители: %d (%s)\n"+
			"  Клики «написать»: %d (%s)\n\n"+
			"Подробная статистика: %s/app/stats\n\n"+
			"Команда Katalog",
		cur.Name, monthStart.Format("01.2006"),
		cur.Views, compareDelta(cur.Views, prev.Views),
		cur.UniqueVisitors, compareDelta(cur.UniqueVisitors, prev.UniqueVisitors),
		cur.LeadClicks, compareDelta(cur.LeadClicks, prev.LeadClicks),
		siteURL,
	)
}

// compareDelta — человекочитаемое сравнение с прошлым месяцем.
func compareDelta(cur, prev int64) string {
	switch {
	case prev == 0 && cur == 0:
		return "без изменений"
	case prev == 0:
		return "в прошлом месяце 0"
	case cur == prev:
		return "как в прошлом месяце"
	default:
		pct := float64(cur-prev) / float64(prev) * 100
		if pct > 0 {
			return fmt.Sprintf("+%.0f%% к прошлому месяцу", pct)
		}
		return fmt.Sprintf("%.0f%% к прошлому месяцу", pct)
	}
}

func (p *Processor) shopsStatsRange(ctx context.Context, from, to time.Time) ([]db.ListShopsStatsRangeRow, error) {
	return p.Q.ListShopsStatsRange(ctx, db.ListShopsStatsRangeParams{
		Date:   pgtype.Date{Time: from, Valid: true},
		Date_2: pgtype.Date{Time: to, Valid: true},
	})
}

// HandleTrafficAlert — письмо админу об аномальном трафике магазина:
// дневные просмотры (CDN-трафик ~ просмотры) превысили средненедельные
// в TrafficAlertMultiplier раз и порог TrafficAlertMinViews.
// Запускается после ночной агрегации daily_stats.
func (p *Processor) HandleTrafficAlert(ctx context.Context, t *asynq.Task) error {
	if p.Cfg.Mail.AdminEmail == "" {
		return nil
	}
	var payload tasks.TrafficAlertPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %v: %w", err, asynq.SkipRetry)
	}
	date := payload.Date
	if date == "" {
		date = time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	}
	day, err := time.ParseInLocation("2006-01-02", date, time.UTC)
	if err != nil {
		return fmt.Errorf("parse date %q: %v: %w", date, err, asynq.SkipRetry)
	}

	anomalies, err := p.Q.ListTrafficAnomalies(ctx, db.ListTrafficAnomaliesParams{
		Day:        pgtype.Date{Time: day, Valid: true},
		MinViews:   p.Cfg.TrafficAlertMinViews,
		Multiplier: p.Cfg.TrafficAlertMultiplier,
	})
	if err != nil {
		return fmt.Errorf("list traffic anomalies: %w", err)
	}
	if len(anomalies) == 0 {
		return nil
	}

	text := fmt.Sprintf("Аномальный трафик витрин за %s (порог: ×%.1f от средненедельного, минимум %d просмотров/день):\n\n",
		date, p.Cfg.TrafficAlertMultiplier, p.Cfg.TrafficAlertMinViews)
	for _, a := range anomalies {
		text += fmt.Sprintf("  «%s» %s/%s — %d просмотров за день, в среднем %d/день за неделю\n",
			a.Name, p.Cfg.SiteURL, a.Slug, a.DayViews, a.WeekAvg)
	}
	text += "\nПроверьте магазины: возможен хотлинкинг, скрейпинг или накрутка."

	if err := p.Mail.Send(ctx, mail.Message{
		To:      p.Cfg.Mail.AdminEmail,
		Subject: fmt.Sprintf("Katalog: аномальный CDN-трафик (%d магазинов)", len(anomalies)),
		Text:    text,
	}); err != nil {
		return fmt.Errorf("send traffic alert: %w", err)
	}
	p.Log.Info("traffic alert sent", "date", date, "shops", len(anomalies))
	return nil
}
