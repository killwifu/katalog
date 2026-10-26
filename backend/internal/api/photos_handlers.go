package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/db"
	"katalog/backend/internal/imagingmeta"
	"katalog/backend/internal/storage"
	"katalog/backend/internal/tasks"
)

const (
	// 10 МБ на файл — предел из макета кабинета («до 10 МБ на одно фото»).
	// Снимок с телефона в него укладывается, а всё крупнее — почти всегда
	// не фотография товара, а исходник из редактора.
	maxFileSize = 10 << 20
	presignTTL  = 15 * time.Minute
)

type photoResponse struct {
	ID         string            `json:"id"`
	AlbumID    string            `json:"album_id"`
	Caption    string            `json:"caption"`
	Status     string            `json:"status"`
	Width      int32             `json:"width"`
	Height     int32             `json:"height"`
	SortOrder  int32             `json:"sort_order"`
	Urls       map[string]string `json:"urls,omitempty"`
	FailReason string            `json:"fail_reason,omitempty"`
}

func (a *API) toPhotoResponse(p db.Photo, rev int32) photoResponse {
	resp := photoResponse{
		ID:        p.ID.String(),
		AlbumID:   p.AlbumID.String(),
		Caption:   p.Caption,
		Status:    string(p.Status),
		Width:     p.Width,
		Height:    p.Height,
		SortOrder: p.SortOrder,
	}
	if p.Status == db.PhotoStatusReady {
		resp.Urls = a.mediaURLs(rev, p.ShopID, p.ID)
	}
	// Причина провала — только продавцу и только для его фото: по ней он
	// понимает, что чинить, вместо одинакового «ошибка файла» на всю пачку.
	if p.Status == db.PhotoStatusFailed {
		resp.FailReason = p.FailReason
	}
	return resp
}

type presignRequest struct {
	ShopID  string `json:"shop_id"`
	AlbumID string `json:"album_id"`
	Size    int64  `json:"size"`
}

type presignResponse struct {
	PhotoID string `json:"photo_id"`
	URL     string `json:"url"`
}

// handlePresign: проверка владения и квоты плана -> запись photo(uploading) ->
// pre-signed PUT. Клиент грузит НАПРЯМУЮ в S3, не через API.
func (a *API) handlePresign(w http.ResponseWriter, r *http.Request) {
	var req presignRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	shop, ok := a.ownedShop(w, r, req.ShopID)
	if !ok {
		return
	}
	albumID, err := uuid.Parse(req.AlbumID)
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "album not found")
		return
	}
	if _, err := a.Q.GetAlbumForShop(r.Context(), db.GetAlbumForShopParams{
		ID:     albumID,
		ShopID: shop.ID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "album not found")
			return
		}
		a.internalError(w, "load album", err)
		return
	}
	if req.Size <= 0 || req.Size > maxFileSize {
		apiError(w, http.StatusBadRequest, "invalid_size", fmt.Sprintf("size must be 1..%d bytes", maxFileSize))
		return
	}
	// Блокировка модератором: витрина скрыта, но загрузка продолжала
	// работать — магазин, снятый по жалобе, спокойно набирал новый
	// контент, и тот уехал бы на витрину при снятии блокировки.
	if shop.Status == db.ShopStatusSuspended {
		apiError(w, http.StatusForbidden, "shop_suspended",
			"shop is suspended by moderation: uploads are disabled")
		return
	}
	// Мягкий отказ по подписке: в grace/suspended загрузка заблокирована,
	// контент и витрина (в grace) продолжают работать.
	if shop.BillingState != db.BillingStateOk {
		apiError(w, http.StatusForbidden, "subscription_inactive",
			"subscription is inactive: uploads are disabled until the plan is renewed")
		return
	}
	limits := a.Cfg.Billing.Limits(string(shop.Plan))
	if shop.StorageUsed+req.Size > limits.MaxStorage {
		apiError(w, http.StatusForbidden, "quota_exceeded",
			"storage quota exceeded for current plan, upgrade your plan")
		return
	}

	// Счёт и вставка — под блокировкой на магазин. Иначе параллельные
	// presign читают одно и то же значение счётчика и проходят все:
	// десять одновременных запросов на 499/500 давали 509 фотографий,
	// а скриптом перебор не ограничен ничем.
	photo, err := a.createPhotoWithinQuota(r, shop, albumID, limits.MaxPhotos)
	if errors.Is(err, errPhotoQuota) {
		apiError(w, http.StatusForbidden, "photo_quota_exceeded",
			fmt.Sprintf("plan photo limit reached (%d photos), upgrade your plan", limits.MaxPhotos))
		return
	}
	if err != nil {
		a.internalError(w, "create photo", err)
		return
	}
	url, err := a.Store.PresignPut(r.Context(), storage.OrigKey(shop.ID, photo.ID), presignTTL)
	if err != nil {
		a.internalError(w, "presign upload", err)
		return
	}
	writeJSON(w, http.StatusOK, presignResponse{PhotoID: photo.ID.String(), URL: url})
}

