package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imagingmeta"
)

// Админ-зона (роль admin): жалобы, блокировки контента, аудит-лог.
// Каждое действие модератора пишется в moderation_log; владелец магазина
// получает email-уведомление о блокировке контента.

var complaintStatuses = map[string]db.ComplaintStatus{
	"open":      db.ComplaintStatusOpen,
	"in_review": db.ComplaintStatusInReview,
	"resolved":  db.ComplaintStatusResolved,
	"rejected":  db.ComplaintStatusRejected,
}

type adminComplaintResponse struct {
	ID            string     `json:"id"`
	ShopID        *string    `json:"shop_id"`
	ShopSlug      *string    `json:"shop_slug"`
	PhotoID       *string    `json:"photo_id"`
	PhotoAlbumID  *string    `json:"photo_album_id"`
	Reason        string     `json:"reason"`
	ReporterName  string     `json:"reporter_name"`
	ReporterEmail string     `json:"reporter_email"`
	ContentURL    string     `json:"content_url"`
	Status        string     `json:"status"`
	CreatedAt     time.Time  `json:"created_at"`
	ResolvedAt    *time.Time `json:"resolved_at"`
}

func uuidPtr(id uuid.NullUUID) *string {
	if !id.Valid {
		return nil
	}
	s := id.UUID.String()
	return &s
}

func (a *API) handleAdminListComplaints(w http.ResponseWriter, r *http.Request) {
	var status db.NullComplaintStatus
	if raw := r.URL.Query().Get("status"); raw != "" {
		st, ok := complaintStatuses[raw]
		if !ok {
			apiError(w, http.StatusBadRequest, "invalid_status", "status must be one of: open, in_review, resolved, rejected")
			return
		}
		status = db.NullComplaintStatus{ComplaintStatus: st, Valid: true}
	}
	rows, err := a.Q.ListComplaints(r.Context(), status)
	if err != nil {
		a.internalError(w, "list complaints", err)
		return
	}
	out := make([]adminComplaintResponse, 0, len(rows))
	for _, c := range rows {
		resp := adminComplaintResponse{
			ID:            c.ID.String(),
			ShopID:        uuidPtr(c.ShopID),
			ShopSlug:      c.ShopSlug,
			PhotoID:       uuidPtr(c.PhotoID),
			PhotoAlbumID:  uuidPtr(c.PhotoAlbumID),
			Reason:        c.Reason,
			ReporterName:  c.ReporterName,
			ReporterEmail: c.ReporterEmail,
			ContentURL:    c.ContentUrl,
			Status:        string(c.Status),
			CreatedAt:     c.CreatedAt.Time,
		}
		if c.ResolvedAt.Valid {
			resp.ResolvedAt = &c.ResolvedAt.Time
		}
		out = append(out, resp)
	}
	writeJSON(w, http.StatusOK, out)
}

type updateComplaintRequest struct {
	Status string `json:"status"`
}

