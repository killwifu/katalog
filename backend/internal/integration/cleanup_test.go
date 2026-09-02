package integration

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
)

// TestCleanupStaleUploads: фото, застрявшее в uploading (confirm не дошёл),
// удаляется ночной уборкой и перестаёт занимать квоту продавца.
func TestCleanupStaleUploads(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	// presign без confirm — ровно то, что происходит при обрыве связи.
	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": 1024},
		http.StatusOK, &pre)

	before := countShopPhotos(t, shop.ID)
	if before != 1 {
		t.Fatalf("uploading photo not counted in quota: got %d, want 1", before)
	}

	// Свежая загрузка уборку переживает: продавец может грузить прямо сейчас.
	if err := env.processor.HandleUploadsCleanup(ctx, nil); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if got := countShopPhotos(t, shop.ID); got != 1 {
		t.Fatalf("fresh upload removed by cleanup: got %d, want 1", got)
	}

	backdate(t, pre.PhotoID, "2 days")
	if err := env.processor.HandleUploadsCleanup(ctx, nil); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if got := countShopPhotos(t, shop.ID); got != 0 {
		t.Fatalf("stale upload survived cleanup: got %d, want 0", got)
	}
}

// TestCleanupStaleProcessing: фото без задачи в очереди (Redis сброшен,
// ретраи исчерпаны) не висит вечно со спиннером, а получает статус failed.
func TestCleanupStaleProcessing(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	photoID := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 64, 64))
	waitPhotoStatus(c, shop.ID, album.ID, photoID, "ready", 30*time.Second)

	// Возвращаем в processing и состариваем — воспроизводим потерянную задачу.
	if _, err := env.pool.Exec(ctx,
		`UPDATE photos SET status = 'processing', updated_at = now() - interval '12 hours' WHERE id = $1`,
		photoID); err != nil {
		t.Fatalf("backdate processing: %v", err)
	}

	if err := env.processor.HandleUploadsCleanup(ctx, nil); err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	var status, reason string
	if err := env.pool.QueryRow(ctx,
		`SELECT status, coalesce(fail_reason, '') FROM photos WHERE id = $1`,
		photoID).Scan(&status, &reason); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != "failed" {
		t.Fatalf("stale processing photo: status %q, want failed", status)
	}
	// Причина обязана отличать нашу поломку от негодного файла: с пустой
	// причиной кабинет показывал «Ошибка файла», хотя файл в порядке —
	// потерялась задача обработки. Продавец шёл искать проблему в фотографии.
	if reason != "lost" {
		t.Fatalf("причина отказа %q, want lost", reason)
	}
}

func countShopPhotos(t *testing.T, shopID string) int64 {
	t.Helper()
	var n int64
	err := env.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM photos WHERE shop_id = $1 AND status != 'failed'`, shopID).Scan(&n)
	if err != nil {
		t.Fatalf("count photos: %v", err)
	}
	return n
}

func backdate(t *testing.T, photoID, interval string) {
	t.Helper()
	_, err := env.pool.Exec(context.Background(),
		`UPDATE photos SET created_at = now() - $2::interval WHERE id = $1`, photoID, interval)
	if err != nil {
		t.Fatalf("backdate photo: %v", err)
	}
}

// TestDeleteAlbumReleasesQuota: удаление альбома возвращает квоту магазина
// и убирает объекты из S3. Каскад по внешнему ключу сносит только строки,
// поэтому без явного учёта storage_used растёт до потолка тарифа
// и продавец больше не может грузить фото.
func TestDeleteAlbumReleasesQuota(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	photoID := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 400, 300))
	waitPhotoStatus(c, shop.ID, album.ID, photoID, "ready", 30*time.Second)

	var used int64
	if err := env.pool.QueryRow(ctx, `SELECT storage_used FROM shops WHERE id = $1`, shop.ID).Scan(&used); err != nil {
		t.Fatalf("read storage_used: %v", err)
	}
	if used == 0 {
		t.Fatal("storage_used not accounted after upload")
	}

	c.mustJSON("DELETE", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID, nil, http.StatusNoContent, nil)

	if err := env.pool.QueryRow(ctx, `SELECT storage_used FROM shops WHERE id = $1`, shop.ID).Scan(&used); err != nil {
		t.Fatalf("read storage_used: %v", err)
	}
	if used != 0 {
		t.Fatalf("quota not released after album delete: storage_used = %d, want 0", used)
	}

	// Уборка S3 идёт задачей — ждём, пока оригинал исчезнет.
	origKey := "orig/" + shop.ID + "/" + photoID
	deadline := time.Now().Add(20 * time.Second)
	for {
		_, err := env.mc.StatObject(ctx, testBucket, origKey, minio.StatObjectOptions{})
		if err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("original still in S3 after album delete")
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// TestShopLimitPerOwner: один аккаунт не может занять произвольное число
// адресов витрин. Приватные ручки rate-limit не покрывает, так что без
// потолка скрипт с одной сессией скупал бы корень домена целиком.
func TestShopLimitPerOwner(t *testing.T) {
	c := newClient(t)
	registerUser(c)

	for i := 0; i < 5; i++ {
		createShop(c)
	}
	status, raw := c.do("POST", "/api/v1/shops",
		map[string]any{"slug": uniqueSlug(), "name": "Sixth"})
	if status != http.StatusConflict {
		t.Fatalf("sixth shop: status %d, want 409; body: %s", status, raw)
	}
}
