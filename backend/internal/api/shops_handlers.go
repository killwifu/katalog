package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"katalog/backend/internal/db"
	"katalog/backend/internal/tasks"
)

// slugPattern: строчные латинские буквы/цифры/дефис, 3-63 символа,
// без дефисов по краям и двойных дефисов.
var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){2,62}$`)

// reservedSlugs — системные слова, запрещённые как slug магазина.
var reservedSlugs = map[string]struct{}{
	"admin": {}, "api": {}, "app": {}, "www": {}, "static": {}, "assets": {},
	"cdn": {}, "media": {}, "auth": {}, "login": {}, "signup": {}, "register": {},
	"about": {}, "help": {}, "support": {}, "blog": {}, "docs": {}, "status": {},
	"healthz": {}, "metrics": {}, "mail": {}, "billing": {}, "settings": {},
	"terms": {}, "privacy": {}, "abuse": {}, "root": {}, "system": {},
	"content-policy": {},
	// Публичные страницы витрины: статический сегмент в Next перекрывает
	// /{slug}, поэтому магазин с таким адресом стал бы недоступен.
	"pricing": {}, "updates": {}, "remove-bg": {},
}

func validateSlug(slug string) string {
	if !slugPattern.MatchString(slug) {
		return "slug must be 3-63 chars: lowercase latin letters, digits, single hyphens"
	}
	if _, ok := reservedSlugs[slug]; ok {
		return "this slug is reserved"
	}
	return ""
}

type shopResponse struct {
	ID           string          `json:"id"`
	Slug         string          `json:"slug"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Contacts     json.RawMessage `json:"contacts"`
	Settings     json.RawMessage `json:"settings"`
	Status       string          `json:"status"`
	Plan         string          `json:"plan"`
	BillingState string          `json:"billing_state"`
	PaidUntil    *time.Time      `json:"paid_until"`
	StorageUsed  int64           `json:"storage_used"`
	StorageMax   int64           `json:"storage_max"`
	MaxPhotos    int64           `json:"max_photos"`
	// SlugChangeableAt — когда адрес можно будет сменить снова. null,
	// если можно прямо сейчас. Считает сервер: повторять правило
	// в кабинете значит разойтись с ним при первой правке срока.
	SlugChangeableAt *time.Time `json:"slug_changeable_at"`
}

func (a *API) toShopResponse(s db.Shop) shopResponse {
	var slugChangeableAt *time.Time
	if s.SlugChangedAt.Valid {
		if next := s.SlugChangedAt.Time.Add(slugChangeCooldown); time.Now().Before(next) {
			slugChangeableAt = &next
		}
	}
	limits := a.Cfg.Billing.Limits(string(s.Plan))
	resp := shopResponse{
		ID:               s.ID.String(),
		Slug:             s.Slug,
		Name:             s.Name,
		Description:      s.Description,
		Contacts:         json.RawMessage(s.Contacts),
		Settings:         json.RawMessage(s.Settings),
		Status:           string(s.Status),
		Plan:             string(s.Plan),
		BillingState:     string(s.BillingState),
		StorageUsed:      s.StorageUsed,
		StorageMax:       limits.MaxStorage,
		MaxPhotos:        limits.MaxPhotos,
		SlugChangeableAt: slugChangeableAt,
	}
	if s.PaidUntil.Valid {
		resp.PaidUntil = &s.PaidUntil.Time
	}
	return resp
}

// maxShopsPerOwner — см. handleCreateShop.
const maxShopsPerOwner = 5