func (a *API) handleAdminUpdateComplaint(w http.ResponseWriter, r *http.Request) {
	complaintID, err := uuid.Parse(chi.URLParam(r, "complaintID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "complaint not found")
		return
	}
	var req updateComplaintRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	status, ok := complaintStatuses[req.Status]
	if !ok {
		apiError(w, http.StatusBadRequest, "invalid_status", "status must be one of: open, in_review, resolved, rejected")
		return
	}
	updated, err := a.Q.SetComplaintStatus(r.Context(), db.SetComplaintStatusParams{
		ID:     complaintID,
		Status: status,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "complaint not found")
		return
	}
	if err != nil {
		a.internalError(w, "update complaint", err)
		return
	}
	a.auditLog(r.Context(), db.ModerationActionComplaintStatus, db.CreateModerationLogParams{
		ComplaintID: uuid.NullUUID{UUID: updated.ID, Valid: true},
		ShopID:      updated.ShopID,
		PhotoID:     updated.PhotoID,
		Note:        "status: " + string(updated.Status),
	}, r)
	writeJSON(w, http.StatusOK, map[string]string{
		"id":     updated.ID.String(),
		"status": string(updated.Status),
	})
}

// adminActionRequest — необязательное тело действий модератора:
// привязка к жалобе и заметка для аудит-лога.
type adminActionRequest struct {
	ComplaintID string `json:"complaint_id"`
	Note        string `json:"note"`
}

func (a *API) decodeAdminAction(w http.ResponseWriter, r *http.Request) (adminActionRequest, bool) {
	var req adminActionRequest
	if r.ContentLength > 0 {
		if !decodeJSON(w, r, &req) {
			return req, false
		}
	}
	return req, true
}

func (req adminActionRequest) complaintID() uuid.NullUUID {
	if id, err := uuid.Parse(req.ComplaintID); err == nil {
		return uuid.NullUUID{UUID: id, Valid: true}
	}
	return uuid.NullUUID{}
}

// handleAdminBlockPhoto — фото исчезает с витрины (status=blocked) и из CDN
// (деривативы удаляются из S3). Оригинал сохраняется. Идемпотентен.
func (a *API) handleAdminBlockPhoto(w http.ResponseWriter, r *http.Request) {
	photoID, err := uuid.Parse(chi.URLParam(r, "photoID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	req, ok := a.decodeAdminAction(w, r)
	if !ok {
		return
	}
	photo, err := a.Q.GetPhoto(r.Context(), photoID)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	if err != nil {
		a.internalError(w, "load photo", err)
		return
	}
	if _, err := a.Q.AdminBlockPhoto(r.Context(), photo.ID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Уже заблокировано — идемпотентно, без повторных side effects.
			writeJSON(w, http.StatusOK, map[string]string{"id": photo.ID.String(), "status": "blocked"})
			return
		}
		a.internalError(w, "block photo", err)
		return
	}
	if photo.Status == db.PhotoStatusReady {
		if err := a.Q.AddAlbumPhotoCount(r.Context(), db.AddAlbumPhotoCountParams{
			ID:         photo.AlbumID,
			PhotoCount: -1,
		}); err != nil {
			a.Log.Error("block: decrement album count failed", "error", err)
		}
	}
	// CDN перестаёт отдавать контент: деривативы удаляются, оригинал остаётся.
	if err := a.Store.RemoveDerivatives(r.Context(), photo.ShopID, photo.ID, imagingmeta.DerivativeSizes); err != nil {
		a.Log.Error("block: remove derivatives failed", "photo_id", photo.ID, "error", err)
	}
	a.auditLog(r.Context(), db.ModerationActionBlockPhoto, db.CreateModerationLogParams{
		ComplaintID: req.complaintID(),
		ShopID:      uuid.NullUUID{UUID: photo.ShopID, Valid: true},
		AlbumID:     uuid.NullUUID{UUID: photo.AlbumID, Valid: true},
		PhotoID:     uuid.NullUUID{UUID: photo.ID, Valid: true},
		Note:        req.Note,
	}, r)
	a.notifyShopOwner(r.Context(), photo.ShopID, "Katalog: фото скрыто модератором",
		"по жалобе правообладателя одно из ваших фото скрыто с витрины.")
	writeJSON(w, http.StatusOK, map[string]string{"id": photo.ID.String(), "status": "blocked"})
}

func (a *API) handleAdminHideAlbum(w http.ResponseWriter, r *http.Request) {
	albumID, err := uuid.Parse(chi.URLParam(r, "albumID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	req, ok := a.decodeAdminAction(w, r)
	if !ok {
		return
	}
	album, err := a.Q.AdminHideAlbum(r.Context(), albumID)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	if err != nil {
		a.internalError(w, "hide album", err)
		return
	}
	a.auditLog(r.Context(), db.ModerationActionHideAlbum, db.CreateModerationLogParams{
		ComplaintID: req.complaintID(),
		ShopID:      uuid.NullUUID{UUID: album.ShopID, Valid: true},
		AlbumID:     uuid.NullUUID{UUID: album.ID, Valid: true},
		Note:        req.Note,
	}, r)
	a.notifyShopOwner(r.Context(), album.ShopID, "Katalog: альбом скрыт модератором",
		fmt.Sprintf("по жалобе правообладателя альбом «%s» скрыт с витрины.", album.Title))
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleAdminSuspendShop(w http.ResponseWriter, r *http.Request) {
	shopID, err := uuid.Parse(chi.URLParam(r, "shopID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return
	}
	req, ok := a.decodeAdminAction(w, r)
	if !ok {
		return
	}
	shop, err := a.Q.AdminSuspendShop(r.Context(), shopID)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return
	}
	if err != nil {
		a.internalError(w, "suspend shop", err)
		return
	}
	a.auditLog(r.Context(), db.ModerationActionSuspendShop, db.CreateModerationLogParams{
		ComplaintID: req.complaintID(),
		ShopID:      uuid.NullUUID{UUID: shop.ID, Valid: true},
		Note:        req.Note,
	}, r)
	a.notifyShopOwner(r.Context(), shop.ID, "Katalog: магазин заблокирован модератором",
		"по жалобе правообладателя ваш магазин снят с публикации. "+
			"Свяжитесь с поддержкой для выяснения обстоятельств.")
	w.WriteHeader(http.StatusNoContent)
}

type flaggedPhotoResponse struct {
	ID       string `json:"id"`
	ShopID   string `json:"shop_id"`
	ShopSlug string `json:"shop_slug"`
	AlbumID  string `json:"album_id"`
	Caption  string `json:"caption"`
	Status   string `json:"status"`
}

// handleAdminListFlagged — фото, помеченные стоп-словами на ручную проверку.
func (a *API) handleAdminListFlagged(w http.ResponseWriter, r *http.Request) {
	rows, err := a.Q.ListFlaggedPhotos(r.Context())
	if err != nil {
		a.internalError(w, "list flagged photos", err)
		return
	}
	out := make([]flaggedPhotoResponse, 0, len(rows))
	for _, p := range rows {
		out = append(out, flaggedPhotoResponse{
			ID:       p.ID.String(),
			ShopID:   p.ShopID.String(),
			ShopSlug: p.ShopSlug,
			AlbumID:  p.AlbumID.String(),
			Caption:  p.Caption,
			Status:   string(p.Status),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAdminUnflagPhoto — снять флаг ручной проверки (ложное срабатывание).
func (a *API) handleAdminUnflagPhoto(w http.ResponseWriter, r *http.Request) {
	photoID, err := uuid.Parse(chi.URLParam(r, "photoID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	photo, err := a.Q.GetPhoto(r.Context(), photoID)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	if err != nil {
		a.internalError(w, "load photo", err)
		return
	}
	if err := a.Q.SetPhotoFlagged(r.Context(), db.SetPhotoFlaggedParams{
		ID:      photo.ID,
		Flagged: false,
	}); err != nil {
		a.internalError(w, "unflag photo", err)
		return
	}
	a.auditLog(r.Context(), db.ModerationActionUnflagPhoto, db.CreateModerationLogParams{
		ShopID:  uuid.NullUUID{UUID: photo.ShopID, Valid: true},
		PhotoID: uuid.NullUUID{UUID: photo.ID, Valid: true},
	}, r)
	w.WriteHeader(http.StatusNoContent)
}

// auditLog — запись действия модератора; ошибка логируется, но не валит запрос.
func (a *API) auditLog(ctx context.Context, action db.ModerationAction, params db.CreateModerationLogParams, r *http.Request) {
	params.AdminID = userID(r)
	params.Action = action
	if _, err := a.Q.CreateModerationLog(ctx, params); err != nil {
		a.Log.Error("write moderation log failed", "action", action, "error", err)
	}
}

// notifyShopOwner — ревалидация витрины магазина + email владельцу
// о действии модератора (контент изменился в обоих случаях).
func (a *API) notifyShopOwner(ctx context.Context, shopID uuid.UUID, subject, what string) {
	shop, err := a.Q.GetShopByID(ctx, shopID)
	if err != nil {
		a.Log.Error("notify owner: load shop failed", "shop_id", shopID, "error", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	owner, err := a.Q.GetUserByID(ctx, shop.OwnerID)
	if err != nil || owner.Email == nil {
		if err != nil {
			a.Log.Error("notify owner: load user failed", "error", err)
		}
		return
	}
	a.sendEmail(ctx, *owner.Email, subject,
		fmt.Sprintf("Здравствуйте!\n\nВ вашем магазине «%s» (%s/%s) %s\n\n"+
			"Подробнее о правилах: %s/content-policy",
			shop.Name, a.Cfg.SiteURL, shop.Slug, what, a.Cfg.SiteURL))
}
