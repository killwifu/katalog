package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

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
	if req.URL == "" || len([]rune(req.URL)) > 1000 || !webURL(req.URL) {
		apiError(w, http.StatusBadRequest, "invalid_url", "url must be an http(s) link of 1-1000 characters")
		return
	}
	if n := len([]rune(req.Reason)); n < 10 || n > 5000 {
		apiError(w, http.StatusBadRequest, "invalid_reason", "reason must be 10-5000 characters")
		return
	}
	// Имя обязательно по контракту: анонимную претензию правообладателя
	// модератору не с кем отрабатывать. Раньше проходило имя из пробелов.
	if n := len([]rune(req.ReporterName)); n == 0 || n > 200 {
		apiError(w, http.StatusBadRequest, "invalid_name", "reporter_name must be 1-200 characters")
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
	a.sendEmail(r.Context(), a.Cfg.Mail.AdminEmail, "вуад: новая жалоба на контент",
		fmt.Sprintf("Поступила жалоба %s.\n\nСсылка: %s\nЗаявитель: %s <%s>\n\nПретензия:\n%s\n\n"+
			"Открыть админ-зону: %s/app/admin",
			complaint.ID, req.URL, req.ReporterName, req.ReporterEmail, req.Reason, a.Cfg.SiteURL))

	writeJSON(w, http.StatusCreated, map[string]string{
		"id":     complaint.ID.String(),
		"status": string(complaint.Status),
	})
}

// webURL — ссылка без схемы или со схемой http(s). Схемы вроде javascript:
// и data: в жалобе бессмысленны и засоряли очередь модератора.
func webURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return u.Scheme == "" || u.Scheme == "http" || u.Scheme == "https"
}

