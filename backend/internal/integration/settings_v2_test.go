package integration

import (
	"bytes"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Контакты, настройки и аккаунт по макетам 16–17.

// putLogo — presign и PUT логотипа в MinIO, затем confirm; возвращает logo_id.
func putLogo(t *testing.T, c *client, shopID string, data []byte) string {
	t.Helper()
	var pre struct {
		LogoID string `json:"logo_id"`
		URL    string `json:"url"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shopID+"/logo/presign", nil, http.StatusOK, &pre)
	req, _ := http.NewRequest(http.MethodPut, pre.URL, bytes.NewReader(data))
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT logo: %v %v", err, resp)
	}
	resp.Body.Close()
	c.mustJSON("POST", "/api/v1/shops/"+shopID+"/logo/confirm", map[string]string{"logo_id": pre.LogoID}, http.StatusAccepted, nil)
	return pre.LogoID
}

func waitLogo(t *testing.T, c *client, shopID, logoID string) map[string]string {
	t.Helper()
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		var st map[string]string
		c.mustJSON("GET", "/api/v1/shops/"+shopID+"/logo/status?logo_id="+logoID, nil, http.StatusOK, &st)
		if st["status"] != "processing" {
			return st
		}
	}
	t.Fatalf("logo %s not processed", logoID)
	return nil
}

func TestShopLogo(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	small := putLogo(t, c, shop.ID, makeJPEG(t, 120, 120))
	if st := waitLogo(t, c, shop.ID, small); st["status"] != "failed" || st["reason"] != "too_small" {
		t.Fatalf("маленький логотип: %v", st)
	}

	id := putLogo(t, c, shop.ID, makeJPEG(t, 400, 300))
	st := waitLogo(t, c, shop.ID, id)
	if st["status"] != "ready" || !strings.Contains(st["logo_url"], id+"/small.webp") {
		t.Fatalf("логотип: %v", st)
	}
	var pub struct {
		Shop struct {
			LogoURL string `json:"logo_url"`
		} `json:"shop"`
	}
	newClient(t).mustJSON("GET", "/api/v1/public/shops/"+shop.Slug, nil, http.StatusOK, &pub)
	if pub.Shop.LogoURL != st["logo_url"] {
		t.Fatalf("публичный логотип %q, want %q", pub.Shop.LogoURL, st["logo_url"])
	}

	// Чужой магазин — 404 на всех ручках логотипа.
	intruder := newClient(t)
	registerUser(intruder)
	for _, r := range []struct{ method, path string }{
		{"POST", "/logo/presign"},
		{"POST", "/logo/confirm"},
		{"GET", "/logo/status?logo_id=" + id},
		{"DELETE", "/logo"},
	} {
		if status, _ := intruder.do(r.method, "/api/v1/shops/"+shop.ID+r.path, map[string]string{"logo_id": id}); status != http.StatusNotFound {
			t.Fatalf("%s %s чужим: %d", r.method, r.path, status)
		}
	}

	c.mustJSON("DELETE", "/api/v1/shops/"+shop.ID+"/logo", nil, http.StatusNoContent, nil)
	var got struct {
		LogoURL string `json:"logo_url"`
	}
	c.mustJSON("GET", "/api/v1/shops/"+shop.ID, nil, http.StatusOK, &got)
	if got.LogoURL != "" {
		t.Fatalf("логотип не снят: %q", got.LogoURL)
	}
}

// Авито: только ссылка на профиль или магазин; клик по кнопке считается.
func TestAvitoContact(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, map[string]any{"contacts": map[string]string{"avito": "seoulwear"}}, http.StatusBadRequest, nil)
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID, map[string]any{"contacts": map[string]string{"avito": "avito.ru/brands/seoulwear"}}, http.StatusOK, nil)
	if status, body := newClient(t).do("POST", "/api/v1/public/lead-click", map[string]string{"shop_id": shop.ID, "channel": "avito"}); status != http.StatusNoContent {
		t.Fatalf("lead-click avito: %d %s", status, body)
	}
}

type accountJSON struct {
	Phone       *string `json:"phone"`
	HasPassword bool    `json:"has_password"`
	Identities  []struct {
		Provider string `json:"provider"`
	} `json:"identities"`
}

func TestAccountPhoneAndDelete(t *testing.T) {
	c := newClient(t)
	u := registerUser(c)
	shop := createShop(c)

	c.mustJSON("PATCH", "/api/v1/auth/me", map[string]string{"phone": "12-34"}, http.StatusBadRequest, nil)
	var me accountJSON
	c.mustJSON("PATCH", "/api/v1/auth/me", map[string]string{"phone": "+7 999 123-45-67"}, http.StatusOK, &me)
	if me.Phone == nil || *me.Phone != "+7 999 123-45-67" {
		t.Fatalf("phone: %+v", me)
	}
	c.mustJSON("PATCH", "/api/v1/auth/me", map[string]string{"phone": ""}, http.StatusOK, &me)
	if me.Phone != nil {
		t.Fatalf("телефон не убран: %v", *me.Phone)
	}

	c.mustJSON("DELETE", "/api/v1/auth/me", map[string]string{"password": "wrong-pass"}, http.StatusBadRequest, nil)
	c.mustJSON("DELETE", "/api/v1/auth/me", map[string]string{"password": "password123"}, http.StatusNoContent, nil)
	if status, _ := c.do("GET", "/api/v1/auth/me", nil); status != http.StatusUnauthorized {
		t.Fatalf("сессия пережила удаление: %d", status)
	}
	if status, _ := newClient(t).do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status != http.StatusNotFound {
		t.Fatalf("витрина удалённого аккаунта: %d", status)
	}
	if status, _ := newClient(t).do("POST", "/api/v1/auth/login", map[string]string{"email": *u.Email, "password": "password123"}); status != http.StatusUnauthorized {
		t.Fatalf("вход в удалённый аккаунт: %d", status)
	}
}

// «Подключить» в Настройках привязывает вход к текущему аккаунту; уже
// привязанный к другому — ошибка. Аккаунт без пароля задаёт его без текущего.
func TestOAuthLinkFromSettings(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	sub := fmt.Sprintf("ya-link-%d", clientSeq.Add(1))
	if loc := oauthLogin(t, c, "yandex", "?link=1", sub, ""); loc != "/app/settings?oauth_linked=yandex#account" {
		t.Fatalf("redirect: %q", loc)
	}
	var me accountJSON
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if len(me.Identities) != 1 || me.Identities[0].Provider != "yandex" {
		t.Fatalf("identities: %+v", me)
	}

	other := newClient(t)
	registerUser(other)
	if loc := oauthLogin(t, other, "yandex", "?link=1", sub, ""); loc != "/app/settings?oauth_error=taken#account" {
		t.Fatalf("чужая привязка: %q", loc)
	}

	social := newClient(t)
	oauthLogin(t, social, "vk", "", fmt.Sprintf("vk-pw-%d", clientSeq.Add(1)), "")
	social.mustJSON("DELETE", "/api/v1/auth/me", map[string]string{"password": ""}, http.StatusBadRequest, nil)
	social.mustJSON("POST", "/api/v1/auth/password/change", map[string]string{"new_password": "new-password-1"}, http.StatusNoContent, nil)
	social.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if !me.HasPassword {
		t.Fatalf("пароль не задан: %+v", me)
	}
	social.mustJSON("POST", "/api/v1/auth/password/change", map[string]string{"new_password": "new-password-2"}, http.StatusBadRequest, nil)
}

func TestResendEmailChange(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	c.mustJSON("POST", "/api/v1/auth/email/change/resend", nil, http.StatusNotFound, nil)
	c.mustJSON("POST", "/api/v1/auth/email/change", map[string]string{"email": uniqueEmail(), "password": "password123"}, http.StatusNoContent, nil)
	c.mustJSON("POST", "/api/v1/auth/email/change/resend", nil, http.StatusTooManyRequests, nil)
}
