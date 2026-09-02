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
	"github.com/redis/go-redis/v9"

	"katalog/backend/internal/billing"
	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
	"katalog/backend/internal/mail"
	"katalog/backend/internal/revalidate"
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

	store, err := storage.New(cfg.S3Endpoint, cfg.S3PublicEndpoint, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket, cfg.S3Region)
	if err != nil {
		return err
	}

	rdb := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr})
	defer func() { _ = rdb.Close() }()

	redisOpt := asynq.RedisClientOpt{Addr: cfg.RedisAddr}
	processor := &worker.Processor{
		Q:          db.New(pool),
		Pool:       pool,
		Store:      store,
		RDB:        rdb,
		Revalidate: revalidate.New(cfg.StorefrontURL, cfg.RevalidateSecret, logger),
		Billing:    billing.New(cfg.Billing.YooKassaAPIURL, cfg.Billing.YooKassaShopID, cfg.Billing.YooKassaSecretKey),
		Cfg:        cfg,
		Mail:       mail.New(cfg.Mail, logger),
		Log:        logger,
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
	mux.HandleFunc(tasks.TypeStatsAggregate, processor.HandleStatsAggregate)
	mux.HandleFunc(tasks.TypeBillingLifecycle, processor.HandleBillingLifecycle)
	mux.HandleFunc(tasks.TypeBillingRenew, processor.HandleBillingRenew)
	mux.HandleFunc(tasks.TypeBillingReconcile, processor.HandleBillingReconcile)
	mux.HandleFunc(tasks.TypeEmailSend, processor.HandleEmailSend)
	mux.HandleFunc(tasks.TypeStatsDigest, processor.HandleStatsDigest)
	mux.HandleFunc(tasks.TypeTrafficAlert, processor.HandleTrafficAlert)
	mux.HandleFunc(tasks.TypeUploadsCleanup, processor.HandleUploadsCleanup)
	mux.HandleFunc(tasks.TypeRetentionPurge, processor.HandleRetentionPurge)
	mux.HandleFunc(tasks.TypeStoragePurge, processor.HandleStoragePurge)

	// Ночная агрегация просмотров/лидов в daily_stats (00:30 UTC за вчера).
	scheduler := asynq.NewScheduler(redisOpt, &asynq.SchedulerOpts{Logger: asynqLogger{logger}})
	statsTask, err := tasks.NewStatsAggregate("")
	if err != nil {
		return err
	}
	if _, err := scheduler.Register("30 0 * * *", statsTask); err != nil {
		return fmt.Errorf("register stats cron: %w", err)
	}
	// Биллинг: переходы состояний (00:45 UTC), затем рекуррентные списания
	// по истекающим подпискам (01:00 UTC).
	if _, err := scheduler.Register("45 0 * * *", tasks.NewBillingLifecycle()); err != nil {
		return fmt.Errorf("register billing lifecycle cron: %w", err)
	}
	if _, err := scheduler.Register("0 1 * * *", tasks.NewBillingRenew()); err != nil {
		return fmt.Errorf("register billing renew cron: %w", err)
	}
	// Сверка зависших платежей — каждый час: недоставленное уведомление
	// не должно ждать до утра, деньги уже списаны.
	if _, err := scheduler.Register("20 * * * *", tasks.NewBillingReconcile()); err != nil {
		return fmt.Errorf("register billing reconcile cron: %w", err)
	}
	// Уборка аналитики по сроку хранения (03:10 UTC) — после ночной
	// агрегации, чтобы вчерашние события успели попасть в daily_stats.
	if _, err := scheduler.Register("10 3 * * *", tasks.NewRetentionPurge()); err != nil {
		return fmt.Errorf("register retention cron: %w", err)
	}
	// Уборка зависших загрузок (02:30 UTC): освобождает квоту продавца.
	if _, err := scheduler.Register("30 2 * * *", tasks.NewUploadsCleanup()); err != nil {
		return fmt.Errorf("register uploads cleanup cron: %w", err)
	}
	// Алерт на аномальный трафик — после ночной агрегации daily_stats.
	alertTask, err := tasks.NewTrafficAlert("")
	if err != nil {
		return err
	}
	if _, err := scheduler.Register("15 1 * * *", alertTask); err != nil {
		return fmt.Errorf("register traffic alert cron: %w", err)
	}
	// Ежемесячный дайджест продавцам — 1-го числа за прошлый месяц.
	digestTask, err := tasks.NewStatsDigest("")
	if err != nil {
		return err
	}
	if _, err := scheduler.Register("0 6 1 * *", digestTask); err != nil {
		return fmt.Errorf("register digest cron: %w", err)
	}
	if err := scheduler.Start(); err != nil {
		return fmt.Errorf("start scheduler: %w", err)
	}
	defer scheduler.Shutdown()

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
