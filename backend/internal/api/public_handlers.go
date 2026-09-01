package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
)

// Публичные хендлеры витрины. Отдельные response-типы: наружу уходят только
// поля, нужные покупателю. Email, storage_used, план, статусы модерации,
// скрытые альбомы и не-ready фото не отдаются никогда.

const (
	publicPhotosPerPage    = 60
	publicPhotosPerPageMax = 100
	publicSearchLimit      = 50
	// visitorCookie — анонимный идентификатор покупателя для visitor_hash
	// (уникальные посетители, антифрод лидов). Имя знает и Next (/t).
	visitorCookie    = "kv"
	visitorCookieTTL = 365 * 24 * time.Hour
)

type publicShopResponse struct {
	ID          string          `json:"id"`
	Slug        string          `json:"slug"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Contacts    json.RawMessage `json:"contacts"`
	MsgTemplate string          `json:"msg_template"`
	ReplyTime   string          `json:"reply_time,omitempty"`
}

type publicAlbumResponse struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parent_id"`
	Title    string  `json:"title"`
	// Description отдаётся только на странице альбома: в сетке он не нужен,
	// а ответ витрины ISR кеширует целиком — незачем его раздувать.
	Description string            `json:"description,omitempty"`
	PhotoCount  int32             `json:"photo_count"`
	CoverUrls   map[string]string `json:"cover_urls,omitempty"`
}

type publicPhotoResponse struct {
	ID      string            `json:"id"`
	AlbumID string            `json:"album_id"`
	Caption string            `json:"caption"`
	Width   int32             `json:"width"`
	Height  int32             `json:"height"`
	Urls    map[string]string `json:"urls"`
}

// mediaURLs — адреса деривативов. Префикс задаётся MEDIA_BASE_URL:
// относительный "/media" локально, отдельный CDN-домен в проде.
func (a *API) mediaURLs(shopID, photoID uuid.UUID) map[string]string {
	// Дефолт держим здесь, а не только в config.Load: API собирают и
	// напрямую (тесты), и пустой префикс дал бы битые адреса всех картинок
	// молча — ошибка вылезла бы только глазами на витрине.
	base := a.Cfg.MediaBaseURL
	if base == "" {
		base = "/media"
	}
	return map[string]string{
		"thumb":  fmt.Sprintf("%s/%s/%s/300.webp", base, shopID, photoID),
		"medium": fmt.Sprintf("%s/%s/%s/800.webp", base, shopID, photoID),
		"large":  fmt.Sprintf("%s/%s/%s/1600.webp", base, shopID, photoID),
	}
}

func toPublicShopResponse(s db.Shop) publicShopResponse {
	// Из settings наружу уходит ТОЛЬКО то, что рисует витрина: шаблон
	// сообщения и время ответа. Остальное — внутренние настройки продавца.
	var settings struct {
		MsgTemplate string `json:"msg_template"`
		ReplyTime   string `json:"reply_time"`
	}
	_ = json.Unmarshal(s.Settings, &settings)
	return publicShopResponse{
		ID:          s.ID.String(),
		Slug:        s.Slug,
		Name:        s.Name,
		Description: s.Description,
		Contacts:    json.RawMessage(s.Contacts),
		MsgTemplate: settings.MsgTemplate,
		ReplyTime:   settings.ReplyTime,
	}
}

func (a *API) toPublicPhotoResponse(p db.Photo) publicPhotoResponse {
	return publicPhotoResponse{
		ID:      p.ID.String(),
		AlbumID: p.AlbumID.String(),
		Caption: p.Caption,
		Width:   p.Width,
		Height:  p.Height,
		Urls:    a.mediaURLs(p.ShopID, p.ID),
	}
}

