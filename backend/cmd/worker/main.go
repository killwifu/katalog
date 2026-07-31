// Command worker — обработчик фоновых задач (asynq поверх Redis).
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/davidbyttow/govips/v2/vips"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
	"katalog/backend/internal/worker"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	if err := run(logger); err != nil {
		logger.Error("worker exited with error", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg := config.Load()

	vips.LoggingSettings(nil, vips.LogLevelWarning)
	if err := vips.Startup(nil); err != nil {
		return fmt.Errorf("vips startup: %w", err)
	}
	defer vips.Shutdown()

	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	store, err := storage.New(cfg.S3Endpoint, cfg.S3PublicEndpoint, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket)
	if err != nil {
		return err
	}

	redisOpt := asynq.RedisClientOpt{Addr: cfg.RedisAddr}
	processor := &worker.Processor{
		Q:     db.New(pool),
		Store: store,
		Log:   logger,
	}

	// Health + метрика глубины очереди для docker healthcheck / мониторинга.
	inspector := asynq.NewInspector(redisOpt)
	go serveHealth(cfg.WorkerHealthAddr, inspector, logger)

	srv := asynq.NewServer(redisOpt, asynq.Config{
		Concurrency: 4,
		Logger:      asynqLogger{logger},
		Queues:      map[string]int{"default": 1},
		ErrorHandler: asynq.ErrorHandlerFunc(func(_ context.Context, task *asynq.Task, err error) {
			logger.Error("task failed", "type", task.Type(), "error", err)
		}),
	})

	mux := asynq.NewServeMux()
	mux.HandleFunc(tasks.TypePhotoProcess, processor.HandlePhotoProcess)

	logger.Info("worker starting", "redis_addr", cfg.RedisAddr)
	// Run блокируется и сам обрабатывает SIGINT/SIGTERM (graceful shutdown).
	return srv.Run(mux)
}

func serveHealth(addr string, inspector *asynq.Inspector, logger *slog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	// Prometheus text format: глубина очереди default.
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		qi, err := inspector.GetQueueInfo("default")
		if err != nil {
			http.Error(w, "queue info: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintf(w, "katalog_queue_pending{queue=\"default\"} %d\n", qi.Pending)
		_, _ = fmt.Fprintf(w, "katalog_queue_active{queue=\"default\"} %d\n", qi.Active)
		_, _ = fmt.Fprintf(w, "katalog_queue_retry{queue=\"default\"} %d\n", qi.Retry)
		_, _ = fmt.Fprintf(w, "katalog_queue_scheduled{queue=\"default\"} %d\n", qi.Scheduled)
		_, _ = fmt.Fprintf(w, "katalog_queue_archived{queue=\"default\"} %d\n", qi.Archived)
	})
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		logger.Error("worker health server exited", "error", err)
		os.Exit(1)
	}
}

// asynqLogger адаптирует slog к интерфейсу asynq.Logger.
type asynqLogger struct{ l *slog.Logger }

func (a asynqLogger) Debug(args ...any) { a.l.Debug(fmt.Sprint(args...)) }
func (a asynqLogger) Info(args ...any)  { a.l.Info(fmt.Sprint(args...)) }
func (a asynqLogger) Warn(args ...any)  { a.l.Warn(fmt.Sprint(args...)) }
func (a asynqLogger) Error(args ...any) { a.l.Error(fmt.Sprint(args...)) }
func (a asynqLogger) Fatal(args ...any) {
	a.l.Error(fmt.Sprint(args...))
	os.Exit(1)
}