type createShopRequest struct {
	Slug        string          `json:"slug"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Contacts    json.RawMessage `json:"contacts"`
}

func (a *API) handleCreateShop(w http.ResponseWriter, r *http.Request) {
	var req createShopRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Slug = strings.ToLower(strings.TrimSpace(req.Slug))
	req.Name = strings.TrimSpace(req.Name)
	if msg := validateSlug(req.Slug); msg != "" {
		apiError(w, http.StatusBadRequest, "invalid_slug", msg)
		return
	}
	if req.Name == "" || len(req.Name) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_name", "name must be 1-200 characters")
		return
	}
	contacts := req.Contacts
	if len(contacts) == 0 {
		contacts = json.RawMessage(`{}`)
	}
	if msg := validateContacts(contacts); msg != "" {
		apiError(w, http.StatusBadRequest, "invalid_contacts", msg)
		return
	}

	// Потолок на число магазинов у одного владельца. Адрес витрины — это
	// весь корень домена (/{slug}), и без потолка один аккаунт мог занять
	// сколько угодно адресов: приватные ручки rate-limit не покрывает.
	// Кабинет всё равно работает с одним магазином, так что пять — заведомо
	// больше любого честного сценария.
	count, err := a.Q.CountShopsByOwner(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "count shops", err)
		return
	}
	if count >= maxShopsPerOwner {
		apiError(w, http.StatusConflict, "shop_limit",
			fmt.Sprintf("one account holds at most %d shops", maxShopsPerOwner))
		return
	}

	shop, err := a.Q.CreateShop(r.Context(), db.CreateShopParams{
		OwnerID:     userID(r),
		Slug:        req.Slug,
		Name:        req.Name,
		Description: req.Description,
		Contacts:    contacts,
		Settings:    json.RawMessage(`{}`),
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		apiError(w, http.StatusConflict, "slug_taken", "this slug is already taken")
		return
	}
	if err != nil {
		a.internalError(w, "create shop", err)
		return
	}
	a.createSystemTabs(r, shop.ID)
	writeJSON(w, http.StatusCreated, a.toShopResponse(shop))
}

// createSystemTabs — «Главная», «Альбомы» и «Контакты» генерируются
// автоматически и продавцом не удаляются (kit). Ошибка не роняет создание
// магазина: вкладки — навигация витрины, без них магазин рабочий,
// а повторить их создание можно.
func (a *API) createSystemTabs(r *http.Request, shopID uuid.UUID) {
	systemTabs := []struct {
		title string
		slug  string
	}{
		{"Главная", "home"},
		{"Альбомы", "albums"},
		{"Контакты", "contacts"},
	}
	for i, t := range systemTabs {
		if _, err := a.Q.CreateTab(r.Context(), db.CreateTabParams{
			ShopID:    shopID,
			Title:     t.title,
			Slug:      t.slug,
			IsSystem:  true,
			SortOrder: int32(i),
		}); err != nil {
			a.Log.Warn("create system tab", "shop_id", shopID, "slug", t.slug, "error", err)
		}
	}
}

func (a *API) handleListShops(w http.ResponseWriter, r *http.Request) {
	shops, err := a.Q.ListShopsByOwner(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "list shops", err)
		return
	}
	out := make([]shopResponse, 0, len(shops))
	for _, s := range shops {
		out = append(out, a.toShopResponse(s))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleGetShop(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.toShopResponse(shopFromCtx(r)))
}

// slugChangeCooldown — как часто продавец может менять адрес витрины.
// Ограничение продуктовое, а не техническое: смена рвёт все разосланные
// покупателям ссылки, и делать это «по настроению» нельзя.
const slugChangeCooldown = 180 * 24 * time.Hour

type updateShopRequest struct {
	Slug        *string          `json:"slug"`
	Name        *string          `json:"name"`
	Description *string          `json:"description"`
	Contacts    *json.RawMessage `json:"contacts"`
	Settings    *json.RawMessage `json:"settings"`
}

func (a *API) handleUpdateShop(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req updateShopRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	name, description := shop.Name, shop.Description
	contacts, settings := shop.Contacts, shop.Settings
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 200 {
			apiError(w, http.StatusBadRequest, "invalid_name", "name must be 1-200 characters")
			return
		}
	}
	if req.Description != nil {
		description = *req.Description
	}
	if req.Contacts != nil {
		if msg := validateContacts(*req.Contacts); msg != "" {
			apiError(w, http.StatusBadRequest, "invalid_contacts", msg)
			return
		}
		contacts = *req.Contacts
	}
	if req.Settings != nil {
		settings = *req.Settings
	}

	updated, err := a.Q.UpdateShop(r.Context(), db.UpdateShopParams{
		ID:          shop.ID,
		OwnerID:     userID(r),
		Name:        name,
		Description: description,
		Contacts:    contacts,
		Settings:    settings,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return
	}
	if err != nil {
		a.internalError(w, "update shop", err)
		return
	}
	// Адрес меняем после остальных полей и отдельным запросом: он отмечает
	// дату смены, а обычное сохранение настроек её трогать не должно.
	if req.Slug != nil && *req.Slug != updated.Slug {
		var ok bool
		updated, ok = a.changeShopSlug(w, r, updated, *req.Slug)
		if !ok {
			return
		}
	}

	a.Revalidate.Shop(updated.Slug)
	writeJSON(w, http.StatusOK, a.toShopResponse(updated))
}

// changeShopSlug меняет адрес витрины с проверкой частоты. Старый slug
// тоже ревалидируем: страница по нему должна перестать отдаваться сразу,
// а не висеть в кеше ISR до истечения TTL.
func (a *API) changeShopSlug(w http.ResponseWriter, r *http.Request, shop db.Shop, raw string) (db.Shop, bool) {
	slug := strings.ToLower(strings.TrimSpace(raw))
	if msg := validateSlug(slug); msg != "" {
		apiError(w, http.StatusBadRequest, "invalid_slug", msg)
		return shop, false
	}
	if shop.SlugChangedAt.Valid {
		if next := shop.SlugChangedAt.Time.Add(slugChangeCooldown); time.Now().Before(next) {
			apiError(w, http.StatusConflict, "slug_change_too_soon",
				"адрес можно менять не чаще раза в полгода: следующая смена после "+next.Format("02.01.2006"))
			return shop, false
		}
	}

	oldSlug := shop.Slug
	renamed, err := a.Q.UpdateShopSlug(r.Context(), db.UpdateShopSlugParams{
		ID:      shop.ID,
		OwnerID: userID(r),
		Slug:    slug,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			apiError(w, http.StatusConflict, "slug_taken", "this slug is already taken")
			return shop, false
		}
		a.internalError(w, "update shop slug", err)
		return shop, false
	}
	a.Revalidate.Shop(oldSlug)
	return renamed, true
}

func (a *API) handleDeleteShop(w http.ResponseWriter, r *http.Request) {
	n, err := a.Q.DeleteShop(r.Context(), db.DeleteShopParams{
		ID:      shopFromCtx(r).ID,
		OwnerID: userID(r),
	})
	if err != nil {
		a.internalError(w, "delete shop", err)
		return
	}
	if n == 0 {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return
	}
	a.purgeStorage(r, shopFromCtx(r).ID, nil)
	a.Revalidate.Shop(shopFromCtx(r).Slug)
	w.WriteHeader(http.StatusNoContent)
}

// purgeStorage ставит задачу на уборку объектов S3 после каскадного удаления
// строк. Пустой список фото — весь магазин. Ошибку только логируем: строки
// уже удалены, откатывать нечего, а мусор в хранилище — не повод отдать 500.
func (a *API) purgeStorage(r *http.Request, shopID uuid.UUID, photoIDs []uuid.UUID) {
	task, err := tasks.NewStoragePurge(shopID, photoIDs)
	if err != nil {
		a.Log.Error("purge: build task failed", "error", err)
		return
	}
	if _, err := a.Tasks.EnqueueContext(r.Context(), task); err != nil {
		a.Log.Error("purge: enqueue failed", "shop_id", shopID, "error", err)
	}
}
