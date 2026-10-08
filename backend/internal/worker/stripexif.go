package worker

import (
	"context"
	"fmt"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imaging"
	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/storage"
)

// StripDerivativeMetadata — разовая зачистка: libvips 8.16 писала в WebP-деривативы
// EXIF-чанк (с GPS продавца, если он был в оригинале). Проходит все готовые фото,
// вырезает EXIF/XMP из каждого дериватива и перезаписывает объект по тому же
// ключу; на разницу в байтах поправляет drv_size и storage_used. Повторный
// запуск безопасен: чистые файлы не трогаются.
//
// В проде ключи деривативов кешируются CDN как immutable — после запуска нужен
// сброс кеша у провайдера.
func (p *Processor) StripDerivativeMetadata(ctx context.Context) error {
	refs, err := p.Q.ListReadyPhotoRefs(ctx)
	if err != nil {
		return fmt.Errorf("list photos: %w", err)
	}
	var fixed, files int
	for _, ref := range refs {
		var delta int64
		for _, size := range imagingmeta.DerivativeSizes() {
			key := storage.DerivativeKey(ref.ShopID, ref.ID, size)
			data, err := p.Store.Download(ctx, key)
			if err != nil {
				p.Log.Warn("strip-exif: download", "key", key, "error", err)
				continue
			}
			clean := imaging.StripWebPMetadata(data)
			if len(clean) == len(data) {
				continue
			}
			if err := p.Store.Upload(ctx, key, clean, "image/webp"); err != nil {
				return fmt.Errorf("upload %s: %w", key, err)
			}
			delta += int64(len(clean) - len(data))
			files++
		}
		if delta == 0 {
			continue
		}
		fixed++
		if err := p.Q.AdjustPhotoDrvSize(ctx, db.AdjustPhotoDrvSizeParams{ID: ref.ID, Delta: delta}); err != nil {
			return fmt.Errorf("adjust drv_size %s: %w", ref.ID, err)
		}
		if err := p.Q.AddShopStorageUsed(ctx, db.AddShopStorageUsedParams{ID: ref.ShopID, StorageUsed: delta}); err != nil {
			return fmt.Errorf("adjust storage %s: %w", ref.ShopID, err)
		}
	}
	p.Log.Info("strip-exif done", "photos", len(refs), "photos_fixed", fixed, "files_rewritten", files)
	return nil
}