// errPhotoQuota — лимит фотографий тарифа исчерпан.
var errPhotoQuota = errors.New("photo quota exceeded")

// createPhotoWithinQuota считает фотографии и заводит новую в одной
// транзакции под блокировкой на магазин: проверка и вставка должны быть
// неделимы, иначе лимит обходится параллельными запросами. Блокировка
// транзакционная и на конкретный магазин — соседние продавцы не ждут.
func (a *API) createPhotoWithinQuota(
	r *http.Request, shop db.Shop, albumID uuid.UUID, maxPhotos int64,
) (db.Photo, error) {
	ctx := r.Context()
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return db.Photo{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := a.Q.WithTx(tx)

	if err := q.LockShopForUpload(ctx, shop.ID.String()); err != nil {
		return db.Photo{}, fmt.Errorf("lock shop: %w", err)
	}
	count, err := q.CountShopPhotos(ctx, shop.ID)
	if err != nil {
		return db.Photo{}, fmt.Errorf("count shop photos: %w", err)
	}
	if count >= maxPhotos {
		return db.Photo{}, errPhotoQuota
	}
	// orig_size — 0, а не заявленный размер: в storage_used байты попадают
	// только на confirm, по фактическому размеру. Инвариант — orig_size+drv_size
	// у строки ровно то, что за неё учтено в тарифе; иначе удаление фото,
	// не дошедшего до confirm, списывало из счётчика чужие байты.
	photo, err := q.CreatePhoto(ctx, db.CreatePhotoParams{
		AlbumID:   albumID,
		ShopID:    shop.ID,
		OrigSize:  0,
		Source:    db.PhotoSourceUpload,
		SortOrder: 0,
	})
	if err != nil {
		return db.Photo{}, fmt.Errorf("create photo: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.Photo{}, fmt.Errorf("commit tx: %w", err)
	}
	return photo, nil
}

type confirmRequest struct {
	ShopID   string   `json:"shop_id"`
	PhotoIDs []string `json:"photo_ids"`
}

type confirmResult struct {
	PhotoID string `json:"photo_id"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	// Code — машинный код отказа там, где кабинету нужно развести ответы:
	// «место кончилось» требует сменить тариф, а не грузить файл заново.
	Code string `json:"code,omitempty"`
}

// handleConfirmPhotos: photo uploading -> processing + задача в asynq.
func (a *API) handleConfirmPhotos(w http.ResponseWriter, r *http.Request) {
	var req confirmRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	shop, ok := a.ownedShop(w, r, req.ShopID)
	if !ok {
		return
	}
	if len(req.PhotoIDs) == 0 || len(req.PhotoIDs) > 200 {
		apiError(w, http.StatusBadRequest, "invalid_photo_ids", "photo_ids must contain 1..200 items")
		return
	}

	slots := &albumSlots{base: map[uuid.UUID]int32{}, placed: map[uuid.UUID]int32{}}
	results := make([]confirmResult, 0, len(req.PhotoIDs))
	for _, raw := range req.PhotoIDs {
		results = append(results, a.confirmOne(r, shop, raw, slots))
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// albumSlots раздаёт места новым фотографиям одной пачки подтверждения.
//
// Новые фото встают сразу после обложки (макет: «новые фото встают сразу
// после обложки»), а не в конец альбома: продавец догружает свежий товар
// и хочет видеть его первым. Внутри пачки порядок — как в запросе, то
// есть как продавец выбрал файлы.
//
// Место выдаётся каждому фото в его транзакции подтверждения под замком
// строки альбома, со сдвигом «освободить номер». Раньше пачка резервировала
// места разом, помнила их в памяти и сдвигала альбом вне транзакции —
// параллельные подтверждения (кабинет шлёт их пачками одновременно) читали
// одно состояние, и двенадцать фото получали одинаковые номера.
type albumSlots struct {
	// base — номер обложки на момент первого фото пачки (0 — альбом был пуст).
	base map[uuid.UUID]int32
	// placed — сколько фото пачки уже встало в альбом (после коммита).
	placed map[uuid.UUID]int32
}

// take отдаёт место для следующего фото пачки в альбоме и освобождает его
// сдвигом. Вызывается внутри транзакции подтверждения.
func (s *albumSlots) take(ctx context.Context, q *db.Queries, albumID uuid.UUID) (int32, error) {
	if err := q.LockAlbumForOrder(ctx, albumID); err != nil {
		return 0, fmt.Errorf("lock album: %w", err)
	}
	base, ok := s.base[albumID]
	if !ok {
		first, err := q.FirstAlbumSortOrder(ctx, albumID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			base = 0 // альбом пуст: первое фото пачки станет обложкой
		case err != nil:
			return 0, err
		default:
			base = first
		}
		s.base[albumID] = base
	}
	pos := base + 1 + s.placed[albumID]
	if err := q.ShiftAlbumPhotosFrom(ctx, db.ShiftAlbumPhotosFromParams{AlbumID: albumID, FromPos: pos}); err != nil {
		return 0, fmt.Errorf("shift album: %w", err)
	}
	return pos, nil
}

func (a *API) confirmOne(r *http.Request, shop db.Shop, rawID string, slots *albumSlots) confirmResult {
	photoID, err := uuid.Parse(rawID)
	if err != nil {
		return confirmResult{PhotoID: rawID, Status: "error", Error: "invalid photo id"}
	}
	res := confirmResult{PhotoID: rawID}

	photo, err := a.Q.GetPhotoForShop(r.Context(), db.GetPhotoForShopParams{
		ID:     photoID,
		ShopID: shop.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		res.Status, res.Error = "error", "photo not found"
		return res
	}
	if err != nil {
		a.Log.Error("confirm: load photo failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	if photo.Status != db.PhotoStatusUploading {
		// Повторный confirm — идемпотентно возвращаем текущий статус.
		res.Status = string(photo.Status)
		return res
	}

	size, exists, err := a.Store.StatSize(r.Context(), storage.OrigKey(shop.ID, photo.ID))
	if err != nil {
		a.Log.Error("confirm: stat object failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	if !exists {
		res.Status, res.Error = "error", "object not uploaded"
		return res
	}
	// Presigned PUT размер не ограничивает: presign проверял заявленный
	// размер, а залить можно любой. Воркер читает оригинал в память целиком —
	// гигабайтный «снимок» ронял бы его. Проверяем фактический размер.
	if size > maxFileSize {
		if err := a.Store.Delete(r.Context(), storage.OrigKey(shop.ID, photo.ID)); err != nil {
			a.Log.Error("confirm: delete oversized original failed", "photo_id", photo.ID, "error", err)
		}
		if err := a.Q.SetPhotoFailed(r.Context(), db.SetPhotoFailedParams{
			ID:         photo.ID,
			FailReason: imagingmeta.FailFileTooLarge,
		}); err != nil {
			a.Log.Error("confirm: mark oversized photo failed", "photo_id", photo.ID, "error", err)
		}
		res.Status, res.Error = "failed", fmt.Sprintf("file is larger than %d bytes", maxFileSize)
		res.Code = imagingmeta.FailFileTooLarge
		return res
	}

	// Перевод в processing и учёт байтов — одной транзакцией: если файл
	// не помещается в тариф, фотография остаётся в uploading, а объект
	// уберёт уборка зависших загрузок. Иначе байты уже посчитаны, а место
	// в тарифе кончилось — откатывать нечего.
	tx, err := a.Pool.Begin(r.Context())
	if err != nil {
		a.Log.Error("confirm: begin tx failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := a.Q.WithTx(tx)

	// Место в альбоме — сразу после обложки, в порядке, в каком клиент
	// перечислил фото: параллельная загрузка доезжает как придётся, поэтому
	// опираться на created_at нельзя.
	sortOrder, err := slots.take(r.Context(), q, photo.AlbumID)
	if err != nil {
		a.Log.Error("confirm: album slot failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	if _, err := q.SetPhotoProcessing(r.Context(), db.SetPhotoProcessingParams{
		ID:        photo.ID,
		OrigSize:  size,
		SortOrder: sortOrder,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			res.Status = "processing" // гонка двух confirm — уже переведено
			return res
		}
		a.Log.Error("confirm: set processing failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	// Квота: фактический размер оригинала. presign проверяет её заранее,
	// но байты попадают в счётчик только здесь, поэтому ссылки, заказанные
	// до первого confirm, все проходили ту проверку по одному значению.
	limits := a.Cfg.Billing.Limits(string(shop.Plan))
	if _, err := q.AddShopStorageWithinLimit(r.Context(), db.AddShopStorageWithinLimitParams{
		ID:            shop.ID,
		StorageUsed:   size,
		StorageUsed_2: limits.MaxStorage,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			res.Status, res.Error = "error", "storage quota exceeded for current plan"
			res.Code = "quota_exceeded"
			return res
		}
		a.Log.Error("confirm: account storage failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	if err := tx.Commit(r.Context()); err != nil {
		a.Log.Error("confirm: commit failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	slots.placed[photo.AlbumID]++

	task, err := tasks.NewPhotoProcess(photo.ID)
	if err != nil {
		a.Log.Error("confirm: build task failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	if _, err := a.Tasks.EnqueueContext(r.Context(), task); err != nil {
		a.Log.Error("confirm: enqueue failed", "error", err)
		res.Status, res.Error = "error", "internal error"
		return res
	}
	res.Status = "processing"
	return res
}

func (a *API) handleListPhotos(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	shopID := shopFromCtx(r).ID
	// Страницами, как и на витрине: альбом на тарифе «Продавец» вмещает
	// до 5000 фотографий, и выдача целиком вешала кабинет на секунды.
	page := queryInt(r, "page", 1, 1, 1_000_000)
	perPage := queryInt(r, "per_page", cabinetPhotosPerPage, 1, cabinetPhotosPerPageMax)

	total, err := a.Q.CountPhotosByAlbum(r.Context(), db.CountPhotosByAlbumParams{
		AlbumID: album.ID,
		ShopID:  shopID,
	})
	if err != nil {
		a.internalError(w, "count photos", err)
		return
	}
	photos, err := a.Q.ListPhotosByAlbum(r.Context(), db.ListPhotosByAlbumParams{
		AlbumID: album.ID,
		ShopID:  shopID,
		Limit:   int32(perPage),
		Offset:  int32((page - 1) * perPage),
	})
	if err != nil {
		a.internalError(w, "list photos", err)
		return
	}
	out := make([]photoResponse, 0, len(photos))
	for _, p := range photos {
		out = append(out, a.toPhotoResponse(p, shopFromCtx(r).MediaRev))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"photos":   out,
		"page":     page,
		"per_page": perPage,
		"total":    total,
	})
}

const (
	cabinetPhotosPerPage    = 100
	cabinetPhotosPerPageMax = 500
)

type updatePhotoRequest struct {
	Caption *string `json:"caption"`
}

func (a *API) handleUpdatePhoto(w http.ResponseWriter, r *http.Request) {
	photo, shop, ok := a.ownedPhoto(w, r)
	if !ok {
		return
	}
	var req updatePhotoRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	caption := photo.Caption
	if req.Caption != nil {
		if len([]rune(*req.Caption)) > 2000 {
			apiError(w, http.StatusBadRequest, "invalid_caption", "caption must be at most 2000 characters")
			return
		}
		caption = *req.Caption
	}
	updated, err := a.Q.UpdatePhotoCaption(r.Context(), db.UpdatePhotoCaptionParams{
		ID:      photo.ID,
		ShopID:  photo.ShopID,
		Caption: caption,
	})
	if err != nil {
		a.internalError(w, "update photo", err)
		return
	}
	// Стоп-слова: флаг на ручную проверку модератором, НЕ автоблок.
	if req.Caption != nil && hasStopWord(a.Cfg.StopWords, caption) {
		if err := a.Q.SetPhotoFlagged(r.Context(), db.SetPhotoFlaggedParams{
			ID:      photo.ID,
			Flagged: true,
		}); err != nil {
			a.Log.Error("flag photo failed", "photo_id", photo.ID, "error", err)
		}
	}
	a.Revalidate.Shop(shop.Slug)
	writeJSON(w, http.StatusOK, a.toPhotoResponse(updated, shopFromCtx(r).MediaRev))
}

func (a *API) handleDeletePhoto(w http.ResponseWriter, r *http.Request) {
	photo, shop, ok := a.ownedPhoto(w, r)
	if !ok {
		return
	}
	// Неподтверждённая загрузка — не фотография: «Остановить» посреди пачки
	// оставляет строки uploading у файлов, на которые ссылка уже выдана.
	// Раньше их убирала только ночная уборка через сутки, а до тех пор они
	// висели в альбоме плитками «Обработка…» и занимали лимит фото. В
	// корзину таким незачем: деривативов нет, восстанавливать нечего.
	if photo.Status == db.PhotoStatusUploading {
		n, err := a.Q.DeleteUploadingPhoto(r.Context(), db.DeleteUploadingPhotoParams{
			ID:     photo.ID,
			ShopID: photo.ShopID,
		})
		if err != nil {
			a.internalError(w, "cancel upload", err)
			return
		}
		if n > 0 {
			// Файл мог успеть доехать в S3 без confirm — байты в квоту ещё
			// не попали, но объект надо убрать.
			if err := a.Store.RemovePhoto(r.Context(), photo.ShopID, photo.ID, imagingmeta.DerivativeSizes()); err != nil {
				a.Log.Error("cancel upload: remove object failed", "photo_id", photo.ID, "error", err)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// n == 0: confirm успел раньше — дальше обычное удаление.
	}
	// Удаление обратимо: фотография уезжает в «Удаленное». Объекты в S3
	// остаются на месте, поэтому место в квоте не возвращаем — вернёт его
	// окончательная уборка, своя или ночная по сроку хранения.
	n, err := a.Q.SoftDeletePhoto(r.Context(), db.SoftDeletePhotoParams{
		ID:     photo.ID,
		ShopID: photo.ShopID,
	})
	if err != nil {
		a.internalError(w, "delete photo", err)
		return
	}
	if n == 0 {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return
	}
	if err := a.recountAlbumPhotos(r.Context(), photo.AlbumID); err != nil {
		a.Log.Error("delete: recount album photos failed", "error", err)
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}

// recountAlbumPhotos выравнивает photo_count альбома по факту. Замок строки
// альбома — до пересчёта, отдельным запросом: так пересчёт видит всё, что
// закоммитили до нас (в том числе воркер, державший замок).
func (a *API) recountAlbumPhotos(ctx context.Context, albumID uuid.UUID) error {
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := a.Q.WithTx(tx)
	if err := q.LockAlbumForOrder(ctx, albumID); err != nil {
		return fmt.Errorf("lock album: %w", err)
	}
	if err := q.RecountAlbumPhotos(ctx, albumID); err != nil {
		return fmt.Errorf("recount: %w", err)
	}
	return tx.Commit(ctx)
}

// hasStopWord — регистронезависимое вхождение стоп-слова в подпись
// (подстрока: работает и для кириллицы, и для словоформ).
func hasStopWord(words []string, caption string) bool {
	if len(words) == 0 || caption == "" {
		return false
	}
	lc := strings.ToLower(caption)
	for _, word := range words {
		if strings.Contains(lc, strings.ToLower(word)) {
			return true
		}
	}
	return false
}

// ownedShop: магазин по id из тела запроса, с проверкой владения (404 чужому).
func (a *API) ownedShop(w http.ResponseWriter, r *http.Request, rawID string) (db.Shop, bool) {
	shopID, err := uuid.Parse(rawID)
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return db.Shop{}, false
	}
	shop, err := a.Q.GetShopForOwner(r.Context(), db.GetShopForOwnerParams{
		ID:      shopID,
		OwnerID: userID(r),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "shop not found")
		return db.Shop{}, false
	}
	if err != nil {
		a.internalError(w, "load shop", err)
		return db.Shop{}, false
	}
	return shop, true
}

// ownedPhoto: фото по id из URL + проверка владения через магазин (404 чужому).
func (a *API) ownedPhoto(w http.ResponseWriter, r *http.Request) (db.Photo, db.Shop, bool) {
	photoID, err := uuid.Parse(chi.URLParam(r, "photoID"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return db.Photo{}, db.Shop{}, false
	}
	photo, err := a.Q.GetPhoto(r.Context(), photoID)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusNotFound, "not_found", "photo not found")
		return db.Photo{}, db.Shop{}, false
	}
	if err != nil {
		a.internalError(w, "load photo", err)
		return db.Photo{}, db.Shop{}, false
	}
	shop, err := a.Q.GetShopForOwner(r.Context(), db.GetShopForOwnerParams{
		ID:      photo.ShopID,
		OwnerID: userID(r),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			apiError(w, http.StatusNotFound, "not_found", "photo not found")
			return db.Photo{}, db.Shop{}, false
		}
		a.internalError(w, "check photo ownership", err)
		return db.Photo{}, db.Shop{}, false
	}
	return photo, shop, true
}

// maxPhotoOrder — перестановка идёт страницей кабинета, больше за раз
// прийти не может.
const maxPhotoOrder = cabinetPhotosPerPageMax

// handleSetPhotoOrder задаёт порядок фотографий на странице альбома:
// продавец перетаскивает плитки, и первой должна стоять та, что продаёт.
// Порядок приходит списком целиком — обмен парой запросов рвался бы
// посередине и оставлял два фото с одним номером.
func (a *API) handleSetPhotoOrder(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	shop := shopFromCtx(r)
	var req struct {
		PhotoIDs []string `json:"photo_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.PhotoIDs) == 0 || len(req.PhotoIDs) > maxPhotoOrder {
		apiError(w, http.StatusBadRequest, "invalid_order",
			fmt.Sprintf("photo_ids must hold 1..%d ids", maxPhotoOrder))
		return
	}
	ids := make([]uuid.UUID, 0, len(req.PhotoIDs))
	seen := make(map[uuid.UUID]struct{}, len(req.PhotoIDs))
	for _, raw := range req.PhotoIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid_photo", "invalid photo id")
			return
		}
		// Повтор в списке дал бы одному фото два места сразу.
		if _, dup := seen[id]; dup {
			apiError(w, http.StatusBadRequest, "invalid_order", "photo_ids must be unique")
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if _, err := a.Q.SetPhotoOrder(r.Context(), db.SetPhotoOrderParams{
		ShopID:  shop.ID,
		AlbumID: album.ID,
		Column3: ids,
	}); err != nil {
		a.internalError(w, "set photo order", err)
		return
	}
	a.Revalidate.Shop(shop.Slug)
	w.WriteHeader(http.StatusNoContent)
}
