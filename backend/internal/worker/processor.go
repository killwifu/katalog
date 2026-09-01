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
	"github.com/redis/go-redis/v9"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
	"katalog/backend/internal/imaging"
	"katalog/backend/internal/mail"
	"katalog/backend/internal/revalidate"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

type Processor struct {
	Q          *db.Queries
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

	res, err := imaging.ProcessWithWatermark(data, p.watermarkFor(ctx, photo.ShopID))
	var vErr *imaging.ValidationError
	if errors.As(err, &vErr) {
		log.Warn("photo validation failed", "reason", vErr.Reason)
		if dbErr := p.Q.SetPhotoFailed(ctx, db.SetPhotoFailedParams{
			ID:         photo.ID,
			FailReason: string(vErr.Code),
		}); dbErr != nil {
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

	err = p.Q.SetPhotoReady(ctx, db.SetPhotoReadyParams{
		ID:      photo.ID,
		Width:   int32(res.Width),
		Height:  int32(res.Height),
		Phash:   pgtype.Int8{Int64: res.PHash, Valid: true},
		DrvSize: drvBytes,
	})
	if err != nil {
		return fmt.Errorf("mark photo ready: %w", err)
	}
	if err := p.Q.AddShopStorageUsed(ctx, db.AddShopStorageUsedParams{
		ID:          photo.ShopID,
		StorageUsed: drvBytes,
	}); err != nil {
		return fmt.Errorf("account derivative bytes: %w", err)
	}
	if err := p.Q.AddAlbumPhotoCount(ctx, db.AddAlbumPhotoCountParams{
		ID:         photo.AlbumID,
		PhotoCount: 1,
	}); err != nil {
		return fmt.Errorf("increment album photo count: %w", err)
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

// watermarkFor читает настройку знака из shops.settings. Ошибка здесь
// не должна ронять обработку: фото важнее подписи, поэтому при сбое
// просто обрабатываем без знака и пишем в лог.
func (p *Processor) watermarkFor(ctx context.Context, shopID uuid.UUID) imaging.Watermark {
	shop, err := p.Q.GetShopByID(ctx, shopID)
	if err != nil {
		p.Log.Warn("load shop for watermark", "shop_id", shopID, "error", err)
		return imaging.Watermark{}
	}
	var settings struct {
		Watermark struct {
			Enabled bool    `json:"enabled"`
			Text    string  `json:"text"`
			Opacity float64 `json:"opacity"`
		} `json:"watermark"`
	}
	if err := json.Unmarshal(shop.Settings, &settings); err != nil {
		p.Log.Warn("parse shop settings", "shop_id", shopID, "error", err)
		return imaging.Watermark{}
	}
	if !settings.Watermark.Enabled || settings.Watermark.Text == "" {
		return imaging.Watermark{}
	}
	opacity := settings.Watermark.Opacity
	if opacity <= 0 {
		opacity = 0.55
	}
	return imaging.Watermark{Text: settings.Watermark.Text, Opacity: opacity}
}
