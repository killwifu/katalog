package api

import (
	"context"
	"net/http"
	"time"
)

// handleHealthz — 200, только если доступны Postgres и Redis. Его опрашивают
// healthcheck контейнера, проверка после деплоя в CI и внешний мониторинг:
// «процесс жив, а база лежит» для покупателя то же самое, что «сайт лежит».
func (a *API) handleHealthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.Pool.Ping(ctx); err != nil {
		a.Log.Error("healthz: postgres", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "postgres unavailable"})
		return
	}
	if err := a.RDB.Ping(ctx).Err(); err != nil {
		a.Log.Error("healthz: redis", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "redis unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