// resolveComplaintTarget — best-effort привязка жалобы к магазину/фото по URL:
// .../{shop_id}/{photo_id}/{name}.webp -> конкретное фото,
// /{slug}[/...] -> магазин. Нераспознанное — жалоба без привязки.
//
// Адрес дериватива узнаём по хвосту, а не по первому сегменту: префикс
// задаётся MEDIA_BASE_URL и в проде совсем другой, чем локально —
// домен CDN или бакет S3 (deploy/s3/setup.sh выдаёт .../{bucket}/drv).
// Пока разбор требовал сегмента «media», правообладатель присылал ссылку
// на картинку, а жалоба приходила без привязки, и модератор искал фото
// руками — при том что оно было однозначно определено этой самой ссылкой.
func (a *API) resolveComplaintTarget(ctx context.Context, raw string) (uuid.NullUUID, uuid.NullUUID) {
	u, err := url.Parse(raw)
	if err != nil {
		return uuid.NullUUID{}, uuid.NullUUID{}
	}
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	if n := len(segs); n >= 3 && strings.HasSuffix(segs[n-1], ".webp") {
		if pid, err := uuid.Parse(segs[n-2]); err == nil {
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

// Жалоба покупателя с витрины (макет 15 · «Жалоба»): анонимная, на витрину,
// альбом или фото этой витрины. Объект и ссылку на него определяет сервер:
// клиенту верим только в id, и только если объект сейчас виден на витрине.
// Скрытое, чужое и несуществующее — одинаковый 404.

var buyerComplaintReasons = map[string]string{
	"prohibited":  "Запрещённые товары",
	"violence":    "Насилие или жестокость",
	"adult":       "Контент 18+",
	"fraud":       "Мошенничество",
	"counterfeit": "Подделка или нарушение прав",
	"hate":        "Оскорбления или ненависть",
	"spam":        "Спам",
	"other":       "Другое",
}

var buyerComplaintTargets = map[string]string{"shop": "витрину", "album": "альбом", "photo": "фото"}

type buyerComplaintRequest struct {
	Target   string `json:"target"`
	TargetID string `json:"target_id"`
	Reason   string `json:"reason"`
	Comment  string `json:"comment"`
}

func (a *API) handleCreateBuyerComplaint(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	var req buyerComplaintRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Comment = strings.TrimSpace(req.Comment)
	if _, ok := buyerComplaintTargets[req.Target]; !ok {
		apiError(w, http.StatusBadRequest, "invalid_target", "target must be one of: shop, album, photo")
		return
	}
	if _, ok := buyerComplaintReasons[req.Reason]; !ok {
		apiError(w, http.StatusBadRequest, "invalid_reason", "reason must be one of the listed codes")
		return
	}
	if len([]rune(req.Comment)) > 500 {
		apiError(w, http.StatusBadRequest, "invalid_comment", "comment must be at most 500 characters")
		return
	}
	// «Другое» без описания модератору не о чем проверять.
	if req.Reason == "other" && req.Comment == "" {
		apiError(w, http.StatusBadRequest, "comment_required", "comment is required for reason other")
		return
	}

	params := db.CreateBuyerComplaintParams{
		ShopID:     uuid.NullUUID{UUID: shop.ID, Valid: true},
		TargetType: &req.Target,
		ReasonCode: &req.Reason,
		Reason:     req.Comment,
		ContentUrl: fmt.Sprintf("%s/%s", a.Cfg.SiteURL, url.PathEscape(shop.Slug)),
	}
	notFound := func() { apiError(w, http.StatusNotFound, "not_found", req.Target+" not found") }
	if req.Target != "shop" {
		id, err := uuid.Parse(req.TargetID)
		if err != nil {
			notFound()
			return
		}
		albumID, photoID := id, uuid.NullUUID{}
		if req.Target == "photo" {
			photo, err := a.Q.GetPhoto(r.Context(), id)
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && (photo.ShopID != shop.ID ||
				photo.Status != db.PhotoStatusReady || photo.DeletedAt.Valid)) {
				notFound()
				return
			}
			if err != nil {
				a.internalError(w, "load complaint photo", err)
				return
			}
			albumID, photoID = photo.AlbumID, uuid.NullUUID{UUID: photo.ID, Valid: true}
		}
		// Тот же фильтр, что у страницы альбома: черновик, скрытый тарифом
		// или модератором, корзина и чужой магазин — не видны покупателю.
		album, err := a.Q.GetPublicAlbum(r.Context(), db.GetPublicAlbumParams{
			ID: uuid.NullUUID{UUID: albumID, Valid: true}, ShopID: shop.ID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			notFound()
			return
		}
		if err != nil {
			a.internalError(w, "load complaint album", err)
			return
		}
		if photoID.Valid {
			lock, err := a.albumLock(r.Context(), album)
			if err != nil {
				a.internalError(w, "load complaint album lock", err)
				return
			}
			if lock.PasswordHash != nil && !a.albumUnlocked(r, lock) {
				notFound()
				return
			}
		}
		params.AlbumID = uuid.NullUUID{UUID: album.ID, Valid: true}
		params.PhotoID = photoID
		params.ContentUrl += "/" + url.PathEscape(album.Slug)
		if photoID.Valid {
			params.ContentUrl += "?p=" + photoID.UUID.String()
		}
	}

	complaint, err := a.Q.CreateBuyerComplaint(r.Context(), params)
	if err != nil {
		a.internalError(w, "create buyer complaint", err)
		return
	}
	a.sendEmail(r.Context(), a.Cfg.Mail.AdminEmail, "вуад: жалоба покупателя на "+buyerComplaintTargets[req.Target],
		fmt.Sprintf("Поступила жалоба %s.\n\nСсылка: %s\nПричина: %s\n\nКомментарий:\n%s\n\n"+
			"Открыть админ-зону: %s/app/admin",
			complaint.ID, params.ContentUrl, buyerComplaintReasons[req.Reason], req.Comment, a.Cfg.SiteURL))

	writeJSON(w, http.StatusCreated, map[string]string{
		"id":     complaint.ID.String(),
		"status": string(complaint.Status),
	})
}
