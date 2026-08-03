package api

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Бизнес-метрики в Prometheus text format (без client_golang — в проекте
// уже принят hand-rolled формат, см. /metrics воркера с глубиной очереди).
// Эндпоинт /metrics слушает только порт API и наружу через Caddy не проксируется.

// latencyBuckets — границы гистограммы латентности публичных запросов, сек.
// Бюджет p95 витрины — 200 мс, сетка вокруг него.
var latencyBuckets = []float64{0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6}

// Histogram — потокобезопасная Prometheus-гистограмма.
type Histogram struct {
	mu     sync.Mutex
	counts []uint64 // len(latencyBuckets)+1, последний — +Inf
	sum    float64
	total  uint64
}

func NewHistogram() *Histogram {
	return &Histogram{counts: make([]uint64, len(latencyBuckets)+1)}
}

func (h *Histogram) Observe(seconds float64) {
	idx := len(latencyBuckets) // +Inf
	for i, le := range latencyBuckets {
		if seconds <= le {
			idx = i
			break
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.counts[idx]++
	h.sum += seconds
	h.total++
}

// writeTo — метрика name в текстовом формате Prometheus (кумулятивные бакеты).
func (h *Histogram) writeTo(w http.ResponseWriter, name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var cum uint64
	for i, le := range latencyBuckets {
		cum += h.counts[i]
		_, _ = fmt.Fprintf(w, "%s_bucket{le=\"%g\"} %d\n", name, le, cum)
	}
	cum += h.counts[len(latencyBuckets)]
	_, _ = fmt.Fprintf(w, "%s_bucket{le=\"+Inf\"} %d\n", name, cum)
	_, _ = fmt.Fprintf(w, "%s_sum %g\n", name, h.sum)
	_, _ = fmt.Fprintf(w, "%s_count %d\n", name, h.total)
}

// measurePublic — middleware горячего пути витрины: длительность каждого
// публичного запроса попадает в гистограмму (p95 считает Prometheus).
func (a *API) measurePublic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		a.PublicLatency.Observe(time.Since(start).Seconds())
	})
}

// handleMetrics — бизнес-метрики: загрузки за сегодня, активные магазины,
// латентность публичного API. Глубина очереди — на /metrics воркера.
func (a *API) handleMetrics(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	uploads, err := a.Q.CountPhotosUploadedSince(r.Context(), pgtype.Timestamptz{Time: dayStart, Valid: true})
	if err != nil {
		a.internalError(w, "count uploads", err)
		return
	}
	activeShops, err := a.Q.CountActiveShops(r.Context())
	if err != nil {
		a.internalError(w, "count active shops", err)
		return
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = fmt.Fprintf(w, "# HELP katalog_uploads_today Photos uploaded since UTC midnight\n")
	_, _ = fmt.Fprintf(w, "katalog_uploads_today %d\n", uploads)
	_, _ = fmt.Fprintf(w, "# HELP katalog_active_shops Shops with status=active\n")
	_, _ = fmt.Fprintf(w, "katalog_active_shops %d\n", activeShops)
	_, _ = fmt.Fprintf(w, "# HELP katalog_public_request_seconds Public storefront API request latency\n")
	_, _ = fmt.Fprintf(w, "# TYPE katalog_public_request_seconds histogram\n")
	a.PublicLatency.writeTo(w, "katalog_public_request_seconds")
}
