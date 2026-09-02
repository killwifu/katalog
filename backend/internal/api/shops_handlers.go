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

// slugReservationDays — сколько освобождённый адрес держится за прежним
// владельцем. Столько же, сколько нельзя менять адрес повторно: к этому
// сроку разосланные ссылки в основном отживают своё.
const slugReservationDays = 180

// checkSlugReservation — не занят ли адрес бронью чужого магазина.
// Свою бронь владелец может забрать обратно.
func (a *API) checkSlugReservation(
	w http.ResponseWriter, r *http.Request, slug string, shopID uuid.UUID,
) bool {
	res, err := a.Q.GetSlugReservation(r.Context(), db.GetSlugReservationParams{
		Slug:    slug,
		Column2: slugReservationDays,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return true
	}
	if err != nil {
		a.internalError(w, "check slug reservation", err)
		return false
	}
	if res.ShopID == shopID {
		return true
	}
	// Снаружи это неотличимо от обычной занятости: существование чужого
	// магазина по такому адресу — не наше дело сообщать.
	apiError(w, http.StatusConflict, "slug_taken", "this slug is already taken")
	return false
}

// validateSlug возвращает машинный код и сообщение об ошибке; пустой код
// означает, что адрес годится. Зарезервированное слово — отдельный код:
// с общим invalid_slug кабинет говорил «Адрес: 3–63 символа, латиница»
// человеку, который ввёл совершенно правильный «app», и тот перебирал
// формат вместо того, чтобы придумать другое слово.
func validateSlug(slug string) (code, msg string) {
	if !slugPattern.MatchString(slug) {
		return "invalid_slug", "slug must be 3-63 chars: lowercase latin letters, digits, single hyphens"
	}
	if _, ok := reservedSlugs[slug]; ok {
		return "slug_reserved", "this slug is reserved for the service"
	}
	return "", ""
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

// maxShopDescription — короткий текст под названием магазина. Ограничение
// нужно не ради базы, а ради витрины: описание уходит в публичную выдачу
// на каждый заход покупателя, и раньше туда влезали хоть 50 тысяч символов.
const maxShopDescription = 1000

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
	if code, msg := validateSlug(req.Slug); code != "" {
		apiError(w, http.StatusBadRequest, code, msg)
		return
	}
	if !a.checkSlugReservation(w, r, req.Slug, uuid.Nil) {
		return
	}
	if req.Name == "" || len([]rune(req.Name)) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_name", "name must be 1-200 characters")
		return
	}
	if len([]rune(req.Description)) > maxShopDescription {
		apiError(w, http.StatusBadRequest, "invalid_description",
			fmt.Sprintf("description must be at most %d characters", maxShopDescription))
		return
	}
	contacts := req.Contacts
	if len(contacts) == 0 {
		contacts = json.RawMessage(`{}`)
	}
	if code, msg := validateContacts(contacts); code != "" {
		apiError(w, http.StatusBadRequest, code, msg)
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
		if name == "" || len([]rune(name)) > 200 {
			apiError(w, http.StatusBadRequest, "invalid_name", "name must be 1-200 characters")
			return
		}
	}
	if req.Description != nil {
		if len([]rune(*req.Description)) > maxShopDescription {
			apiError(w, http.StatusBadRequest, "invalid_description",
				fmt.Sprintf("description must be at most %d characters", maxShopDescription))
			return
		}
		description = *req.Description
	}
	if req.Contacts != nil {
		if code, msg := validateContacts(*req.Contacts); code != "" {
			apiError(w, http.StatusBadRequest, code, msg)
			return
		}
		contacts = *req.Contacts
	}
	if req.Settings != nil {
		if msg := validateSettings(*req.Settings); msg != "" {
			apiError(w, http.StatusBadRequest, "invalid_settings", msg)
			return
		}
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
	if code, msg := validateSlug(slug); code != "" {
		apiError(w, http.StatusBadRequest, code, msg)
		return shop, false
	}
	if shop.SlugChangedAt.Valid {
		if next := shop.SlugChangedAt.Time.Add(slugChangeCooldown); time.Now().Before(next) {
			apiError(w, http.StatusConflict, "slug_change_too_soon",
				"адрес можно менять не чаще раза в полгода: следующая смена после "+next.Format("02.01.2006"))
			return shop, false
		}
	}

	if !a.checkSlugReservation(w, r, slug, shop.ID) {
		return shop, false
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
	// Прежний адрес держим за этим же магазином, новый — освобождаем
	// от возможной прежней брони.
	if err := a.Q.ReserveReleasedSlug(r.Context(), db.ReserveReleasedSlugParams{
		Slug:   oldSlug,
		ShopID: shop.ID,
	}); err != nil {
		a.Log.Error("reserve released slug", "slug", oldSlug, "error", err)
	}
	if err := a.Q.DropSlugReservation(r.Context(), slug); err != nil {
		a.Log.Error("drop slug reservation", "slug", slug, "error", err)
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
