package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

type publicShopPage struct {
	Shop struct {
		ID          string          `json:"id"`
		Slug        string          `json:"slug"`
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Contacts    json.RawMessage `json:"contacts"`
		MsgTemplate string          `json:"msg_template"`
	} `json:"shop"`
	Albums []struct {
		ID         string            `json:"id"`
		Title      string            `json:"title"`
		PhotoCount int32             `json:"photo_count"`
		CoverUrls  map[string]string `json:"cover_urls"`
	} `json:"albums"`
}

type publicAlbumPage struct {
	Album struct {
		ID         string `json:"id"`
		Title      string `json:"title"`
		PhotoCount int32  `json:"photo_count"`
	} `json:"album"`
	Photos  []publicPhotoJSON `json:"photos"`
	Page    int               `json:"page"`
	PerPage int               `json:"per_page"`
	Total   int64             `json:"total"`
}

type publicPhotoJSON struct {
	ID      string            `json:"id"`
	AlbumID string            `json:"album_id"`
	Caption string            `json:"caption"`
	Urls    map[string]string `json:"urls"`
}

// setCaption обновляет подпись фото от имени владельца.
func setCaption(c *client, photoID, caption string) {
	c.t.Helper()
	c.mustJSON("PATCH", "/api/v1/photos/"+photoID,
		map[string]string{"caption": caption}, http.StatusOK, nil)
}

// TestPublicShopPage: шапка + альбомы; скрытые альбомы и приватные поля
// не отдаются; обложка подставляется из первого ready-фото.
func TestPublicShopPage(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, map[string]any{
		"description": "Лучшие кроссовки города",
		"contacts":    map[string]string{"telegram": "test_shop", "whatsapp": "79990000000"},
		"settings":    map[string]string{"msg_template": "Интересует: {caption}"},
	}, http.StatusOK, nil)

	visible := createAlbum(c, shop.ID)
	var hidden albumJSON
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Скрытый"}, http.StatusCreated, &hidden)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+hidden.ID,
		map[string]any{"is_hidden": true}, http.StatusOK, nil)

	photoID := uploadPhoto(c, shop.ID, visible.ID, makeJPEG(t, 640, 480))
	waitPhotoStatus(c, shop.ID, visible.ID, photoID, "ready", 60*time.Second)

	status, raw := c.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
	if status != http.StatusOK {
		t.Fatalf("public shop: status %d: %s", status, raw)
	}

	// Форма ответа: приватные поля не должны утекать наружу.
	for _, forbidden := range []string{
		"email", "storage_used", "storage_max", "owner_id",
		"password_hash", "plan", "is_hidden", "phash", "orig_size", "source",
	} {
		if strings.Contains(string(raw), `"`+forbidden+`"`) {
			t.Errorf("public shop response leaks %q: %s", forbidden, raw)
		}
	}

	var page publicShopPage
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if page.Shop.Slug != shop.Slug || page.Shop.Name != "Test Shop" {
		t.Errorf("shop header mismatch: %+v", page.Shop)
	}
	if page.Shop.MsgTemplate != "Интересует: {caption}" {
		t.Errorf("msg_template = %q", page.Shop.MsgTemplate)
	}
	if !strings.Contains(string(page.Shop.Contacts), "test_shop") {
		t.Errorf("contacts missing telegram: %s", page.Shop.Contacts)
	}
	if len(page.Albums) != 1 {
		t.Fatalf("want 1 visible album, got %d: %+v", len(page.Albums), page.Albums)
	}
	al := page.Albums[0]
	if al.ID != visible.ID || al.PhotoCount != 1 {
		t.Errorf("album mismatch: %+v", al)
	}
	// Обложка не назначалась — берётся первое ready-фото.
	wantCover := fmt.Sprintf("/media/%s/%s/300.webp", shop.ID, photoID)
	if al.CoverUrls["thumb"] != wantCover {
		t.Errorf("cover thumb = %q, want %q", al.CoverUrls["thumb"], wantCover)
	}

	// Скрытый альбом недоступен и напрямую.
	status, _ = c.do("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+hidden.ID, nil)
	if status != http.StatusNotFound {
		t.Errorf("hidden album: status %d, want 404", status)
	}
	// Неизвестный slug — 404.
	status, _ = c.do("GET", "/api/v1/public/shops/no-such-shop-xyz", nil)
	if status != http.StatusNotFound {
		t.Errorf("unknown slug: status %d, want 404", status)
	}
}

// TestPublicAlbumPagination: только ready-фото, постраничная выдача.
func TestPublicAlbumPagination(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	var ids []string
	for range 3 {
		id := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))
		ids = append(ids, id)
	}
	for _, id := range ids {
		waitPhotoStatus(c, shop.ID, album.ID, id, "ready", 60*time.Second)
	}

	var page1 publicAlbumPage
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID+"?per_page=2", nil,
		http.StatusOK, &page1)
	if len(page1.Photos) != 2 || page1.Total != 3 || page1.Page != 1 {
		t.Fatalf("page1: %d photos, total %d, page %d", len(page1.Photos), page1.Total, page1.Page)
	}
	for _, p := range page1.Photos {
		if p.Urls["large"] == "" || !strings.Contains(p.Urls["large"], "1600.webp") {
			t.Errorf("photo %s: bad urls %+v", p.ID, p.Urls)
		}
	}

	var page2 publicAlbumPage
	c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID+"?per_page=2&page=2", nil,
		http.StatusOK, &page2)
	if len(page2.Photos) != 1 || page2.Page != 2 {
		t.Fatalf("page2: %d photos, page %d", len(page2.Photos), page2.Page)
	}
	if page1.Photos[0].ID == page2.Photos[0].ID {
		t.Error("pagination returned duplicate photo")
	}
}

