// Package worker — обработчики asynq-задач.
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
	"katalog/backend/internal/imaging"
	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/mail"
	"katalog/backend/internal/revalidate"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

type Processor struct {
	Q *db.Queries
	// Pool — для транзакций: финал обработки пишет в три таблицы, и разъехаться
	// они не должны (см. HandlePhotoProcess).
	Pool       *pgxpool.Pool
	Store      *storage.Client
	RDB        *redis.Client
	Revalidate *revalidate.Notifier
	Billing    *billing.Client
	Cfg        config.Config
	Mail       mail.Sender
	Log        *slog.Logger
}

// HandlePhotoProcess — пайплайн обработки фото (см. инвариант в CLAUDE.md):
// скачать оригинал -> magic bytes -> лимит разрешения до декодирования ->
// EXIF-ориентация + полная зачистка метаданных -> деривативы WebP -> pHash ->
// статус ready. Ошибки контента постоянны (failed + SkipRetry), ошибки
// инфраструктуры ретраятся, после исчерпания ретраев задача уходит в архив
// asynq (дедлеттер).
func (p *Processor) HandlePhotoProcess(ctx context.Context, t *asynq.Task) error {
	var payload tasks.PhotoProcessPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %v: %w", err, asynq.SkipRetry)
	}
	log := p.Log.With("photo_id", payload.PhotoID)

	photo, err := p.Q.GetPhoto(ctx, payload.PhotoID)
	if errors.Is(err, pgx.ErrNoRows) {
		log.Warn("photo not found, skipping")
		return nil
	}
	if err != nil {
		return fmt.Errorf("load photo: %w", err)
	}
	if photo.Status != db.PhotoStatusProcessing {
		// Идемпотентность: повторная доставка уже обработанной задачи.
		log.Info("photo not in processing status, skipping", "status", photo.Status)
		return nil
	}

	data, err := p.Store.Download(ctx, storage.OrigKey(photo.ShopID, photo.ID))
	if err != nil {
		return fmt.Errorf("download original: %w", err)
	}

	wm := p.watermarkFor(ctx, photo.ShopID, photo.AlbumID)
	res, err := imaging.ProcessWithWatermark(data, wm)
	// Знак сменили, пока шла отрисовка: перерисовка альбома это фото не
	// увидит (оно ещё не ready) — рисуем заново с новым знаком.
	if now := p.watermarkFor(ctx, photo.ShopID, photo.AlbumID); err == nil && now != wm {
		res, err = imaging.ProcessWithWatermark(data, now)
	}
	var vErr *imaging.ValidationError
	if errors.As(err, &vErr) {
		log.Warn("photo validation failed", "reason", vErr.Reason)
		if dbErr := p.failAndRelease(ctx, photo, string(vErr.Code)); dbErr != nil {
			return fmt.Errorf("mark photo failed: %w", dbErr)
		}
		return fmt.Errorf("validation: %s: %w", vErr.Reason, asynq.SkipRetry)
	}
	if err != nil {
		return fmt.Errorf("process image: %w", err)
	}

	var drvBytes int64
	for size, blob := range res.Derivatives {
		key := storage.DerivativeKey(photo.ShopID, photo.ID, size)
		if err := p.Store.Upload(ctx, key, blob, "image/webp"); err != nil {
			return fmt.Errorf("upload derivative %d: %w", size, err)
		}
		drvBytes += int64(len(blob))
	}

	// Три записи одной транзакцией. Порознь сбой на второй или третьей
	// оставлял расхождение навсегда: статус ready уже проставлен, ретрай
	// задачи видит его и пропускает обработку (идемпотентность выше), так
	// что байты деривативов и счётчик альбома не досчитаются уже никогда.
	// В транзакции сбой откатывает и статус — ретрай доводит дело до конца.
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := p.Q.WithTx(tx)

	if err := q.LockAlbumForOrder(ctx, photo.AlbumID); err != nil {
		return fmt.Errorf("lock album: %w", err)
	}
	n, err := q.SetPhotoReady(ctx, db.SetPhotoReadyParams{
		ID:      photo.ID,
		Width:   int32(res.Width),
		Height:  int32(res.Height),
		Phash:   pgtype.Int8{Int64: res.PHash, Valid: true},
		DrvSize: drvBytes,
	})
	if err != nil {
		return fmt.Errorf("mark photo ready: %w", err)
	}
	if n == 0 {
		_ = tx.Rollback(ctx)
		return p.dropLateDerivatives(ctx, photo)
	}
	if err := q.AddShopStorageUsed(ctx, db.AddShopStorageUsedParams{
		ID:          photo.ShopID,
		StorageUsed: drvBytes,
	}); err != nil {
		return fmt.Errorf("account derivative bytes: %w", err)
	}
	if err := q.RecountAlbumPhotos(ctx, photo.AlbumID); err != nil {
		return fmt.Errorf("recount album photos: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit photo ready: %w", err)
	}

	// Фото стало видимым на витрине — инвалидируем ISR-кеш магазина.
	if shop, err := p.Q.GetShopByID(ctx, photo.ShopID); err != nil {
		log.Warn("load shop for revalidate failed", "error", err)
	} else {
		p.Revalidate.Shop(shop.Slug)
	}

	log.Info("photo processed", "width", res.Width, "height", res.Height, "derivative_bytes", drvBytes)
	return nil
}

