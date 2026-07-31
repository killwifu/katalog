// Command worker — обработчик фоновых задач (asynq поверх Redis).
package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/hibiken/asynq"

	"katalog/backend/internal/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg := config.Load()

	// Health-эндпоинт для docker healthcheck.
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		})
		healthSrv := &http.Server{
			Addr:              cfg.WorkerHealthAddr,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
		}
		if err := healthSrv.ListenAndServe(); err != nil {
			logger.Error("worker health server exited", "error", err)
			os.Exit(1)
		}
	}()

	srv := asynq.NewServer(
		asynq.RedisClientOpt{Addr: cfg.RedisAddr},
		asynq.Config{
			Concurrency: 4,
			Logger:      asynqLogger{logger},
		},
	)

	mux := asynq.NewServeMux()
	// Обработчики задач (обработка фото и т.д.) появятся на следующих этапах.

	logger.Info("worker starting", "redis_addr", cfg.RedisAddr)
	// Run блокируется и сам обрабатывает SIGINT/SIGTERM (graceful shutdown).
	if err := srv.Run(mux); err != nil {
		logger.Error("worker exited with error", "error", err)
		os.Exit(1)
	}
}

// asynqLogger адаптирует slog к интерфейсу asynq.Logger.
type asynqLogger struct{ l *slog.Logger }

func (a asynqLogger) Debug(args ...any) { a.l.Debug(sprint(args...)) }
func (a asynqLogger) Info(args ...any)  { a.l.Info(sprint(args...)) }
func (a asynqLogger) Warn(args ...any)  { a.l.Warn(sprint(args...)) }
func (a asynqLogger) Error(args ...any) { a.l.Error(sprint(args...)) }
func (a asynqLogger) Fatal(args ...any) {
	a.l.Error(sprint(args...))
	os.Exit(1)
}

func sprint(args ...any) string {
	return fmt.Sprint(args...)
}
