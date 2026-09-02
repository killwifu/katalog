package worker

import (
	"context"
	"fmt"

	"github.com/hibiken/asynq"
)

// HandleRetentionPurge — уборка аналитики по сроку хранения.
//
// lead_clicks хранит visitor_hash, то есть сведения о посетителях витрин.
// Держать их годами не нужно ни продукту, ни продавцу: кабинет показывает
// не больше года и берёт числа из daily_stats, куда события попадают
// агрегатом в ту же ночь. Дневные агрегаты живут дольше, но тоже не вечно.
//
// payments и moderation_log эта задача не трогает сознательно: первое —
// финансовые записи, второе — доказательство, что и почему было снято
// по жалобе. Их срок хранения определяется не удобством, и назначать его
// вместо владельца сервиса неправильно.
func (p *Processor) HandleRetentionPurge(ctx context.Context, _ *asynq.Task) error {
	// Ноль или отрицательное значение означало бы «удалить всё»: срок
	// хранения — не то место, где стоит доверять неверной настройке.
	// Лучше ничего не убрать и сказать об этом, чем снести аналитику.
	if p.Cfg.RetentionLeadClicksDays <= 0 || p.Cfg.RetentionDailyStatsDays <= 0 {
		p.Log.Warn("retention purge skipped: keep days must be positive",
			"lead_clicks_keep_days", p.Cfg.RetentionLeadClicksDays,
			"daily_stats_keep_days", p.Cfg.RetentionDailyStatsDays)
		return nil
	}
	clicks, err := p.Q.DeleteOldLeadClicks(ctx, int32(p.Cfg.RetentionLeadClicksDays))
	if err != nil {
		return fmt.Errorf("delete old lead clicks: %w", err)
	}
	stats, err := p.Q.DeleteOldDailyStats(ctx, int32(p.Cfg.RetentionDailyStatsDays))
	if err != nil {
		return fmt.Errorf("delete old daily stats: %w", err)
	}
	if clicks > 0 || stats > 0 {
		p.Log.Info("retention purge done",
			"lead_clicks", clicks, "lead_clicks_keep_days", p.Cfg.RetentionLeadClicksDays,
			"daily_stats", stats, "daily_stats_keep_days", p.Cfg.RetentionDailyStatsDays)
	}
	return nil
}
