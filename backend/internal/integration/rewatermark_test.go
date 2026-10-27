package integration

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"

	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

// runRewatermark вызывает обработчик напрямую, минуя очередь.
func runRewatermark(t *testing.T, albumID string) error {
	t.Helper()
	task, err := tasks.NewAlbumRewatermark(uuid.MustParse(albumID))
	if err != nil {
		t.Fatalf("build task: %v", err)
	}
	return env.processor.HandleAlbumRewatermark(context.Background(), task)
}

// drvBytes — фактический размер деривативов фото в S3.
func drvBytes(t *testing.T, shopID, photoID string) int64 {
	t.Helper()
	var sum int64
	for _, px := range imagingmeta.DerivativeSizes() {
		size, ok, err := env.store.StatSize(context.Background(),
			storage.DerivativeKey(uuid.MustParse(shopID), uuid.MustParse(photoID), px))
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if ok {
			sum += size
		}
	}
	return sum
}

// Две перерисовки одного альбома одновременно: обе доходят до конца, учёт
// места сходится с фактом, версия картинок поднята дважды. Саму гонку без
// advisory lock тест стабильно не ловит (окно узкое) — проверено мутацией.
func TestRewatermarkConcurrentAccounting(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	makePaid(t, shop.ID)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, map[string]any{"settings": map[string]any{
		"watermark": map[string]any{"enabled": true, "text": "QA WATERMARK LONG TEXT", "opacity": 1, "position": "tile"},
	}}, 200, nil)
	album := createAlbum(c, shop.ID)
	ids := []string{
		uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 1200, 900)),
		uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 900, 1200)),
	}
	// Знак выключаем в обход API, чтобы очередь не запустила свою задачу.
	mustExec(t, `UPDATE albums SET watermark = '{"enabled":false,"position":"br"}' WHERE id = $1`, album.ID)

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = runRewatermark(t, album.ID) }()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("rewatermark: %v", err)
		}
	}

	for _, id := range ids {
		var drv int64
		if err := env.pool.QueryRow(context.Background(), "SELECT drv_size FROM photos WHERE id = $1", id).Scan(&drv); err != nil {
			t.Fatal(err)
		}
		if real := drvBytes(t, shop.ID, id); drv != real {
			t.Errorf("photo %s: drv_size %d, в S3 %d", id, drv, real)
		}
	}
	var used, sum int64
	var rev int32
	if err := env.pool.QueryRow(context.Background(),
		`SELECT s.storage_used, s.media_rev, (SELECT coalesce(sum(orig_size + drv_size), 0) FROM photos WHERE shop_id = s.id)
		 FROM shops s WHERE s.id = $1`, shop.ID).Scan(&used, &rev, &sum); err != nil {
		t.Fatal(err)
	}
	if used != sum {
		t.Errorf("storage_used %d, сумма по фото %d", used, sum)
	}
	if rev != 2 {
		t.Errorf("media_rev %d, want 2", rev)
	}
}

// Заблокированному фото перерисовка деривативы не возвращает; фото без
// оригинала не роняет весь альбом.
func TestRewatermarkSkipsBlockedAndMissingOriginal(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	blocked := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 800, 600))
	noOrig := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 800, 600))
	ctx := context.Background()
	shopID, blockedID := uuid.MustParse(shop.ID), uuid.MustParse(blocked)

	mustExec(t, "UPDATE photos SET status = 'blocked', drv_size = 0 WHERE id = $1", blocked)
	if err := env.store.RemoveDerivatives(ctx, shopID, blockedID, imagingmeta.DerivativeSizes()); err != nil {
		t.Fatal(err)
	}
	if err := env.store.Delete(ctx, storage.OrigKey(shopID, uuid.MustParse(noOrig))); err != nil {
		t.Fatal(err)
	}

	if err := runRewatermark(t, album.ID); err != nil {
		t.Fatalf("rewatermark: %v", err)
	}
	if n := drvBytes(t, shop.ID, blocked); n != 0 {
		t.Fatalf("у заблокированного фото снова есть деривативы: %d байт", n)
	}
	var rev int32
	if err := env.pool.QueryRow(ctx, "SELECT media_rev FROM shops WHERE id = $1", shop.ID).Scan(&rev); err != nil {
		t.Fatal(err)
	}
	if rev != 1 {
		t.Fatalf("media_rev %d, want 1: задача не дошла до конца", rev)
	}
}
