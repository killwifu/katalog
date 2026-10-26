package integration

import (
	"net/http"
	"testing"
)

// /healthz с живыми Postgres и Redis — 200 (503 при недоступной базе
// проверяет unit-тест в internal/api).
func TestHealthzOK(t *testing.T) {
	c := newClient(t)
	if status, body := c.do("GET", "/healthz", nil); status != http.StatusOK {
		t.Fatalf("healthz: %d %s", status, body)
	}
}

// Фронты берут DSN Sentry отсюда; без SENTRY_DSN — пустая строка, не 404.
func TestPublicConfig(t *testing.T) {
	c := newClient(t)
	var body struct {
		SentryDSN *string `json:"sentry_dsn"`
	}
	c.mustJSON("GET", "/api/v1/public/config", nil, http.StatusOK, &body)
	if body.SentryDSN == nil {
		t.Fatal("нет поля sentry_dsn")
	}
}
