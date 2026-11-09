package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imaging"
	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

// logoMinSide — логотип меньше 200×200 в шапке витрины размыт (макет 17).
const logoMinSide = 200

// logoSize — какой дериватив логотипа хранится и раздаётся (small).
const logoSize = 500

// HandleShopLogo — логотип витрины тем же пайплайном, что фото: magic bytes,
// лимит разрешения до декодирования, EXIF применён и вычищен, WebP. Хранится
// один дериватив; оригинал после обработки удаляется. Неподходящий файл
// отмечается в Redis — кабинет опрашивает статус и показывает ошибку.
func (p *Processor) HandleShopLogo(ctx context.Context, t *asynq.Task) error {
	var payload tasks.ShopLogoPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %v: %w", err, asynq.SkipRetry)
	}
	origKey := storage.OrigKey(payload.ShopID, payload.LogoID)
	shop, err := p.Q.GetShopByID(ctx, payload.ShopID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("load logo shop: %w", err)
	}
	if err == nil && shop.LogoID.Valid && shop.LogoID.UUID == payload.LogoID {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) || !shop.LogoUploadID.Valid || shop.LogoUploadID.UUID != payload.LogoID {
		return p.discardShopLogo(ctx, payload)
	}

	fail := func(reason string) error {
		_ = p.RDB.Set(ctx, tasks.LogoFailKey(payload.LogoID), reason, 10*time.Minute).Err()
		_ = p.Store.Delete(ctx, origKey)
		return fmt.Errorf("logo rejected: %s: %w", reason, asynq.SkipRetry)
	}
	data, err := p.Store.Download(ctx, origKey)
	if errors.Is(err, storage.ErrOriginalTooLarge) {
		return fail(imagingmeta.FailFileTooLarge)
	}
	if storage.IsNotFound(err) {
		return nil // повторная доставка: уже обработан и оригинал удалён
	}
	if err != nil {
		return fmt.Errorf("download logo: %w", err)
	}
	res, err := imaging.Process(data)
	var vErr *imaging.ValidationError
	if errors.As(err, &vErr) {
		return fail(string(vErr.Code))
	}
	if err != nil {
		return fmt.Errorf("process logo: %w", err)
	}
	if res.Width < logoMinSide || res.Height < logoMinSide {
		return fail("too_small")
	}
	if err := p.Store.Upload(ctx, storage.DerivativeKey(payload.ShopID, payload.LogoID, logoSize), res.Derivatives[logoSize], "image/webp"); err != nil {
		return fmt.Errorf("upload logo: %w", err)
	}
	shop, err = p.Q.GetShopByID(ctx, payload.ShopID)
	if errors.Is(err, pgx.ErrNoRows) {
		return p.discardShopLogo(ctx, payload)
	}
	if err != nil {
		return fmt.Errorf("load shop: %w", err)
	}
	applied, err := p.Q.ApplyShopLogoUpload(ctx, db.ApplyShopLogoUploadParams{ID: shop.ID, LogoID: uuid.NullUUID{UUID: payload.LogoID, Valid: true}})
	if err != nil {
		return fmt.Errorf("set logo: %w", err)
	}
	if applied == 0 {
		current, err := p.Q.GetShopByID(ctx, payload.ShopID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("reload logo shop: %w", err)
		}
		if err == nil && current.LogoID.Valid && current.LogoID.UUID == payload.LogoID {
			return nil
		}
		return p.discardShopLogo(ctx, payload)
	}
	if shop.LogoID.Valid && shop.LogoID.UUID != payload.LogoID {
		if err := p.Store.RemovePhoto(ctx, shop.ID, shop.LogoID.UUID, []int{logoSize}); err != nil {
			p.Log.Warn("remove previous logo", "shop_id", shop.ID, "error", err)
		}
	}
	if err := p.Store.Delete(ctx, origKey); err != nil {
		p.Log.Warn("delete logo original", "shop_id", shop.ID, "error", err)
	}
	p.Revalidate.Shop(shop.Slug)
	return nil
}

// Старые задачи могли принять photo_id за logo_id: оригинал фото удалять нельзя.
func (p *Processor) discardShopLogo(ctx context.Context, payload tasks.ShopLogoPayload) error {
	_, err := p.Q.GetPhotoForShop(ctx, db.GetPhotoForShopParams{ID: payload.LogoID, ShopID: payload.ShopID})
	if err == nil {
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("check stale logo target: %w", err)
	}
	return p.Store.RemovePhoto(ctx, payload.ShopID, payload.LogoID, []int{logoSize})
}
