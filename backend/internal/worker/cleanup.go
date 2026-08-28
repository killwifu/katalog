package worker

import (
	"context"
	"fmt"

	"github.com/hibiken/asynq"

	"katalog/backend/internal/storage"
)

// staleUploadHours — через сколько часов незавершённая загрузка считается
// брошенной. Массовая загрузка с телефона идёт минутами, но confirm уходит
// сразу после последнего файла, поэтому сутки — заведомо безопасный запас.
const staleUploadHours = 24

// staleProcessingHours — потолок для обработки одного фото. Задача имеет
// таймаут 2 минуты и пять ретраев с backoff, так что шесть часов означают,
// что задачи больше нет: она в архиве asynq или потерялась вместе с Redis.
const staleProcessingHours = 6

// HandleUploadsCleanup убирает фото, застрявшие в статусе uploading.
//
// Фото попадает туда при выдаче presign и выходит на confirm. Если confirm
// не дошёл — сеть, перезагрузка вкладки, ошибка сервера, — строка остаётся
// навсегда и продолжает занимать квоту продавца: CountShopPhotos считает всё,
// кроме failed. На боевом стенде таких накопилось шесть штук за неделю,
// и вернуть их было нечем: задача на обработку не поставлена, а исходник
// в S3 никем не учтён.
func (p *Processor) HandleUploadsCleanup(ctx context.Context, _ *asynq.Task) error {
	if err := p.failStaleProcessing(ctx); err != nil {
		return err
	}

	stale, err := p.Q.DeleteStaleUploads(ctx, staleUploadHours)
	if err != nil {
		return fmt.Errorf("delete stale uploads: %w", err)
	}
	if len(stale) == 0 {
		return nil
	}

	// Оригинал мог и не доехать в S3 — удаление «на всякий случай»
	// и его отсутствие ошибкой не считаем. Строку в БД мы уже убрали,
	// и повторять проход из-за мусорного объекта незачем.
	var removed int
	for _, ph := range stale {
		if err := p.Store.Delete(ctx, storage.OrigKey(ph.ShopID, ph.ID)); err != nil {
			p.Log.Warn("cleanup: delete orphan original", "photo_id", ph.ID, "error", err)
			continue
		}
		removed++
	}
	p.Log.Info("stale uploads cleaned", "photos", len(stale), "originals_removed", removed)
	return nil
}

// failStaleProcessing переводит в failed фото, зависшие в processing.
// Вызывается из HandleUploadsCleanup: обе уборки чинят одну и ту же поломку —
// фото без задачи в очереди.
func (p *Processor) failStaleProcessing(ctx context.Context) error {
	ids, err := p.Q.FailStaleProcessing(ctx, staleProcessingHours)
	if err != nil {
		return fmt.Errorf("fail stale processing: %w", err)
	}
	if len(ids) > 0 {
		p.Log.Warn("stale processing photos marked failed", "photos", len(ids))
	}
	return nil
}