// TestPublicSearch: FTS по-русски (со стеммингом), латиница, trgm-fallback
// на опечатки; фото скрытых альбомов не находятся.
func TestPublicSearch(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	sneakers := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))
	tshirt := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))
	waitPhotoStatus(c, shop.ID, album.ID, sneakers, "ready", 60*time.Second)
	waitPhotoStatus(c, shop.ID, album.ID, tshirt, "ready", 60*time.Second)
	setCaption(c, sneakers, "Красные кроссовки Nike Air, арт. SN-42")
	setCaption(c, tshirt, "Синяя футболка Adidas, арт. TS-07")

	// Фото в скрытом альбоме не должно попадать в выдачу.
	var hidden albumJSON
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Архив"}, http.StatusCreated, &hidden)
	hiddenPhoto := uploadPhoto(c, shop.ID, hidden.ID, makeJPEG(t, 320, 240))
	waitPhotoStatus(c, shop.ID, hidden.ID, hiddenPhoto, "ready", 60*time.Second)
	setCaption(c, hiddenPhoto, "Кроссовки из архива")
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+hidden.ID,
		map[string]any{"is_hidden": true}, http.StatusOK, nil)

	search := func(q string) []publicPhotoJSON {
		t.Helper()
		var resp struct {
			Photos []publicPhotoJSON `json:"photos"`
		}
		c.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/search?q="+url.QueryEscape(q), nil,
			http.StatusOK, &resp)
		return resp.Photos
	}

	// FTS: точная словоформа и стемминг ("кроссовкам" -> кроссовк).
	for _, q := range []string{"кроссовки", "кроссовкам", "nike"} {
		got := search(q)
		if len(got) != 1 || got[0].ID != sneakers {
			t.Errorf("search %q: got %+v, want only sneakers %s", q, got, sneakers)
		}
	}

	// Опечатка: FTS промахнётся, trgm-fallback должен найти.
	got := search("красовки")
	if len(got) != 1 || got[0].ID != sneakers {
		t.Errorf("typo search: got %+v, want sneakers via trgm fallback", got)
	}

	// Ничего не найдено — пустой список, не ошибка.
	if got := search("несуществующийтовар"); len(got) != 0 {
		t.Errorf("empty search: got %+v", got)
	}

	// Пустой q — 400.
	status, _ := c.do("GET", "/api/v1/public/shops/"+shop.Slug+"/search?q=", nil)
	if status != http.StatusBadRequest {
		t.Errorf("empty q: status %d, want 400", status)
	}
}

// TestLeadClick: фиксация лида, visitor_hash стабилен для одного
// посетителя (cookie+IP), канал валидируется.
func TestLeadClick(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	photoID := uploadPhoto(c, shop.ID, album.ID, makeJPEG(t, 320, 240))
	waitPhotoStatus(c, shop.ID, album.ID, photoID, "ready", 60*time.Second)

	click := func(body map[string]any) int {
		t.Helper()
		status, _ := c.do("POST", "/api/v1/public/lead-click", body)
		return status
	}

	if s := click(map[string]any{"shop_id": shop.ID, "photo_id": photoID, "channel": "telegram"}); s != http.StatusNoContent {
		t.Fatalf("lead click: status %d, want 204", s)
	}
	// Cookie посетителя установлена и переиспользуется.
	srvURL, _ := url.Parse(env.srv.URL)
	var visitorCookie string
	for _, ck := range c.http.Jar.Cookies(srvURL) {
		if ck.Name == "kv" {
			visitorCookie = ck.Value
		}
	}
	if visitorCookie == "" {
		t.Fatal("visitor cookie kv not set")
	}
	if s := click(map[string]any{"shop_id": shop.ID, "channel": "whatsapp"}); s != http.StatusNoContent {
		t.Fatalf("second lead click: status %d", s)
	}

	var total, distinct int
	err := env.pool.QueryRow(t.Context(),
		"SELECT count(*), count(DISTINCT visitor_hash) FROM lead_clicks WHERE shop_id = $1",
		uuid.MustParse(shop.ID)).Scan(&total, &distinct)
	if err != nil {
		t.Fatalf("query lead_clicks: %v", err)
	}
	if total != 2 || distinct != 1 {
		t.Errorf("lead_clicks: total %d (want 2), distinct visitors %d (want 1)", total, distinct)
	}

	if s := click(map[string]any{"shop_id": shop.ID, "channel": "icq"}); s != http.StatusBadRequest {
		t.Errorf("invalid channel: status %d, want 400", s)
	}
	if s := click(map[string]any{"shop_id": uuid.NewString(), "channel": "vk"}); s != http.StatusNotFound {
		t.Errorf("unknown shop: status %d, want 404", s)
	}
}

// TestPublicSitemap: активные магазины присутствуют в выдаче.
func TestPublicSitemap(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	var resp struct {
		Shops []struct {
			Slug string `json:"slug"`
		} `json:"shops"`
	}
	c.mustJSON("GET", "/api/v1/public/sitemap", nil, http.StatusOK, &resp)
	found := false
	for _, s := range resp.Shops {
		if s.Slug == shop.Slug {
			found = true
		}
	}
	if !found {
		t.Errorf("sitemap does not contain %s", shop.Slug)
	}
}
