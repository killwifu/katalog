package api

import (
	"net/http"
	"strconv"
)

// handleAdminOverview — сводка платформы одним запросом.
func (a *API) handleAdminOverview(w http.ResponseWriter, r *http.Request) {
	row, err := a.Q.AdminPlatformOverview(r.Context())
	if err != nil {
		a.internalError(w, "admin overview", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"active_shops":    row.ActiveShops,
		"suspended_shops": row.SuspendedShops,
		"ready_photos":    row.ReadyPhotos,
		"open_complaints": row.OpenComplaints,
		"storage_used":    row.StorageUsed,
	})
}

type adminShopResponse struct {
	ID           string `json:"id"`
	Slug         string `json:"slug"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	Plan         string `json:"plan"`
	Status       string `json:"status"`
	BillingState string `json:"billing_state"`
	StorageUsed  int64  `json:"storage_used"`
	Photos       int64  `json:"photos"`
	Complaints   int64  `json:"complaints"`
}

// handleAdminListShops — продавцы, сначала те, на кого больше жалоб:
// модератору важно отличить единичный случай от системы.
func (a *API) handleAdminListShops(w http.ResponseWriter, r *http.Request) {
	limit := int32(100)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 500 {
			limit = int32(n)
		}
	}
	rows, err := a.Q.AdminListShops(r.Context(), limit)
	if err != nil {
		a.internalError(w, "admin list shops", err)
		return
	}
	out := make([]adminShopResponse, 0, len(rows))
	for _, s := range rows {
		item := adminShopResponse{
			ID:           s.ID.String(),
			Slug:         s.Slug,
			Name:         s.Name,
			Plan:         string(s.Plan),
			Status:       string(s.Status),
			BillingState: string(s.BillingState),
			StorageUsed:  s.StorageUsed,
			Photos:       s.Photos,
			Complaints:   s.Complaints,
		}
		if s.Email != nil {
			item.Email = *s.Email
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}
