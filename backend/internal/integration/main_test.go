// Package integration — интеграционные тесты полного стека:
// реальные Postgres/Redis/MinIO через testcontainers, API через httptest,
// asynq-воркер (govips) в том же процессе.
package integration

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/davidbyttow/govips/v2/vips"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/pressly/goose/v3"
	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	tcminio "github.com/testcontainers/testcontainers-go/modules/minio"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"

	"katalog/backend/internal/api"
	"katalog/backend/internal/auth"
	"katalog/backend/internal/billing"
	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
	"katalog/backend/internal/revalidate"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
	"katalog/backend/internal/worker"
)

const (
	testBucket           = "katalog"
	testRevalidateSecret = "test-revalidate-secret"
)

var env struct {
	pool      *pgxpool.Pool
	q         *db.Queries
	store     *storage.Client
	srv       *httptest.Server
	mc        *minio.Client
	rdb       *redis.Client
	processor *worker.Processor
	// yk — фейковый сервер API ЮKassa (создание платежей, статусы).
	yk *fakeYooKassa
	// mail — перехватчик писем (вместо SMTP), наполняется воркером.
	mail *captureMail
	// revalidated — слаги магазинов, полученные фейковой витриной
	// через вебхук ревалидации.
	revalidated chan string
}

func TestMain(m *testing.M) {
	os.Exit(run(m))
}