// watermarkFor читает настройку знака из shops.settings и переопределение
// альбома (albums.watermark: включён ли и где). Ошибка здесь не должна
// ронять обработку: фото важнее подписи, поэтому при сбое просто
// обрабатываем без знака и пишем в лог.
func (p *Processor) watermarkFor(ctx context.Context, shopID, albumID uuid.UUID) imaging.Watermark {
	shop, err := p.Q.GetShopByID(ctx, shopID)
	if err != nil {
		p.Log.Warn("load shop for watermark", "shop_id", shopID, "error", err)
		return imaging.Watermark{}
	}
	var settings struct {
		Watermark struct {
			Enabled  bool    `json:"enabled"`
			Text     string  `json:"text"`
			Opacity  float64 `json:"opacity"`
			Position string  `json:"position"`
		} `json:"watermark"`
	}
	if err := json.Unmarshal(shop.Settings, &settings); err != nil {
		p.Log.Warn("parse shop settings", "shop_id", shopID, "error", err)
		return imaging.Watermark{}
	}
	wm := settings.Watermark
	// Альбом может включить, выключить знак или сдвинуть его (макет 11–12).
	if raw, err := p.Q.GetAlbumWatermark(ctx, albumID); err != nil {
		p.Log.Warn("load album watermark", "album_id", albumID, "error", err)
	} else if len(raw) > 0 {
		var own struct {
			Enabled  bool   `json:"enabled"`
			Position string `json:"position"`
		}
		if err := json.Unmarshal(raw, &own); err == nil {
			wm.Enabled = own.Enabled
			if own.Position != "" {
				wm.Position = own.Position
			}
		}
	}
	if !wm.Enabled {
		return imaging.Watermark{}
	}
	// Текст знака — подпись магазина; если её ещё не задавали, знаком
	// служит название витрины (так же делает кабинет при включении).
	if wm.Text == "" {
		wm.Text = shop.Name
	}
	settings.Watermark = wm
	opacity := settings.Watermark.Opacity
	if opacity <= 0 {
		opacity = 0.55
	}
	return imaging.Watermark{
		Text:     settings.Watermark.Text,
		Opacity:  opacity,
		Position: settings.Watermark.Position,
	}
}

// dropLateDerivatives: пока шла обработка, фото перестало её ждать —
// обычно его заблокировал модератор. Деривативы уже залиты, а блокировка
// удаляла их раньше, чем они появились; оставить их — значит раздавать
// заблокированное по прямой ссылке. Готовое фото (параллельная доставка
// той же задачи) не трогаем: его деривативы и есть эти файлы.
func (p *Processor) dropLateDerivatives(ctx context.Context, photo db.Photo) error {
	cur, err := p.Q.GetPhoto(ctx, photo.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		cur.Status = db.PhotoStatusFailed // строки нет — файлы ничьи
	} else if err != nil {
		return fmt.Errorf("reload photo: %w", err)
	}
	if cur.Status == db.PhotoStatusReady {
		return nil
	}
	p.Log.Info("photo left processing during work, dropping derivatives",
		"photo_id", photo.ID, "status", cur.Status)
	if err := p.Store.RemoveDerivatives(ctx, photo.ShopID, photo.ID, imagingmeta.DerivativeSizes()); err != nil {
		return fmt.Errorf("remove late derivatives: %w", err)
	}
	return nil
}

// failAndRelease помечает фото failed и возвращает в тариф байты оригинала:
// файл не прошёл проверку (не картинка, SVG, «бомба») и обработан не будет
// никогда, а до фикса продолжал занимать место продавца, пока тот сам не
// удалит фото и не очистит корзину. Статус и счётчик — одной транзакцией;
// мусорный оригинал из S3 — после, без отката при сбое (его подберёт уборка).
func (p *Processor) failAndRelease(ctx context.Context, photo db.Photo, reason string) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := p.Q.WithTx(tx)
	released, err := q.FailPhotoReleaseOrig(ctx, db.FailPhotoReleaseOrigParams{ID: photo.ID, FailReason: reason})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // уже не в processing — повторная доставка задачи
	}
	if err != nil {
		return fmt.Errorf("fail photo: %w", err)
	}
	if released > 0 {
		if err := q.AddShopStorageUsed(ctx, db.AddShopStorageUsedParams{ID: photo.ShopID, StorageUsed: -released}); err != nil {
			return fmt.Errorf("release original bytes: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	if err := p.Store.Delete(ctx, storage.OrigKey(photo.ShopID, photo.ID)); err != nil {
		p.Log.Warn("failed photo: delete original", "photo_id", photo.ID, "error", err)
	}
	return nil
}
