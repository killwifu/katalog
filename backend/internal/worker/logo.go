package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imaging"
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
	data, err := p.Store.Download(ctx, origKey)
	if storage.IsNotFound(err) {
		return nil // повторная доставка: уже обработан и оригинал удалён
	}
	if err != nil {
		return fmt.Errorf("download logo: %w", err)
	}
	fail := func(reason string) error {
		_ = p.RDB.Set(ctx, tasks.LogoFailKey(payload.LogoID), reason, 10*time.Minute).Err()
		_ = p.Store.Delete(ctx, origKey)
		return fmt.Errorf("logo rejected: %s: %w", reason, asynq.SkipRetry)
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
	shop, err := p.Q.GetShopByID(ctx, payload.ShopID)
	if err != nil {
		return fmt.Errorf("load shop: %w", err)
	}
	if err := p.Q.SetShopLogo(ctx, db.SetShopLogoParams{ID: shop.ID, LogoID: uuid.NullUUID{UUID: payload.LogoID, Valid: true}}); err != nil {
		return fmt.Errorf("set logo: %w", err)
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