func run(m *testing.M) int {
	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	vips.LoggingSettings(nil, vips.LogLevelError)
	if err := vips.Startup(nil); err != nil {
		log.Printf("vips startup: %v", err)
		return 1
	}
	defer vips.Shutdown()

	pgC, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("katalog"),
		tcpostgres.WithUsername("katalog"),
		tcpostgres.WithPassword("katalog"),
		tcpostgres.BasicWaitStrategies(),
	)
	if err != nil {
		log.Printf("start postgres container: %v", err)
		return 1
	}
	defer terminate(ctx, pgC)

	redisC, err := tcredis.Run(ctx, "redis:7-alpine")
	if err != nil {
		log.Printf("start redis container: %v", err)
		return 1
	}
	defer terminate(ctx, redisC)

	minioC, err := tcminio.Run(ctx, "minio/minio:latest")
	if err != nil {
		log.Printf("start minio container: %v", err)
		return 1
	}
	defer terminate(ctx, minioC)

	dsn, err := pgC.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		log.Printf("postgres dsn: %v", err)
		return 1
	}
	if err := migrateUp(dsn); err != nil {
		log.Printf("migrations: %v", err)
		return 1
	}

	redisURL, err := redisC.ConnectionString(ctx)
	if err != nil {
		log.Printf("redis url: %v", err)
		return 1
	}
	redisAddr := strings.TrimPrefix(redisURL, "redis://")

	minioHost, err := minioC.ConnectionString(ctx)
	if err != nil {
		log.Printf("minio endpoint: %v", err)
		return 1
	}
	s3Endpoint := "http://" + minioHost

	env.mc, err = minio.New(minioHost, &minio.Options{
		Creds: credentials.NewStaticV4(minioC.Username, minioC.Password, ""),
	})
	if err != nil {
		log.Printf("minio client: %v", err)
		return 1
	}
	if err := env.mc.MakeBucket(ctx, testBucket, minio.MakeBucketOptions{}); err != nil {
		log.Printf("make bucket: %v", err)
		return 1
	}
	// Как в minio-init: анонимное чтение только для деривативов (drv/).
	policy := fmt.Sprintf(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":["*"]},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::%s/drv/*"]}]}`, testBucket)
	if err := env.mc.SetBucketPolicy(ctx, testBucket, policy); err != nil {
		log.Printf("set bucket policy: %v", err)
		return 1
	}

	env.pool, err = pgxpool.New(ctx, dsn)
	if err != nil {
		log.Printf("pgx pool: %v", err)
		return 1
	}
	defer env.pool.Close()
	env.q = db.New(env.pool)

	env.store, err = storage.New(s3Endpoint, s3Endpoint, minioC.Username, minioC.Password, testBucket)
	if err != nil {
		log.Printf("storage client: %v", err)
		return 1
	}

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer func() { _ = rdb.Close() }()
	env.rdb = rdb

	asynqClient := asynq.NewClient(asynq.RedisClientOpt{Addr: redisAddr})
	defer asynqClient.Close()

	// Фейковая витрина: принимает вебхуки ревалидации от API и воркера.
	env.revalidated = make(chan string, 100)
	fakeNext := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/revalidate" ||
			r.Header.Get(revalidate.SecretHeader) != testRevalidateSecret {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var body struct {
			Slug string `json:"slug"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		select {
		case env.revalidated <- body.Slug:
		default:
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer fakeNext.Close()
	notifier := revalidate.New(fakeNext.URL, testRevalidateSecret, logger)

	// Фейковая ЮKassa: платежи создаются и подтверждаются локально.
	env.yk = newFakeYooKassa()
	defer env.yk.srv.Close()
	ykClient := billing.New(env.yk.srv.URL, "test-yk-shop", "test-yk-key")

	env.mail = newCaptureMail()

	cfg := config.Config{
		SessionTTL:      time.Hour,
		AuthRateLimit:   30,
		PublicRateLimit: 300,
		SiteURL:         "http://katalog.test",
		StopWords:       []string{"контрафакт", "запрещёнка"},
		Mail:            config.MailConfig{AdminEmail: "moderator@test.local"},
		Billing: config.BillingConfig{
			// Маленький лимит фото на free — для теста квоты.
			Plans: map[string]config.PlanLimits{
				"free":  {MaxPhotos: 8, MaxStorage: 1 << 30},
				"basic": {MaxPhotos: 100, MaxStorage: 10 << 30, PriceKopecks: 49000},
				"pro":   {MaxPhotos: 200, MaxStorage: 20 << 30, PriceKopecks: 99000},
			},
			GraceDays:  14,
			PeriodDays: 30,
			ReturnURL:  "http://localhost/app/billing",
		},
	}
	app := &api.API{
		Q:          env.q,
		Pool:       env.pool,
		Sessions:   auth.NewSessions(rdb, cfg.SessionTTL),
		Tokens:     auth.NewTokens(rdb),
		RDB:        rdb,
		Store:      env.store,
		Tasks:      asynqClient,
		Revalidate: notifier,
		Billing:    ykClient,
		Cfg:        cfg,
		Log:        logger,
	}
	env.srv = httptest.NewServer(app.Router())
	defer env.srv.Close()

	// Воркер в том же процессе — полный путь presign -> put -> confirm ->
	// asynq -> govips -> ready проверяется по-настоящему.
	asynqSrv := asynq.NewServer(asynq.RedisClientOpt{Addr: redisAddr}, asynq.Config{
		Concurrency: 2,
		Logger:      quietLogger{logger},
	})
	mux := asynq.NewServeMux()
	processor := &worker.Processor{
		Q:          env.q,
		Store:      env.store,
		RDB:        rdb,
		Revalidate: notifier,
		Billing:    ykClient,
		BillingCfg: cfg.Billing,
		Mail:       env.mail,
		Log:        logger,
	}
	env.processor = processor
	mux.HandleFunc(tasks.TypePhotoProcess, processor.HandlePhotoProcess)
	mux.HandleFunc(tasks.TypeStatsAggregate, processor.HandleStatsAggregate)
	mux.HandleFunc(tasks.TypeEmailSend, processor.HandleEmailSend)
	if err := asynqSrv.Start(mux); err != nil {
		log.Printf("start asynq server: %v", err)
		return 1
	}
	defer asynqSrv.Shutdown()

	return m.Run()
}

func migrateUp(dsn string) error {
	sqlDB, err := sql.Open("pgx", dsn)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer sqlDB.Close()
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	goose.SetLogger(goose.NopLogger())
	if err := goose.Up(sqlDB, "../../../migrations"); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	return nil
}

func terminate(ctx context.Context, c testcontainers.Container) {
	if err := c.Terminate(ctx); err != nil {
		log.Printf("terminate container: %v", err)
	}
}

type quietLogger struct{ l *slog.Logger }

func (q quietLogger) Debug(args ...any) {}
func (q quietLogger) Info(args ...any)  {}
func (q quietLogger) Warn(args ...any)  { q.l.Warn(fmt.Sprint(args...)) }
func (q quietLogger) Error(args ...any) { q.l.Error(fmt.Sprint(args...)) }
func (q quietLogger) Fatal(args ...any) { q.l.Error(fmt.Sprint(args...)) }
