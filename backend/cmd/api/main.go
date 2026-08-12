// Command api — HTTP API сервиса Katalog.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"katalog/backend/internal/api"
	"katalog/backend/internal/auth"
	"katalog/backend/internal/billing"
	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
	"katalog/backend/internal/revalidate"
	"katalog/backend/internal/storage"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	if err := run(logger); err != nil {
		logger.Error("api exited with error", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return err
	}

	rdb := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr})
	defer func() { _ = rdb.Close() }()

	store, err := storage.New(cfg.S3Endpoint, cfg.S3PublicEndpoint, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket, cfg.S3Region)
	if err != nil {
		return err
	}

	tasksClient := asynq.NewClient(asynq.RedisClientOpt{Addr: cfg.RedisAddr})
	defer tasksClient.Close()

	app := &api.API{
		Q:             db.New(pool),
		Pool:          pool,
		Sessions:      auth.NewSessions(rdb, cfg.SessionTTL),
		Tokens:        auth.NewTokens(rdb),
		RDB:           rdb,
		Store:         store,
		Tasks:         tasksClient,
		Revalidate:    revalidate.New(cfg.StorefrontURL, cfg.RevalidateSecret, logger),
		Billing:       billing.New(cfg.Billing.YooKassaAPIURL, cfg.Billing.YooKassaShopID, cfg.Billing.YooKassaSecretKey),
		PublicLatency: api.NewHistogram(),
		Cfg:           cfg,
		Log:           logger,
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           app.Router(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("api listening", "addr", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
