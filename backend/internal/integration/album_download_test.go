package integration

import (
	"archive/zip"
	"bytes"
	"net/http"
	"testing"
)

// TestAlbumDownload: продавец скачивает свои оригиналы одним архивом, в
// порядке альбома; чужой альбом не скачать, пустой — 409, а не пустой zip.
func TestAlbumDownload(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	base := "/api/v1/shops/" + shop.ID + "/albums/" + album.ID + "/download"

	if status, _ := c.do("GET", base+"?check=1", nil); status != http.StatusConflict {
		t.Errorf("пустой альбом: status %d, want 409", status)
	}

	small := makeJPEG(t, 400, 300)
	big := makeJPEG(t, 800, 600)
	first := uploadReadyPhoto(t, c, shop.ID, album.ID, small)
	second := uploadReadyPhoto(t, c, shop.ID, album.ID, big)
	_ = first
	// Удалённое фото в архив не попадает.
	gone := uploadReadyPhoto(t, c, shop.ID, album.ID, small)
	if status, _ := c.do("DELETE", "/api/v1/photos/"+gone, nil); status != http.StatusNoContent {
		t.Fatalf("delete photo failed")
	}
	// Второе фото ставим первым: порядок архива — порядок альбома.
	if status, _ := c.do("PUT", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID+"/photos/order",
		map[string]any{"photo_ids": []string{second, first}}); status != http.StatusNoContent {
		t.Fatalf("reorder failed")
	}

	var info struct {
		Photos int   `json:"photos"`
		Bytes  int64 `json:"bytes"`
	}
	c.mustJSON("GET", base+"?check=1", nil, http.StatusOK, &info)
	if info.Photos != 2 || info.Bytes != int64(len(small)+len(big)) {
		t.Errorf("сводка архива: %+v, ожидалось 2 фото и %d байт", info, len(small)+len(big))
	}

	status, raw := c.do("GET", base, nil)
	if status != http.StatusOK {
		t.Fatalf("download: status %d", status)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("ответ не zip: %v", err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("в архиве %d файлов, ожидалось 2", len(zr.File))
	}
	if zr.File[0].Name != "1.jpg" || zr.File[1].Name != "2.jpg" {
		t.Errorf("имена файлов: %s, %s", zr.File[0].Name, zr.File[1].Name)
	}
	if zr.File[0].UncompressedSize64 != uint64(len(big)) || zr.File[1].UncompressedSize64 != uint64(len(small)) {
		t.Errorf("порядок или содержимое архива не совпали с альбомом: %d, %d",
			zr.File[0].UncompressedSize64, zr.File[1].UncompressedSize64)
	}

	// Только выбранные фото.
	c.mustJSON("GET", base+"?check=1&ids="+first, nil, http.StatusOK, &info)
	if info.Photos != 1 || info.Bytes != int64(len(small)) {
		t.Errorf("сводка по выбранным: %+v", info)
	}
	// Одно выбранное фото приходит файлом, а не архивом.
	status, single := c.do("GET", base+"?ids="+first, nil)
	if status != http.StatusOK || len(single) != len(small) || !bytes.HasPrefix(single, []byte{0xFF, 0xD8, 0xFF}) {
		t.Errorf("одно фото: status %d, %d байт (ожидался JPEG на %d байт)", status, len(single), len(small))
	}

	stranger := newClient(t)
	registerUser(stranger)
	their := createShop(stranger)
	statsPath := "/api/v1/shops/" + shop.ID + "/albums/" + album.ID + "/stats"
	var stats struct {
		ViewsWeek  int64 `json:"views_week"`
		LeadClicks int64 `json:"lead_clicks"`
	}
	c.mustJSON("GET", statsPath, nil, http.StatusOK, &stats)
	if stats.ViewsWeek != 0 || stats.LeadClicks != 0 {
		t.Errorf("у свежего альбома ненулевые показатели: %+v", stats)
	}
	// Переход в мессенджер с фото альбома попадает в его показатели.
	c.mustJSON("POST", "/api/v1/public/lead-click",
		map[string]any{"shop_id": shop.ID, "photo_id": first, "channel": "telegram"}, http.StatusNoContent, nil)
	c.mustJSON("GET", statsPath, nil, http.StatusOK, &stats)
	if stats.LeadClicks != 1 {
		t.Errorf("переход в мессенджер не попал в показатели альбома: %+v", stats)
	}

	for _, path := range []string{base, base + "?check=1", statsPath, "/api/v1/shops/" + their.ID + "/albums/" + album.ID + "/download"} {
		status, body := stranger.do("GET", path, nil)
		if status != http.StatusNotFound && status != http.StatusForbidden {
			t.Errorf("GET %s чужим: status %d (%d байт), want 404/403", path, status, len(body))
		}
	}
}
