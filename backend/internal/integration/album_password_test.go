package integration

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

type pubAlbumPage struct {
	Album struct {
		ID          string            `json:"id"`
		Title       string            `json:"title"`
		Description string            `json:"description"`
		HasPassword bool              `json:"has_password"`
		Locked      bool              `json:"locked"`
		CoverUrls   map[string]string `json:"cover_urls"`
	} `json:"album"`
	Photos []photoJSON `json:"photos"`
	Total  int64       `json:"total"`
}

// TestAlbumPassword: пароль закрывает содержимое альбома от покупателя
// всеми путями, которыми оно могло бы утечь, — страница альбома, обложка
// в сетке, поиск по подписям — и открывает его только с пропуском.
func TestAlbumPassword(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	photoID := uploadReadyPhoto(t, c, shop.ID, album.ID, makeJPEG(t, 400, 300))
	setCaption(c, photoID, "Куртка секретная оптовая")
	albumPath := "/api/v1/shops/" + shop.ID + "/albums/" + album.ID
	c.mustJSON("PATCH", albumPath, map[string]any{"description": "Закрытые цены", "status": "published"}, http.StatusOK, nil)
	pubPath := "/api/v1/public/shops/" + shop.Slug + "/albums/" + album.ID

	// --- бесплатный тариф: задать пароль нельзя ---
	if status, body := c.do("PATCH", albumPath, map[string]any{"password": "opt2026"}); status != http.StatusForbidden ||
		!strings.Contains(string(body), "password_plan_required") {
		t.Fatalf("free plan: status %d, body %s", status, body)
	}
	mustExec(t, "UPDATE shops SET plan = 'standard', paid_until = now() + interval '30 days' WHERE id = $1", shop.ID)

	// --- мусорные пароли ---
	for _, bad := range []string{"abc", strings.Repeat("x", 65)} {
		if status, _ := c.do("PATCH", albumPath, map[string]any{"password": bad}); status != http.StatusBadRequest {
			t.Errorf("пароль длиной %d: status %d, want 400", len(bad), status)
		}
	}

	// --- задали пароль: кабинет видит признак, но не хеш ---
	status, body := c.do("PATCH", albumPath, map[string]any{"password": "opt2026"})
	if status != http.StatusOK {
		t.Fatalf("set password: status %d, body %s", status, body)
	}
	if !strings.Contains(string(body), `"has_password":true`) {
		t.Errorf("кабинет не видит has_password: %s", body)
	}
	if strings.Contains(string(body), "argon2") || strings.Contains(string(body), "password_hash") {
		t.Fatalf("хеш пароля утёк в ответ кабинета: %s", body)
	}
	_, list := c.do("GET", "/api/v1/shops/"+shop.ID+"/albums", nil)
	if strings.Contains(string(list), "argon2") || strings.Contains(string(list), "password_hash") {
		t.Fatalf("хеш пароля утёк в список альбомов: %s", list)
	}

	// --- покупатель без пароля ---
	buyer := newClient(t)
	var locked pubAlbumPage
	buyer.mustJSON("GET", pubPath, nil, http.StatusOK, &locked)
	if !locked.Album.Locked || !locked.Album.HasPassword {
		t.Errorf("альбом не помечен закрытым: %+v", locked.Album)
	}
	if len(locked.Photos) != 0 || locked.Total != 0 || locked.Album.Description != "" {
		t.Fatalf("закрытый альбом отдал содержимое: %+v", locked)
	}
	_, raw := buyer.do("GET", pubPath, nil)
	if strings.Contains(string(raw), photoID) || strings.Contains(string(raw), "argon2") {
		t.Fatalf("в ответе закрытого альбома есть фото или хеш: %s", raw)
	}

	// Обложка в сетке магазина и подписи в поиске — тоже содержимое.
	_, shopRaw := buyer.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
	if strings.Contains(string(shopRaw), photoID) {
		t.Errorf("обложка закрытого альбома видна в сетке магазина: %s", shopRaw)
	}
	if !strings.Contains(string(shopRaw), `"has_password":true`) {
		t.Errorf("в сетке магазина нет признака замка: %s", shopRaw)
	}
	for _, q := range []string{"секретная", "секретна"} {
		_, found := buyer.do("GET", "/api/v1/public/shops/"+shop.Slug+"/search?q="+url.QueryEscape(q), nil)
		if strings.Contains(string(found), photoID) {
			t.Errorf("поиск «%s» выдал фото закрытого альбома: %s", q, found)
		}
	}

	// --- неверный пароль и подделка пропуска ---
	if status, _ := buyer.do("POST", pubPath+"/unlock", map[string]any{"password": "nope"}); status != http.StatusForbidden {
		t.Errorf("неверный пароль: status %d, want 403", status)
	}
	buyer.headers = map[string]string{"X-Album-Token": strings.Repeat("a", 64)}
	buyer.mustJSON("GET", pubPath, nil, http.StatusOK, &locked)
	if !locked.Album.Locked {
		t.Fatalf("поддельный пропуск открыл альбом")
	}
	buyer.headers = nil

	// --- верный пароль ---
	var pass struct {
		Token string `json:"token"`
	}
	buyer.mustJSON("POST", pubPath+"/unlock", map[string]any{"password": "opt2026"}, http.StatusOK, &pass)
	if len(pass.Token) != 64 {
		t.Fatalf("пропуск не выдан: %+v", pass)
	}
	buyer.headers = map[string]string{"X-Album-Token": pass.Token}
	var open pubAlbumPage
	buyer.mustJSON("GET", pubPath, nil, http.StatusOK, &open)
	if open.Album.Locked || len(open.Photos) != 1 || open.Photos[0].ID != photoID || open.Album.Description != "Закрытые цены" {
		t.Fatalf("с пропуском альбом не открылся: %+v", open)
	}

	// Пропуск от одного альбома не открывает другой.
	other := createAlbum(c, shop.ID)
	uploadReadyPhoto(t, c, shop.ID, other.ID, makeJPEG(t, 400, 300))
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+other.ID,
		map[string]any{"status": "published", "password": "other-pass"}, http.StatusOK, nil)
	buyer.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+other.ID, nil, http.StatusOK, &locked)
	if !locked.Album.Locked {
		t.Fatalf("пропуск одного альбома открыл другой")
	}

	// --- смена пароля гасит выданные пропуска ---
	c.mustJSON("PATCH", albumPath, map[string]any{"password": "new-pass-1"}, http.StatusOK, nil)
	buyer.mustJSON("GET", pubPath, nil, http.StatusOK, &locked)
	if !locked.Album.Locked {
		t.Fatalf("после смены пароля старый пропуск продолжил работать")
	}

	// --- понижение тарифа: пароль остаётся, ни сменить, ни снять нельзя ---
	mustExec(t, "UPDATE shops SET plan = 'free', paid_until = NULL WHERE id = $1", shop.ID)
	buyer.headers = nil
	buyer.mustJSON("GET", pubPath, nil, http.StatusOK, &locked)
	if !locked.Album.Locked {
		t.Errorf("после понижения тарифа пароль перестал действовать")
	}
	for _, pwd := range []string{"another1", ""} {
		if status, _ := c.do("PATCH", albumPath, map[string]any{"password": pwd}); status != http.StatusForbidden {
			t.Errorf("free: пароль %q: status %d, want 403", pwd, status)
		}
	}
	// Остальные поля альбома на бесплатном тарифе правятся как обычно.
	c.mustJSON("PATCH", albumPath, map[string]any{"title": "Каталог 2"}, http.StatusOK, nil)

	// --- платный тариф: снять пароль можно ---
	mustExec(t, "UPDATE shops SET plan = 'standard', paid_until = now() + interval '30 days' WHERE id = $1", shop.ID)
	status, body = c.do("PATCH", albumPath, map[string]any{"password": ""})
	if status != http.StatusOK || !strings.Contains(string(body), `"has_password":false`) {
		t.Fatalf("снятие пароля: status %d, body %s", status, body)
	}
	buyer.mustJSON("GET", pubPath, nil, http.StatusOK, &open)
	if open.Album.Locked || len(open.Photos) != 1 {
		t.Errorf("после снятия пароля альбом не открылся: %+v", open)
	}
}

// Чужому альбому пароль не поставить.
func TestAlbumPasswordTenantIsolation(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	mustExec(t, "UPDATE shops SET plan = 'standard' WHERE id = $1", shop.ID)

	stranger := newClient(t)
	registerUser(stranger)
	their := createShop(stranger)
	mustExec(t, "UPDATE shops SET plan = 'standard' WHERE id = $1", their.ID)

	for _, path := range []string{
		"/api/v1/shops/" + shop.ID + "/albums/" + album.ID,
		"/api/v1/shops/" + their.ID + "/albums/" + album.ID,
	} {
		status, _ := stranger.do("PATCH", path, map[string]any{"password": "hijacked"})
		if status != http.StatusNotFound && status != http.StatusForbidden {
			t.Errorf("PATCH %s: status %d, want 404/403", path, status)
		}
	}
	_, body := owner.do("GET", "/api/v1/shops/"+shop.ID+"/albums", nil)
	if !strings.Contains(string(body), `"has_password":false`) {
		t.Errorf("чужой поставил пароль: %s", body)
	}
}
