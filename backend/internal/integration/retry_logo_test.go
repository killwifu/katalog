package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"katalog/backend/internal/api"
	"katalog/backend/internal/auth"
	"katalog/backend/internal/db"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

func pendingLogo(t *testing.T, c *client, shopID string) string {
	t.Helper()
	data := makeJPEG(t, 400, 300)
	var pre struct {
		LogoID string `json:"logo_id"`
		URL    string `json:"url"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shopID+"/logo/presign", map[string]any{"size": len(data)}, http.StatusOK, &pre)
	req, err := http.NewRequest("PUT", pre.URL, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatal(res.Status)
	}
	return pre.LogoID
}

func processLogo(t *testing.T, shopID, logoID string) {
	t.Helper()
	task, err := tasks.NewShopLogo(uuid.MustParse(shopID), uuid.MustParse(logoID))
	if err != nil {
		t.Fatal(err)
	}
	if err = env.processor.HandleShopLogo(context.Background(), task); err != nil {
		t.Fatal(err)
	}
}

func TestLogoUploadCancellationAndOrder(t *testing.T) {
	for _, mode := range []string{"deleted", "superseded"} {
		t.Run(mode, func(t *testing.T) {
			c := newClient(t)
			registerUser(c)
			shop := createShop(c)
			old := pendingLogo(t, c, shop.ID)
			var want string
			if mode == "deleted" {
				c.mustJSON("DELETE", "/api/v1/shops/"+shop.ID+"/logo", nil, http.StatusNoContent, nil)
			} else {
				want = pendingLogo(t, c, shop.ID)
				processLogo(t, shop.ID, want)
			}
			processLogo(t, shop.ID, old)
			got, err := env.q.GetShopByID(context.Background(), uuid.MustParse(shop.ID))
			if err != nil {
				t.Fatal(err)
			}
			if (want == "" && got.LogoID.Valid) || (want != "" && (!got.LogoID.Valid || got.LogoID.UUID.String() != want)) {
				t.Fatalf("late logo task changed logo to %v; want %q", got.LogoID, want)
			}
			_, exists, err := env.store.StatSize(context.Background(), storage.OrigKey(uuid.MustParse(shop.ID), uuid.MustParse(old)))
			if err != nil || exists {
				t.Fatalf("cancelled logo original remains: exists=%v err=%v", exists, err)
			}
		})
	}
}

func TestLogoTargetIsolation(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	photo := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 400, 300))
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/logo/confirm", map[string]string{"logo_id": photo}, http.StatusNotFound, nil)
	other := newClient(t)
	registerUser(other)
	otherShop := createShop(other)
	logo := pendingLogo(t, other, otherShop.ID)
	processLogo(t, otherShop.ID, logo)
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID+"/logo/status?logo_id="+logo, nil, http.StatusNotFound, nil)
}

func TestConfirmRecoversMissingQueueTask(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	data := makeJPEG(t, 400, 300)
	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign", map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": len(data)}, http.StatusOK, &pre)
	req, err := http.NewRequest("PUT", pre.URL, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatal(res.Status)
	}
	// Тот же API с недоступным producer: commit проходит, Enqueue — нет.
	brokenQueue := asynq.NewClient(asynq.RedisClientOpt{Addr: env.rdb.Options().Addr})
	if err := brokenQueue.Close(); err != nil {
		t.Fatal(err)
	}
	cfg := env.processor.Cfg
	brokenAPI := &api.API{Q: env.q, Pool: env.pool, Sessions: auth.NewSessions(env.rdb, cfg.SessionTTL), Tokens: auth.NewTokens(env.rdb), RDB: env.rdb, Store: env.store, Tasks: brokenQueue, Revalidate: env.processor.Revalidate, Cfg: cfg, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), PublicLatency: api.NewHistogram()}
	server := httptest.NewServer(brokenAPI.Router())
	defer server.Close()
	body, err := json.Marshal(map[string]any{"shop_id": shop.ID, "photo_ids": []string{pre.PhotoID}})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest("POST", server.URL+"/api/v1/photos/confirm", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Results []struct {
			Status string `json:"status"`
		} `json:"results"`
	}
	err = json.NewDecoder(response.Body).Decode(&result)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != 200 || len(result.Results) != 1 || result.Results[0].Status != "error" {
		t.Fatalf("queue failure: HTTP%d %+v %v", response.StatusCode, result, err)
	}
	before, err := env.q.GetShopByID(context.Background(), uuid.MustParse(shop.ID))
	if err != nil {
		t.Fatal(err)
	}
	if before.StorageUsed != int64(len(data)) {
		t.Fatalf("unexpected initial accounting %d", before.StorageUsed)
	}
	c.mustJSON("POST", "/api/v1/photos/confirm", map[string]any{"shop_id": shop.ID, "photo_ids": []string{pre.PhotoID}}, http.StatusOK, nil)
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		ph, err := env.q.GetPhoto(context.Background(), uuid.MustParse(pre.PhotoID))
		if err != nil {
			t.Fatal(err)
		}
		if ph.Status == db.PhotoStatusReady {
			current, err := env.q.GetShopByID(context.Background(), uuid.MustParse(shop.ID))
			if err != nil {
				t.Fatal(err)
			}
			if current.StorageUsed != ph.OrigSize+ph.DrvSize {
				t.Fatalf("retry charged storage twice: shop=%d original=%d derivatives=%d", current.StorageUsed, ph.OrigSize, ph.DrvSize)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("repeated confirm did not recover processing photo with missing queue task")
}

func TestLogoCancellationDuringProcessing(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	logo := pendingLogo(t, c, shop.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err = tx.Exec(ctx, "SELECT id FROM shops WHERE id=$1 FOR UPDATE", shop.ID); err != nil {
		t.Fatal(err)
	}
	task, err := tasks.NewShopLogo(uuid.MustParse(shop.ID), uuid.MustParse(logo))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- env.processor.HandleShopLogo(ctx, task) }()
	key := storage.DerivativeKey(uuid.MustParse(shop.ID), uuid.MustParse(logo), 500)
	for {
		_, exists, err := env.store.StatSize(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		if exists {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("worker finished before rendering: %v", err)
		case <-ctx.Done():
			t.Fatal("worker did not render logo")
		default:
			time.Sleep(20 * time.Millisecond)
		}
	}
	// Тот же UPDATE, которым API удаляет логотип, пока Apply worker ждёт блокировку строки.
	if err = env.q.WithTx(tx).SetShopLogo(ctx, db.SetShopLogoParams{ID: uuid.MustParse(shop.ID)}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	got, err := env.q.GetShopByID(ctx, uuid.MustParse(shop.ID))
	if err != nil {
		t.Fatal(err)
	}
	if got.LogoID.Valid {
		t.Fatal("in-flight task restored deleted logo")
	}
	if _, exists, err := env.store.StatSize(ctx, key); err != nil || exists {
		t.Fatalf("cancelled derivative remains: %v %v", exists, err)
	}
}

func TestStaleLogoTaskDoesNotDeletePhoto(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	photo := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 400, 300))
	processLogo(t, shop.ID, photo)
	for _, key := range []string{storage.OrigKey(uuid.MustParse(shop.ID), uuid.MustParse(photo)), storage.DerivativeKey(uuid.MustParse(shop.ID), uuid.MustParse(photo), 500)} {
		if _, exists, err := env.store.StatSize(context.Background(), key); err != nil || !exists {
			t.Fatalf("stale logo task deleted photo object: exists=%v err=%v", exists, err)
		}
	}
}
