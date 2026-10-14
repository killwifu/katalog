package integration

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"katalog/backend/internal/tasks"
)

// TestBlockTrashedPhotoKeepsAlbumCount: модератор блокирует фото, которое
// продавец уже убрал в корзину. Удаление снимает фото со счётчика альбома,
// и блокировка снимала его второй раз — у альбома с одним живым фото
// photo_count становился 0, и витрина прятала альбом целиком.
func TestBlockTrashedPhotoKeepsAlbumCount(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	uploadReadyPhoto(t, owner, shop.ID, album.ID, makeJPEG(t, 320, 240))
	drop := uploadReadyPhoto(t, owner, shop.ID, album.ID, makeJPEG(t, 330, 240))

	if status, body := owner.do("DELETE", "/api/v1/photos/"+drop, nil); status != http.StatusNoContent {
		t.Fatalf("delete photo: %d %s", status, body)
	}

	admin := newClient(t)
	adminUser := registerUser(admin)
	makeAdmin(t, adminUser.ID)
	admin.mustJSON("POST", "/api/v1/admin/photos/"+drop+"/block", map[string]string{"note": "x"}, http.StatusOK, nil)

	var albums []albumJSON
	owner.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/albums", nil, http.StatusOK, &albums)
	if len(albums) != 1 || albums[0].PhotoCount != 1 {
		t.Fatalf("photo_count после блокировки фото из корзины = %+v, want 1", albums)
	}
	// Альбом с живым фото остаётся на витрине.
	if status, body := owner.do("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil); status != http.StatusOK {
		t.Fatalf("альбом пропал с витрины: %d %s", status, body)
	}
}

// TestBlockDuringProcessingStaysBlocked: модератор блокирует фото, пока
// воркер собирает его деривативы. Воркер ставил ready без условия и тем
// самым снимал блокировку: фото возвращалось на витрину, а деривативы
// оставались в S3 по прямой ссылке.
//
// Окно гонки держится замком строки альбома: воркер берёт его перед
// записью результата, тест держит его, пока блокирует фото.
func TestBlockDuringProcessingStaysBlocked(t *testing.T) {
	ctx := context.Background()
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	data := makeJPEG(t, 640, 480)
	photoID := putPhoto(owner, shop.ID, album.ID, data)
	// confirm без постановки задачи: обработку запустим сами.
	mustExec(t, "UPDATE photos SET status = 'processing', orig_size = $2 WHERE id = $1", photoID, len(data))

	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT id FROM albums WHERE id = $1 FOR UPDATE", album.ID); err != nil {
		t.Fatalf("lock album: %v", err)
	}

	task, err := tasks.NewPhotoProcess(uuid.MustParse(photoID))
	if err != nil {
		t.Fatalf("build task: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- env.processor.HandlePhotoProcess(ctx, task) }()

	// Ждём, пока воркер упрётся в замок альбома — деривативы к этому
	// моменту уже залиты.
	deadline := time.Now().Add(60 * time.Second)
	for {
		var waiting int
		if err := env.pool.QueryRow(ctx,
			"SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()").
			Scan(&waiting); err != nil {
			t.Fatalf("pg_stat_activity: %v", err)
		}
		if waiting > 0 {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("воркер закончил, не дойдя до замка альбома: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("воркер не дошёл до записи результата")
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Блокировка модератором (как AdminBlockPhoto) и отпускаем воркер.
	if _, err := tx.Exec(ctx, "UPDATE photos SET status = 'blocked' WHERE id = $1", photoID); err != nil {
		t.Fatalf("block: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("worker: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("воркер не завершился")
	}

	var status string
	var drv int64
	mustQueryRow(t, "SELECT status::text FROM photos WHERE id = $1", &status, photoID)
	mustQueryRow(t, "SELECT drv_size FROM photos WHERE id = $1", &drv, photoID)
	if status != "blocked" || drv != 0 {
		t.Fatalf("после обработки: status=%s drv_size=%d, want blocked/0", status, drv)
	}
	for _, size := range []string{"small", "medium", "large"} {
		if _, exists, err := env.store.StatSize(ctx, "drv/"+shop.ID+"/"+photoID+"/"+size+".webp"); err != nil || exists {
			t.Errorf("дериватив %s заблокированного фото: exists=%v err=%v", size, exists, err)
		}
	}
	var count int32
	mustQueryRow(t, "SELECT photo_count FROM albums WHERE id = $1", &count, album.ID)
	if count != 0 {
		t.Errorf("photo_count = %d, want 0", count)
	}
}
