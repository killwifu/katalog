package worker

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imaging"
	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

// HandleAlbumRewatermark перерисовывает деривативы готовых фото альбома с
// текущим знаком (знак «запекается» в картинку при обработке). Ключи S3 те
// же, поэтому в конце поднимается shops.media_rev — он стоит в адресах
// картинок, и браузер с CDN не отдадут старую копию из кеша.
//
// Задачи одного альбома идут по очереди (advisory lock): две быстрые смены
// знака иначе рисовали бы параллельно, и последней могла лечь картинка со
// старым знаком, а drv_size двоился. Вторая задача ждёт первую и рисует уже
// с последней настройкой. Повтор задачи безопасен.
func (p *Processor) HandleAlbumRewatermark(ctx context.Context, t *asynq.Task) error {
	var payload tasks.AlbumRewatermarkPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %v: %w", err, asynq.SkipRetry)
	}
	conn, err := p.Pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire conn: %w", err)
	}
	defer conn.Release()
	lockKey := int64(binary.BigEndian.Uint64(payload.AlbumID[:8]))
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		return fmt.Errorf("lock album: %w", err)
	}
	defer func() { _, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", lockKey) }()

	refs, err := p.Q.ListReadyAlbumPhotoRefs(ctx, payload.AlbumID)
	if err != nil {
		return fmt.Errorf("list album photos: %w", err)
	}
	if len(refs) == 0 {
		return nil
	}
	shopID := refs[0].ShopID
	for _, ref := range refs {
		if err := p.rewatermarkPhoto(ctx, ref.ID, ref.ShopID, payload.AlbumID); err != nil {
			return err
		}
	}
	if err := p.Q.BumpShopMediaRev(ctx, shopID); err != nil {
		return fmt.Errorf("bump media rev: %w", err)
	}
	if shop, err := p.Q.GetShopByID(ctx, shopID); err != nil {
		p.Log.Warn("load shop for revalidate failed", "error", err)
	} else {
		p.Revalidate.Shop(shop.Slug)
	}
	p.Log.Info("album rewatermarked", "album_id", payload.AlbumID, "photos", len(refs))
	return nil
}

func (p *Processor) rewatermarkPhoto(ctx context.Context, photoID, shopID, albumID uuid.UUID) error {
	log := p.Log.With("photo_id", photoID)
	data, err := p.Store.Download(ctx, storage.OrigKey(shopID, photoID))
	if storage.IsNotFound(err) {
		// Оригинала нет — перерисовать нечем; остальные фото альбома важнее.
		log.Warn("rewatermark: original missing")
		return nil
	}
	if err != nil {
		return fmt.Errorf("download original %s: %w", photoID, err)
	}
	res, err := imaging.ProcessWithWatermark(data, p.watermarkFor(ctx, shopID, albumID))
	var vErr *imaging.ValidationError
	if errors.As(err, &vErr) {
		// Оригинал уже проходил проверку; не прошёл сейчас — оставляем
		// старые деривативы, а не роняем весь альбом.
		log.Warn("rewatermark: validation", "reason", vErr.Reason)
		return nil
	}
	if err != nil {
		return fmt.Errorf("process %s: %w", photoID, err)
	}
	// Пока шла отрисовка, фото могли заблокировать, удалить или вычистить
	// из корзины: блокировка уже убрала деривативы, и вернуть их — значит
	// снова раздавать заблокированное.
	if ok, err := p.stillReady(ctx, photoID); err != nil || !ok {
		return err
	}
	var size int64
	for px, blob := range res.Derivatives {
		key := storage.DerivativeKey(shopID, photoID, px)
		if err := p.Store.Upload(ctx, key, blob, "image/webp"); err != nil {
			return fmt.Errorf("upload %s: %w", key, err)
		}
		size += int64(len(blob))
	}
	// И после заливки: блокировка могла пройти между проверкой и заливкой.
	photo, err := p.Q.GetPhoto(ctx, photoID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && photo.Status != db.PhotoStatusReady) {
		log.Info("rewatermark: photo left ready during work, dropping derivatives")
		if err := p.Store.RemoveDerivatives(ctx, shopID, photoID, imagingmeta.DerivativeSizes()); err != nil {
			return fmt.Errorf("remove late derivatives: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("reload photo %s: %w", photoID, err)
	}
	// drv_size меряем заново целиком: новый размер минус старый.
	delta := size - photo.DrvSize
	if delta == 0 {
		return nil
	}
	if err := p.Q.AdjustPhotoDrvSize(ctx, db.AdjustPhotoDrvSizeParams{ID: photoID, Delta: delta}); err != nil {
		return fmt.Errorf("adjust drv_size %s: %w", photoID, err)
	}
	if err := p.Q.AddShopStorageUsed(ctx, db.AddShopStorageUsedParams{ID: shopID, StorageUsed: delta}); err != nil {
		return fmt.Errorf("adjust storage %s: %w", shopID, err)
	}
	return nil
}

func (p *Processor) stillReady(ctx context.Context, photoID uuid.UUID) (bool, error) {
	photo, err := p.Q.GetPhoto(ctx, photoID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("reload photo %s: %w", photoID, err)
	}
	return photo.Status == db.PhotoStatusReady, nil
}
