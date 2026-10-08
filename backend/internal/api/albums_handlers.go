package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/db"
	"katalog/backend/internal/imagingmeta"
)

type albumResponse struct {
	ID           string  `json:"id"`
	ParentID     *string `json:"parent_id"`
	Title        string  `json:"title"`
	CoverPhotoID *string `json:"cover_photo_id"`
	SortOrder    int32   `json:"sort_order"`
	Status       string  `json:"status"`
	Description  string  `json:"description"`
	CategoryID   *string `json:"category_id"`
	// CategoryIDs — все категории альбома; category_id — первая из них.
	CategoryIDs []string `json:"category_ids"`
	// CategoryPos — место альбома в каждой из его категорий (id категории →
	// номер): у категории свой порядок альбомов, он же порядок на витрине.
	CategoryPos        map[string]int32 `json:"category_pos,omitempty"`
	PhotoCount         int32            `json:"photo_count"`
	BlockedByModerator bool             `json:"blocked_by_moderator"`
	// HasPassword — альбом закрыт паролем. Сам пароль и его хеш наружу
	// не отдаются: продавец задаёт новый, а не читает старый.
	HasPassword bool `json:"has_password"`
	// CoverUrls — адреса деривативов обложки. Кабинет рисует сетку
	// альбомов превью, а базовый префикс медиа знает только сервер
	// (локально «/media», в проде домен CDN).
	CoverUrls map[string]string `json:"cover_urls,omitempty"`
	// Watermark — свой знак альбома; null — как у магазина.
	Watermark *albumWatermark `json:"watermark"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
}

// albumWatermark — знак альбома (макет 11–13): включён ли и где. Текст
// знака общий для магазина.
type albumWatermark struct {
	Enabled  bool   `json:"enabled"`
	Position string `json:"position"`
}

// parseAlbumWatermark разбирает поле watermark запроса: null — снять своё
// и вернуться к знаку магазина. ok=false — ответ уже отправлен.
func parseAlbumWatermark(w http.ResponseWriter, raw json.RawMessage) (value []byte, ok bool) {
	if string(raw) == "null" {
		return nil, true
	}
	var wm albumWatermark
	if err := json.Unmarshal(raw, &wm); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_watermark", "watermark must be null or {enabled, position}")
		return nil, false
	}
	if wm.Position == "" {
		wm.Position = "br"
	}
	if !imagingmeta.ValidWatermarkPosition(wm.Position) {
		apiError(w, http.StatusBadRequest, "invalid_watermark",
			"watermark.position must be one of "+strings.Join(imagingmeta.WatermarkPositions, ", "))
		return nil, false
	}
	value, _ = json.Marshal(wm)
	return value, true
}

func (a *API) toAlbumResponse(al db.Album) albumResponse {
	resp := albumResponse{
		ID:          al.ID.String(),
		Title:       al.Title,
		SortOrder:   al.SortOrder,
		Status:      string(al.Status),
		Description: al.Description,
		PhotoCount:  al.PhotoCount,
		// Блокировка модератором — только на чтение: продавец должен
		// понимать, почему альбома нет на витрине, но снять её не может.
		BlockedByModerator: al.BlockedByModerator,
		HasPassword:        al.PasswordHash != nil,
		CategoryIDs:        []string{},
	}
	if len(al.Watermark) > 0 {
		var wm albumWatermark
		if json.Unmarshal(al.Watermark, &wm) == nil {
			resp.Watermark = &wm
		}
	}
	if al.CreatedAt.Valid {
		resp.CreatedAt = al.CreatedAt.Time.Format(time.RFC3339)
	}
	if al.UpdatedAt.Valid {
		resp.UpdatedAt = al.UpdatedAt.Time.Format(time.RFC3339)
	}
	if al.ParentID.Valid {
		s := al.ParentID.UUID.String()
		resp.ParentID = &s
	}
	if al.CoverPhotoID.Valid {
		s := al.CoverPhotoID.UUID.String()
		resp.CoverPhotoID = &s
		resp.CoverUrls = a.mediaURLs(al.ShopID, al.CoverPhotoID.UUID)
	}
	// Полный список категорий подставляет listAlbums; в ответах по одному
	// альбому здесь хотя бы первая, чтобы поле не расходилось с category_id.
	if al.CategoryID.Valid {
		resp.CategoryIDs = []string{al.CategoryID.UUID.String()}
	}
	if al.CategoryID.Valid {
		s := al.CategoryID.UUID.String()
		resp.CategoryID = &s
	}
	return resp
}

// albumFromURL загружает альбом с проверкой принадлежности магазину
// (магазин уже проверен requireShop). Чужой альбом — 404.
func (a *API) albumFromURL(w http.ResponseWriter, r *http.Request) (db.Album, bool) {
	albumID, err := uuid.Parse(chi.URLParam(r, "albumID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return db.Album{}, false
	}
	album, err := a.Q.GetAlbumForShop(r.Context(), db.GetAlbumForShopParams{
		ID:     albumID,
		ShopID: shopFromCtx(r).ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return db.Album{}, false
	}
	if err != nil {
		a.internalError(w, "load album", err)
		return db.Album{}, false
	}
	return album, true
}

// maxAlbumsPerShop — см. handleCreateAlbum; то же число стоит потолком
// в ListPublicAlbums, чтобы честный каталог не обрезался на витрине.
const maxAlbumsPerShop = 1000

type createAlbumRequest struct {
	Title     string  `json:"title"`
	ParentID  *string `json:"parent_id"`
	SortOrder int32   `json:"sort_order"`
	// Watermark — свой знак альбома (необязательно; см. albumWatermark).
	Watermark json.RawMessage `json:"watermark"`
}

func (a *API) handleCreateAlbum(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	var req createAlbumRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len([]rune(req.Title)) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-200 characters")
		return
	}

	// Число альбомов тарифом не ограничено, а страница магазина отдаёт их
	// все и на каждый заход покупателя. Потолок держит горячий путь
	// предсказуемым; тысяча — заведомо больше любого живого каталога.
	parentID, ok := a.resolveAlbumParent(w, r, req.ParentID, uuid.Nil)
	if !ok {
		return
	}
	// Знак разбираем до вставки: иначе на 400 альбом всё равно оставался.
	var wmValue []byte
	if len(req.Watermark) > 0 {
		if wmValue, ok = parseAlbumWatermark(w, req.Watermark); !ok {
			return
		}
	}

	// Подсчёт и вставка — под замком магазина: иначе параллельная пачка у
	// самого потолка проходила проверку целиком и превышала его.
	var album db.Album
	overLimit := false
	err := a.inOrderLock(r.Context(), shop.ID, func(q *db.Queries) error {
		count, err := q.CountAlbumsByShop(r.Context(), shop.ID)
		if err != nil {
			return fmt.Errorf("count albums: %w", err)
		}
		if count >= maxAlbumsPerShop {
			overLimit = true
			return nil
		}
		album, err = q.CreateAlbum(r.Context(), db.CreateAlbumParams{
			ShopID:    shop.ID,
			ParentID:  parentID,
			Title:     req.Title,
			SortOrder: req.SortOrder,
		})
		if err != nil {
			return fmt.Errorf("create album: %w", err)
		}
		if wmValue != nil {
			if album, err = q.SetAlbumWatermark(r.Context(), db.SetAlbumWatermarkParams{
				ID: album.ID, ShopID: shop.ID, Watermark: wmValue,
			}); err != nil {
				return fmt.Errorf("set album watermark: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		a.internalError(w, "create album", err)
		return
	}
	if overLimit {
		apiError(w, http.StatusConflict, "album_limit",
			fmt.Sprintf("shop holds at most %d albums", maxAlbumsPerShop))
		return
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusCreated, a.toAlbumResponse(album))
}

func (a *API) handleListAlbums(w http.ResponseWriter, r *http.Request) {
	shopID := shopFromCtx(r).ID
	albums, err := a.Q.ListAlbumsByShop(r.Context(), shopID)
	if err != nil {
		a.internalError(w, "list albums", err)
		return
	}
	// Обложка по умолчанию — первое готовое фото альбома, ровно как на
	// витрине (handleListPublicAlbums). Без этого сетка в кабинете стояла
	// в заглушках у всех альбомов, где продавец не выбрал обложку руками,
	// хотя покупатель на тех же альбомах видел картинки.
	firstPhotos, err := a.Q.ListFirstReadyPhotos(r.Context(), shopID)
	if err != nil {
		a.internalError(w, "list first photos", err)
		return
	}
	fallbackCover := make(map[uuid.UUID]uuid.UUID, len(firstPhotos))
	for _, fp := range firstPhotos {
		fallbackCover[fp.AlbumID] = fp.ID
	}

	pairs, err := a.Q.ListAlbumCategoryPairs(r.Context(), shopID)
	if err != nil {
		a.internalError(w, "list album categories", err)
		return
	}
	categoriesOf := make(map[uuid.UUID][]string, len(pairs))
	posOf := make(map[uuid.UUID]map[string]int32, len(pairs))
	for _, p := range pairs {
		categoriesOf[p.AlbumID] = append(categoriesOf[p.AlbumID], p.CategoryID.String())
		if posOf[p.AlbumID] == nil {
			posOf[p.AlbumID] = map[string]int32{}
		}
		posOf[p.AlbumID][p.CategoryID.String()] = p.SortOrder
	}

	out := make([]albumResponse, 0, len(albums))
	for _, al := range albums {
		resp := a.toAlbumResponse(al)
		if ids := categoriesOf[al.ID]; ids != nil {
			resp.CategoryIDs = ids
			resp.CategoryPos = posOf[al.ID]
		}
		if resp.CoverUrls == nil {
			if pid, ok := fallbackCover[al.ID]; ok {
				resp.CoverUrls = a.mediaURLs(shopID, pid)
			}
		}
		out = append(out, resp)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleGetAlbum(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, a.toAlbumResponse(album))
}

type updateAlbumRequest struct {
	Title        *string `json:"title"`
	SortOrder    *int32  `json:"sort_order"`
	Status       *string `json:"status"`
	Description  *string `json:"description"`
	CoverPhotoID *string `json:"cover_photo_id"`
	// ParentID: пустая строка выносит альбом на верхний уровень.
	// Раньше вложенность задавалась только при создании — переложить
	// альбом можно было лишь удалив его вместе с фотографиями.
	ParentID *string `json:"parent_id"`
	// Password: непустая строка задаёт пароль, пустая — снимает.
	Password *string `json:"password"`
	// Watermark: {enabled, position} — свой знак альбома, null — как у магазина.
	Watermark json.RawMessage `json:"watermark"`
}

// Пароль альбома покупатель набирает с телефона, поэтому короткий
// допустим; длинный ограничен, чтобы хеширование не стало способом
// нагрузить сервер.
const (
	minAlbumPassword = 4
	maxAlbumPassword = 64
)

// resolveAlbumParent разбирает parent_id. self — id альбома, который правим
// (uuid.Nil при создании): он не может стать сам себе родителем, и альбом
// с подальбомами не может уехать на второй уровень — его дети окажутся
// на третьем, а уровней два.
func (a *API) resolveAlbumParent(
	w http.ResponseWriter, r *http.Request, raw *string, self uuid.UUID,
) (uuid.NullUUID, bool) {
	if raw == nil || *raw == "" {
		return uuid.NullUUID{}, true
	}
	shop := shopFromCtx(r)
	pid, err := uuid.Parse(*raw)
	if err != nil {
		apiError(w, http.StatusBadRequest, "invalid_parent", "invalid parent_id")
		return uuid.NullUUID{}, false
	}
	if self != uuid.Nil && pid == self {
		apiError(w, http.StatusBadRequest, "invalid_parent", "album cannot be its own parent")
		return uuid.NullUUID{}, false
	}
	parent, err := a.Q.GetAlbumForShop(r.Context(), db.GetAlbumForShopParams{
		ID:     pid,
		ShopID: shop.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "parent album not found")
		return uuid.NullUUID{}, false
	}
	if err != nil {
		a.internalError(w, "load parent album", err)
		return uuid.NullUUID{}, false
	}
	// Максимум 2 уровня: родитель сам не может быть вложенным.
	if parent.ParentID.Valid {
		apiError(w, http.StatusBadRequest, "too_deep", "albums can be nested at most 2 levels")
		return uuid.NullUUID{}, false
	}
	if self != uuid.Nil {
		children, err := a.Q.CountAlbumChildren(r.Context(), uuid.NullUUID{UUID: self, Valid: true})
		if err != nil {
			a.internalError(w, "count album children", err)
			return uuid.NullUUID{}, false
		}
		if children > 0 {
			apiError(w, http.StatusBadRequest, "too_deep",
				"album has sub-albums and cannot itself be nested")
			return uuid.NullUUID{}, false
		}
	}
	return uuid.NullUUID{UUID: pid, Valid: true}, true
}

func (a *API) handleUpdateAlbum(w http.ResponseWriter, r *http.Request) {
	shop := shopFromCtx(r)
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	var req updateAlbumRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	title, sortOrder, status, cover := album.Title, album.SortOrder, album.Status, album.CoverPhotoID
	description := album.Description
	if req.Title != nil {
		title = strings.TrimSpace(*req.Title)
		if title == "" || len([]rune(title)) > 200 {
			apiError(w, http.StatusBadRequest, "invalid_title", "title must be 1-200 characters")
			return
		}
	}
	if req.SortOrder != nil {
		sortOrder = *req.SortOrder
	}
	if req.Status != nil {
		switch db.AlbumStatus(*req.Status) {
		case db.AlbumStatusPublished, db.AlbumStatusUnlisted, db.AlbumStatusDraft:
			status = db.AlbumStatus(*req.Status)
		default:
			apiError(w, http.StatusBadRequest, "invalid_status", "status must be published, unlisted or draft")
			return
		}
	}
	if req.Description != nil {
		// Описание длинное по назначению: там условия отправки и оплаты.
		// Ограничиваем разумной длиной, чтобы не превратить его в статью.
		if len([]rune(*req.Description)) > 2000 {
			apiError(w, http.StatusBadRequest, "invalid_description", "description must be at most 2000 characters")
			return
		}
		description = *req.Description
	}
	if req.CoverPhotoID != nil {
		if *req.CoverPhotoID == "" {
			cover = uuid.NullUUID{}
		} else {
			pid, err := uuid.Parse(*req.CoverPhotoID)
			if err != nil {
				apiError(w, http.StatusBadRequest, "invalid_cover", "invalid cover_photo_id")
				return
			}
			photo, err := a.Q.GetPhotoForShop(r.Context(), db.GetPhotoForShopParams{
				ID:     pid,
				ShopID: shop.ID,
			})
			if errors.Is(err, pgx.ErrNoRows) {
				apiError(w, http.StatusNotFound, "not_found", "cover photo not found")
				return
			}
			if err != nil {
				a.internalError(w, "load cover photo", err)
				return
			}
			if photo.AlbumID != album.ID {
				apiError(w, http.StatusBadRequest, "invalid_cover", "cover photo must belong to this album")
				return
			}
			// Обложкой может быть только живое фото: ready или ещё в обработке
			// (окно «Новый альбом» назначает обложку сразу после загрузки).
			// Упавшее, недогруженное, заблокированное или удалённое принималось —
			// у такого нет деривативов, и обложка альбома была пустой.
			if photo.DeletedAt.Valid || (photo.Status != db.PhotoStatusReady && photo.Status != db.PhotoStatusProcessing) {
				apiError(w, http.StatusBadRequest, "invalid_cover", "cover photo must be an uploaded photo")
				return
			}
			cover = uuid.NullUUID{UUID: pid, Valid: true}
		}
	}

	parentID := album.ParentID
	if req.ParentID != nil {
		var ok bool
		parentID, ok = a.resolveAlbumParent(w, r, req.ParentID, album.ID)
		if !ok {
			return
		}
	}

	// Пароль проверяем до записи остальных полей: отказ не должен оставить
	// альбом наполовину изменённым.
	var newHash *string
	// На бесплатном тарифе пароль не задать, не сменить и не снять (макет:
	// «На бесплатном тарифе изменить или снять его нельзя»). Пароль,
	// поставленный на платном, при понижении тарифа продолжает действовать.
	// Снятие пароля, которого и так нет, — не изменение, его пропускаем.
	if req.Password != nil && shop.Plan == db.ShopPlanFree && (*req.Password != "" || album.PasswordHash != nil) {
		apiError(w, http.StatusForbidden, "password_plan_required",
			"album passwords are not available on the free plan")
		return
	}
	if req.Password != nil && *req.Password != "" {
		n := len([]rune(*req.Password))
		if n < minAlbumPassword || n > maxAlbumPassword {
			apiError(w, http.StatusBadRequest, "invalid_password",
				fmt.Sprintf("password must be %d-%d characters", minAlbumPassword, maxAlbumPassword))
			return
		}
		hash, err := auth.HashPassword(*req.Password)
		if err != nil {
			a.internalError(w, "hash album password", err)
			return
		}
		newHash = &hash
	}
	// Знак — тоже до записи: на 400 название и статус уже успевали смениться.
	var wmValue []byte
	if len(req.Watermark) > 0 {
		var ok bool
		if wmValue, ok = parseAlbumWatermark(w, req.Watermark); !ok {
			return
		}
	}

	updated, err := a.Q.UpdateAlbum(r.Context(), db.UpdateAlbumParams{
		ID:           album.ID,
		ShopID:       shop.ID,
		ParentID:     parentID,
		Title:        title,
		SortOrder:    sortOrder,
		Status:       status,
		CoverPhotoID: cover,
		Description:  description,
	})
	if err != nil {
		a.internalError(w, "update album", err)
		return
	}
	if len(req.Watermark) > 0 {
		// wmValue == nil — «null»: снять свой знак.
		if updated, err = a.Q.SetAlbumWatermark(r.Context(), db.SetAlbumWatermarkParams{
			ID: album.ID, ShopID: shop.ID, Watermark: wmValue,
		}); err != nil {
			a.internalError(w, "set album watermark", err)
			return
		}
	}
	if req.Password != nil {
		updated, err = a.Q.SetAlbumPassword(r.Context(), db.SetAlbumPasswordParams{
			ID:           album.ID,
			ShopID:       shop.ID,
			PasswordHash: newHash,
		})
		if err != nil {
			a.internalError(w, "set album password", err)
			return
		}
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, a.toAlbumResponse(updated))
}

func (a *API) handleDeleteAlbum(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	shop := shopFromCtx(r)

	// Удаление обратимо: альбом с подальбомами и фотографиями уезжает в
	// «Удаленное». Объекты в S3 остаются, место в квоте не возвращаем —
	// вернёт его окончательное удаление, своё или ночное по сроку.
	// Метка времени одна на всё дерево: по ней восстановление отличает
	// фото, удалённые вместе с альбомом, от удалённых раньше.
	stamp := pgtype.Timestamptz{Time: time.Now().UTC().Truncate(time.Microsecond), Valid: true}
	tx, err := a.Pool.Begin(r.Context())
	if err != nil {
		a.internalError(w, "delete album: begin", err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := a.Q.WithTx(tx)
	n, err := q.SoftDeleteAlbumTree(r.Context(), db.SoftDeleteAlbumTreeParams{
		ID: album.ID, ShopID: shop.ID, DeletedAt: stamp,
	})
	if err != nil {
		a.internalError(w, "delete album", err)
		return
	}
	if n == 0 {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	if _, err := q.SoftDeleteAlbumTreePhotos(r.Context(), db.SoftDeleteAlbumTreePhotosParams{
		ID: album.ID, ShopID: shop.ID, DeletedAt: stamp,
	}); err != nil {
		a.internalError(w, "delete album photos", err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		a.internalError(w, "delete album: commit", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}
