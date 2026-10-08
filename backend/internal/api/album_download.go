package api

import (
	"archive/zip"
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"katalog/backend/internal/db"
	"katalog/backend/internal/storage"
)

// «Скачать все фото» со страницы альбома (макет 13 · меню «Ещё»).
//
// Продавцу отдаются его же оригиналы — те файлы, что он загрузил. Это не
// нарушает правило «покупателю только деривативы»: эндпоинт приватный,
// за сессией и проверкой владения альбомом.
//
// Архив собирается на лету и без сжатия: фотографии уже сжаты, а держать
// альбом в памяти или на диске незачем.

// downloadPageSize — сколько строк фото читать из базы за раз.
const downloadPageSize = 500

// handleAlbumDownload: с ?check=1 отвечает, сколько фото и байт попадёт в
// архив (кабинет показывает «Готовим архив» и ловит отказ до начала
// скачивания); без него — отдаёт сам zip.
func (a *API) handleAlbumDownload(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumFromURL(w, r)
	if !ok {
		return
	}
	shop := shopFromCtx(r)

	var photos []db.Photo
	for offset := 0; ; offset += downloadPageSize {
		page, err := a.Q.ListPhotosByAlbum(r.Context(), db.ListPhotosByAlbumParams{
			AlbumID: album.ID,
			ShopID:  shop.ID,
			Limit:   downloadPageSize,
			Offset:  int32(offset),
		})
		if err != nil {
			a.internalError(w, "download: list photos", err)
			return
		}
		for _, p := range page {
			// В архив идут только обработанные фото: у остальных оригинал
			// либо ещё не доехал, либо отвергнут проверкой.
			if p.Status == db.PhotoStatusReady {
				photos = append(photos, p)
			}
		}
		if len(page) < downloadPageSize {
			break
		}
	}
	// ids — только выбранные фото («Выбрано: N · Скачать»). Порядок всё равно
	// альбомный, а чужие или посторонние id просто ни с чем не совпадут.
	if raw := r.URL.Query().Get("ids"); raw != "" {
		want := make(map[string]struct{})
		for _, id := range strings.Split(raw, ",") {
			want[strings.TrimSpace(id)] = struct{}{}
		}
		picked := photos[:0]
		for _, p := range photos {
			if _, ok := want[p.ID.String()]; ok {
				picked = append(picked, p)
			}
		}
		photos = picked
	}
	if len(photos) == 0 {
		apiError(w, http.StatusConflict, "album_empty", "album has no photos to download")
		return
	}

	if r.URL.Query().Get("check") != "" {
		var total int64
		for _, p := range photos {
			total += p.OrigSize
		}
		writeJSON(w, http.StatusOK, map[string]any{"photos": len(photos), "bytes": total})
		return
	}

	name := archiveName(album.Title)
	// Одно выбранное фото уходит файлом, без архива (макет 13: «Одно
	// выбранное фото скачивается сразу файлом»).
	if len(photos) == 1 && r.URL.Query().Get("ids") != "" {
		data, err := a.Store.Download(r.Context(), storage.OrigKey(shop.ID, photos[0].ID))
		if err != nil {
			a.internalError(w, "download original", err)
			return
		}
		ext := originalExt(data)
		w.Header().Set("Content-Type", http.DetectContentType(data))
		w.Header().Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="photo%s"; filename*=UTF-8''%s`, ext, url.PathEscape(name+ext)))
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	// filename* — для кириллицы в названии альбома; простой filename —
	// запасной вариант для клиентов, которые его не понимают.
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="album.zip"; filename*=UTF-8''%s`, url.PathEscape(name+".zip")))
	w.Header().Set("Cache-Control", "no-store")

	zw := zip.NewWriter(w)
	defer func() { _ = zw.Close() }()
	width := len(fmt.Sprint(len(photos)))
	for i, p := range photos {
		data, err := a.Store.Download(r.Context(), storage.OrigKey(shop.ID, p.ID))
		if err != nil {
			// Заголовки уже ушли — оборвать ответ нельзя сообщением. Пропускаем
			// файл и пишем в лог: архив без одного снимка лучше обрыва на сотом.
			a.Log.Error("download: read original failed", "photo_id", p.ID, "error", err)
			continue
		}
		header := &zip.FileHeader{
			Name:   fmt.Sprintf("%0*d%s", width, i+1, originalExt(data)),
			Method: zip.Store,
		}
		// Без даты архиватор показывает 1980 год — ставим день загрузки.
		if p.CreatedAt.Valid {
			header.Modified = p.CreatedAt.Time
		}
		fw, err := zw.CreateHeader(header)
		if err != nil {
			a.Log.Error("download: zip entry failed", "error", err)
			return
		}
		if _, err := fw.Write(data); err != nil {
			// Продавец закрыл вкладку или отменил скачивание.
			return
		}
	}
}

// originalExt — расширение по сигнатуре файла: имя оригинала сервер не
// хранит (ключ в S3 — id фотографии).
func originalExt(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}):
		return ".jpg"
	case bytes.HasPrefix(data, []byte{0x89, 'P', 'N', 'G'}):
		return ".png"
	case len(data) > 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return ".webp"
	case len(data) > 12 && string(data[4:8]) == "ftyp":
		return ".heic"
	}
	return ".bin"
}

// archiveName — название альбома, пригодное для имени файла.
func archiveName(title string) string {
	name := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 0x20 {
			return '-'
		}
		return r
	}, strings.TrimSpace(title))
	if name == "" {
		return "album"
	}
	return name
}
