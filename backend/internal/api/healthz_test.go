package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// Недоступная база должна давать 503, а не «ok»: иначе внешний мониторинг
// не заметит падения Postgres. Порт 1 закрыт — Ping падает сразу.
func TestHealthzUnavailable(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://u:p@127.0.0.1:1/db?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	a := &API{
		Pool: pool,
		RDB:  redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"}),
		Log:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	rec := httptest.NewRecorder()
	a.handleHealthz(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503; body %s", rec.Code, rec.Body)
	}
}
