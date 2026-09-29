package worker

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imagingmeta"
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
	return p.purgeExpiredTrash(ctx)
}

// purgeExpiredTrash — окончательная уборка «Удаленного».
//
// До срока фотография занимает место в хранилище: объекты в S3 никуда не
// девались, и возвращать квоту раньше времени значит обещать продавцу
// место, которого нет. Здесь оно возвращается по-настоящему.
//
// Строки уносятся одним запросом, а объекты — по одному: провал уборки
// в S3 не должен оставлять в базе записи о фотографиях, которых уже нет
// в кабинете. Осиротевший объект переживём, он попадёт в отчёт по бакету.
func (p *Processor) purgeExpiredTrash(ctx context.Context) error {
	if p.Cfg.TrashKeepDays <= 0 {
		p.Log.Warn("trash purge skipped: keep days must be positive",
			"trash_keep_days", p.Cfg.TrashKeepDays)
		return nil
	}
	rows, err := p.Q.PurgeExpiredTrash(ctx, int32(p.Cfg.TrashKeepDays))
	if err != nil {
		return fmt.Errorf("purge expired trash: %w", err)
	}
	if len(rows) == 0 {
		return nil
	}
	freed := make(map[uuid.UUID]int64, len(rows))
	for _, row := range rows {
		freed[row.ShopID] += row.Bytes
		if err := p.Store.RemovePhoto(ctx, row.ShopID, row.ID, imagingmeta.DerivativeSizes()); err != nil {
			p.Log.Error("trash purge: remove s3 objects failed", "error", err, "photo", row.ID)
		}
	}
	for shopID, bytes := range freed {
		if err := p.Q.AddShopStorageUsed(ctx, db.AddShopStorageUsedParams{
			ID:          shopID,
			StorageUsed: -bytes,
		}); err != nil {
			p.Log.Error("trash purge: release storage failed", "error", err, "shop", shopID)
		}
	}
	p.Log.Info("trash purge done", "photos", len(rows), "shops", len(freed),
		"trash_keep_days", p.Cfg.TrashKeepDays)
	return nil
}