// publicShopFromURL: активный магазин по slug.
//
// Витрину, скрытую за неоплату, отличаем от несуществующей: покупателю
// уходит 410 с именем и контактами продавца, чтобы он всё равно мог
// написать (kit: unavailable). 404 здесь означал бы «такого магазина нет»
// и обрывал бы связь с продавцом ровно тогда, когда она ему нужнее всего.
func (a *API) publicShopFromURL(w http.ResponseWriter, r *http.Request) (db.Shop, bool) {
	shop, err := a.Q.GetShopBySlugAny(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return db.Shop{}, false
	}
	if err != nil {
		a.internalError(w, "load public shop", err)
		return db.Shop{}, false
	}
	// Заблокированный модератором или удалённый магазин наружу не отличается
	// от несуществующего: причину блокировки покупателю знать незачем.
	if shop.Status != db.ShopStatusActive {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return db.Shop{}, false
	}
	if shop.BillingState == db.BillingStateSuspended {
		writeJSON(w, http.StatusGone, map[string]any{
			"error":   "shop_unavailable",
			"message": "shop is temporarily unavailable",
			"shop": map[string]any{
				"name":     shop.Name,
				"contacts": json.RawMessage(shop.Contacts),
			},
		})
		return db.Shop{}, false
	}
	return shop, true
}

// handlePublicShop — шапка магазина + сетка не скрытых альбомов.
func (a *API) handlePublicShop(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	albums, err := a.Q.ListPublicAlbums(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "list public albums", err)
		return
	}
	firstPhotos, err := a.Q.ListFirstReadyPhotos(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "list first photos", err)
		return
	}
	fallbackCover := make(map[uuid.UUID]uuid.UUID, len(firstPhotos))
	for _, fp := range firstPhotos {
		fallbackCover[fp.AlbumID] = fp.ID
	}

	out := make([]publicAlbumResponse, 0, len(albums))
	for _, al := range albums {
		resp := publicAlbumResponse{
			ID:         al.ID.String(),
			Title:      al.Title,
			PhotoCount: al.PhotoCount,
		}
		if al.ParentID.Valid {
			s := al.ParentID.UUID.String()
			resp.ParentID = &s
		}
		cover := al.CoverID.UUID
		if !al.CoverID.Valid {
			cover = fallbackCover[al.ID]
		}
		if cover != uuid.Nil {
			resp.CoverUrls = a.mediaURLs(shop.ID, cover)
		}
		out = append(out, resp)
	}
	// Вкладки — навигация витрины, нужна на каждой её странице; отдаём
	// вместе с магазином, чтобы не гонять второй запрос. Секции «Главной»
	// тоже здесь: если их нет, витрина показывает альбомы по дате (kit).
	tabs, err := a.Q.ListTabsByShop(r.Context(), shop.ID)
	if err != nil {
		a.internalError(w, "list tabs", err)
		return
	}
	navTabs := make([]publicTabResponse, 0, len(tabs))
	for _, t := range tabs {
		navTabs = append(navTabs, publicTabResponse{Title: t.Title, Slug: t.Slug})
	}
	sections, err := a.publicSections(r, shop.ID, "home")
	if err != nil {
		a.internalError(w, "list home sections", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"shop":     toPublicShopResponse(shop),
		"albums":   out,
		"tabs":     navTabs,
		"sections": sections,
	})
}

