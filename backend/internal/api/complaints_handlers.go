package api

import (
	"context"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"strings"

	"github.com/google/uuid"

	"katalog/backend/internal/db"
)

// Публичная форма жалобы правообладателя (notice-and-takedown), без auth.
// shop_id/photo_id заполняются, только если ссылку удалось распознать;
// нераспознанный URL не мешает подать жалобу.

type complaintRequest struct {
	URL           string `json:"url"`
	ReporterName  string `json:"reporter_name"`
	ReporterEmail string `json:"reporter_email"`
	Reason        string `json:"reason"`
}

func (a *API) handleCreateComplaint(w http.ResponseWriter, r *http.Request) {
	var req complaintRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	req.Reason = strings.TrimSpace(req.Reason)
	req.ReporterName = strings.TrimSpace(req.ReporterName)
	req.ReporterEmail = strings.TrimSpace(req.ReporterEmail)
	if req.URL == "" || len([]rune(req.URL)) > 1000 {
		apiError(w, http.StatusBadRequest, "invalid_url", "url must be 1-1000 characters")
		return
	}
	if n := len([]rune(req.Reason)); n < 10 || n > 5000 {
		apiError(w, http.StatusBadRequest, "invalid_reason", "reason must be 10-5000 characters")
		return
	}
	if len([]rune(req.ReporterName)) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_name", "reporter_name must be at most 200 characters")
		return
	}
	if _, err := mail.ParseAddress(req.ReporterEmail); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_email", "reporter_email must be a valid email")
		return
	}

	shopID, photoID := a.resolveComplaintTarget(r.Context(), req.URL)
	complaint, err := a.Q.CreateComplaint(r.Context(), db.CreateComplaintParams{
		ShopID:        shopID,
		PhotoID:       photoID,
		Reason:        req.Reason,
		ReporterName:  req.ReporterName,
		ReporterEmail: req.ReporterEmail,
		ContentUrl:    req.URL,
	})
	if err != nil {
		a.internalError(w, "create complaint", err)
		return
	}

	// Уведомление админу (если сконфигурирован адрес).
	a.sendEmail(r.Context(), a.Cfg.Mail.AdminEmail, "Katalog: новая жалоба на контент",
		fmt.Sprintf("Поступила жалоба %s.\n\nСсылка: %s\nЗаявитель: %s <%s>\n\nПретензия:\n%s\n\n"+
			"Открыть админ-зону: %s/app/admin",
			complaint.ID, req.URL, req.ReporterName, req.ReporterEmail, req.Reason, a.Cfg.SiteURL))

	writeJSON(w, http.StatusCreated, map[string]string{
		"id":     complaint.ID.String(),
		"status": string(complaint.Status),
	})
}

// resolveComplaintTarget — best-effort привязка жалобы к магазину/фото по URL:
// /media/{shop_id}/{photo_id}/{size}.webp -> конкретное фото,
// /{slug}[/...] -> магазин. Нераспознанное — жалоба без привязки.
func (a *API) resolveComplaintTarget(ctx context.Context, raw string) (uuid.NullUUID, uuid.NullUUID) {
	u, err := url.Parse(raw)
	if err != nil {
		return uuid.NullUUID{}, uuid.NullUUID{}
	}
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(segs) >= 3 && segs[0] == "media" {
		if pid, err := uuid.Parse(segs[2]); err == nil {
			if photo, err := a.Q.GetPhoto(ctx, pid); err == nil {
				return uuid.NullUUID{UUID: photo.ShopID, Valid: true},
					uuid.NullUUID{UUID: photo.ID, Valid: true}
			}
		}
	}
	if len(segs) >= 1 && segs[0] != "" {
		if shop, err := a.Q.GetShopBySlugAny(ctx, segs[0]); err == nil {
			return uuid.NullUUID{UUID: shop.ID, Valid: true}, uuid.NullUUID{}
		}
	}
	return uuid.NullUUID{}, uuid.NullUUID{}
}