// handlePublicAlbum — фото альбома (только ready) с пагинацией.
func (a *API) handlePublicAlbum(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	albumID, err := uuid.Parse(chi.URLParam(r, "albumID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	album, err := a.Q.GetPublicAlbum(r.Context(), db.GetPublicAlbumParams{
		ID:     albumID,
		ShopID: shop.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	if err != nil {
		a.internalError(w, "load public album", err)
		return
	}

	page := queryInt(r, "page", 1, 1, 1_000_000)
	perPage := queryInt(r, "per_page", publicPhotosPerPage, 1, publicPhotosPerPageMax)

	photos, err := a.Q.ListPublicPhotos(r.Context(), db.ListPublicPhotosParams{
		AlbumID: album.ID,
		Limit:   int32(perPage),
		Offset:  int32((page - 1) * perPage),
	})
	if err != nil {
		a.internalError(w, "list public photos", err)
		return
	}
	total, err := a.Q.CountPublicPhotos(r.Context(), album.ID)
	if err != nil {
		a.internalError(w, "count public photos", err)
		return
	}

	outPhotos := make([]publicPhotoResponse, 0, len(photos))
	for _, p := range photos {
		outPhotos = append(outPhotos, a.toPublicPhotoResponse(p))
	}
	albumOut := publicAlbumResponse{
		ID:          album.ID.String(),
		Title:       album.Title,
		Description: album.Description,
		PhotoCount:  album.PhotoCount,
	}
	if album.ParentID.Valid {
		s := album.ParentID.UUID.String()
		albumOut.ParentID = &s
	}
	// Подальбомы: покупатель приходит по прямой ссылке на родительскую
	// категорию, и без них видит пустую страницу — вложенные альбомы
	// показывались только на главной магазина.
	children, err := a.Q.ListPublicChildAlbums(r.Context(), uuid.NullUUID{UUID: album.ID, Valid: true})
	if err != nil {
		a.internalError(w, "list child albums", err)
		return
	}
	outChildren := make([]publicAlbumResponse, 0, len(children))
	for _, ch := range children {
		child := publicAlbumResponse{
			ID:         ch.ID.String(),
			Title:      ch.Title,
			PhotoCount: ch.PhotoCount,
		}
		cover := ch.CoverID.UUID
		if !ch.CoverID.Valid {
			cover = a.firstReadyPhoto(r, ch.ID)
		}
		if cover != uuid.Nil {
			child.CoverUrls = a.mediaURLs(shop.ID, cover)
		}
		outChildren = append(outChildren, child)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"shop":     toPublicShopResponse(shop),
		"album":    albumOut,
		"children": outChildren,
		"photos":   outPhotos,
		"page":     page,
		"per_page": perPage,
		"total":    total,
	})
}

// firstReadyPhoto — обложка по умолчанию: первое готовое фото альбома.
// Подальбомов у одного альбома единицы, поэтому запрос на каждый дешевле
// отдельной выборки по всему магазину.
func (a *API) firstReadyPhoto(r *http.Request, albumID uuid.UUID) uuid.UUID {
	photos, err := a.Q.ListPublicPhotos(r.Context(), db.ListPublicPhotosParams{
		AlbumID: albumID,
		Limit:   1,
		Offset:  0,
	})
	if err != nil || len(photos) == 0 {
		a.Log.Debug("no cover for child album", "album_id", albumID)
		return uuid.Nil
	}
	return photos[0].ID
}

// handlePublicSearch — поиск по подписям в рамках магазина:
// FTS (russian), при пустом результате — pg_trgm fallback (опечатки).
func (a *API) handlePublicSearch(w http.ResponseWriter, r *http.Request) {
	shop, ok := a.publicShopFromURL(w, r)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 100 {
		apiError(w, http.StatusBadRequest, "invalid_query", "q must be 1-100 characters")
		return
	}

	ftsRows, err := a.Q.SearchPhotosFTS(r.Context(), db.SearchPhotosFTSParams{
		ShopID:             shop.ID,
		WebsearchToTsquery: q,
		Limit:              publicSearchLimit,
	})
	if err != nil {
		a.internalError(w, "search photos fts", err)
		return
	}
	photos := make([]publicPhotoResponse, 0, len(ftsRows))
	for _, row := range ftsRows {
		photos = append(photos, a.toPublicPhotoResponse(searchRowToPhoto(row.ID, row.AlbumID, row.ShopID, row.Caption, row.Width, row.Height)))
	}

	if len(photos) == 0 {
		trgmRows, err := a.Q.SearchPhotosTrgm(r.Context(), db.SearchPhotosTrgmParams{
			ShopID:         shop.ID,
			WordSimilarity: q,
			Limit:          publicSearchLimit,
		})
		if err != nil {
			a.internalError(w, "search photos trgm", err)
			return
		}
		for _, row := range trgmRows {
			photos = append(photos, a.toPublicPhotoResponse(searchRowToPhoto(row.ID, row.AlbumID, row.ShopID, row.Caption, row.Width, row.Height)))
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"query":  q,
		"photos": photos,
	})
}

// searchRowToPhoto собирает db.Photo из общих полей строк FTS/trgm-запросов
// (sqlc генерирует отдельные Row-типы из-за колонок rank/sim).
func searchRowToPhoto(id, albumID, shopID uuid.UUID, caption string, width, height int32) db.Photo {
	return db.Photo{
		ID:      id,
		AlbumID: albumID,
		ShopID:  shopID,
		Caption: caption,
		Width:   width,
		Height:  height,
	}
}

type leadClickRequest struct {
	ShopID  string `json:"shop_id"`
	PhotoID string `json:"photo_id,omitempty"`
	Channel string `json:"channel"`
}

var leadChannels = map[string]db.LeadChannel{
	"telegram": db.LeadChannelTelegram,
	"whatsapp": db.LeadChannelWhatsapp,
	"max":      db.LeadChannelMax,
	"vk":       db.LeadChannelVk,
}

// handleLeadClick фиксирует клик «написать по товару» в lead_clicks.
// visitor_hash = sha256(анонимная cookie + IP) — без PII в чистом виде.
func (a *API) handleLeadClick(w http.ResponseWriter, r *http.Request) {
	var req leadClickRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	channel, ok := leadChannels[req.Channel]
	if !ok {
		apiError(w, http.StatusBadRequest, "invalid_channel", "channel must be one of: telegram, whatsapp, max, vk")
		return
	}
	shopID, err := uuid.Parse(req.ShopID)
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return
	}
	shop, err := a.Q.GetActiveShopByID(r.Context(), shopID)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return
	}
	if err != nil {
		a.internalError(w, "load shop for lead", err)
		return
	}

	var photoID uuid.NullUUID
	if req.PhotoID != "" {
		pid, err := uuid.Parse(req.PhotoID)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_photo_id", "invalid photo_id")
			return
		}
		// Чужое/несуществующее фото не валит запрос: лид важнее точности.
		if p, err := a.Q.GetPhotoForShop(r.Context(), db.GetPhotoForShopParams{
			ID:     pid,
			ShopID: shop.ID,
		}); err == nil {
			photoID = uuid.NullUUID{UUID: p.ID, Valid: true}
		}
	}

	if err := a.Q.CreateLeadClick(r.Context(), db.CreateLeadClickParams{
		ShopID:      shop.ID,
		PhotoID:     photoID,
		Channel:     channel,
		VisitorHash: a.visitorHash(w, r),
	}); err != nil {
		a.internalError(w, "create lead click", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// visitorHash возвращает sha256(visitor cookie + IP); при отсутствии cookie
// устанавливает новую (httpOnly, год).
func (a *API) visitorHash(w http.ResponseWriter, r *http.Request) string {
	var visitorID string
	if c, err := r.Cookie(visitorCookie); err == nil && c.Value != "" {
		visitorID = c.Value
	} else {
		buf := make([]byte, 16)
		_, _ = rand.Read(buf)
		visitorID = hex.EncodeToString(buf)
		http.SetCookie(w, &http.Cookie{
			Name:     visitorCookie,
			Value:    visitorID,
			Path:     "/",
			MaxAge:   int(visitorCookieTTL.Seconds()),
			HttpOnly: true,
			Secure:   a.Cfg.CookieSecure,
			SameSite: http.SameSiteLaxMode,
		})
	}
	sum := sha256.Sum256([]byte(visitorID + "|" + clientIP(r)))
	return hex.EncodeToString(sum[:16])
}

// handlePublicSitemap — активные магазины для sitemap витрины.
func (a *API) handlePublicSitemap(w http.ResponseWriter, r *http.Request) {
	rows, err := a.Q.ListActiveShopSlugs(r.Context())
	if err != nil {
		a.internalError(w, "list shop slugs", err)
		return
	}
	type entry struct {
		Slug      string    `json:"slug"`
		UpdatedAt time.Time `json:"updated_at"`
	}
	out := make([]entry, 0, len(rows))
	for _, row := range rows {
		out = append(out, entry{Slug: row.Slug, UpdatedAt: row.UpdatedAt.Time})
	}
	writeJSON(w, http.StatusOK, map[string]any{"shops": out})
}

// queryInt парсит числовой query-параметр с дефолтом и границами.
func queryInt(r *http.Request, name string, def, minV, maxV int) int {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < minV {
		return def
	}
	if n > maxV {
		return maxV
	}
	return n
}
