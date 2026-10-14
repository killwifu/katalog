package integration

import (
	"bytes"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// Параллельные регистрации одного адреса: ровно одна проходит, остальные —
// 409 email_taken. Раньше проверка «адрес свободен» и вставка шли порознь, и
// проигравшие упирались в UNIQUE с ответом 500.
func TestRegisterRaceSameEmail(t *testing.T) {
	email := uniqueEmail()
	const n = 8
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = newClient(t).do("POST", "/api/v1/auth/register",
				map[string]string{"email": email, "password": "password123"})
		}(i)
	}
	wg.Wait()
	created := 0
	for _, c := range codes {
		switch c {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
		default:
			t.Fatalf("unexpected status %d in %v", c, codes)
		}
	}
	if created != 1 {
		t.Fatalf("want exactly one 201, got %v", codes)
	}
}

// Пароль аккаунта ограничен сверху (argon2 хеширует вход целиком).
func TestAccountPasswordMaxLength(t *testing.T) {
	long := strings.Repeat("п", 129)
	c := newClient(t)
	c.mustJSON("POST", "/api/v1/auth/register",
		map[string]string{"email": uniqueEmail(), "password": long}, http.StatusBadRequest, nil)
	c.mustJSON("POST", "/api/v1/auth/register",
		map[string]string{"email": uniqueEmail(), "password": strings.Repeat("п", 128)}, http.StatusCreated, nil)
	c.mustJSON("POST", "/api/v1/auth/password/change",
		map[string]string{"current_password": strings.Repeat("п", 128), "new_password": long}, http.StatusBadRequest, nil)
	// Вход с заведомо длинным паролем — обычный отказ, не 400 и не 500.
	newClient(t).mustJSON("POST", "/api/v1/auth/login",
		map[string]string{"email": uniqueEmail(), "password": long}, http.StatusUnauthorized, nil)
}

// Тело с данными после JSON-объекта отклоняется, а не обрезается молча.
func TestTrailingJSONRejected(t *testing.T) {
	c := newClient(t)
	body := []byte(`{"email":"a@b.cd","password":"password123"}{"x":1}`)
	req, _ := http.NewRequest("POST", env.srv.URL+"/api/v1/auth/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", c.ip)
	resp, err := c.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("trailing data: got %d, want 400", resp.StatusCode)
	}
}

// JSON-тело принимается только с Content-Type: application/json — межсайтовая
// форма или text/plain с JSON внутри получает 415 (защита от CSRF помимо SameSite).
func TestJSONContentTypeRequired(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	for _, ct := range []string{"text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""} {
		req, _ := http.NewRequest("POST", env.srv.URL+"/api/v1/shops/"+shop.ID+"/albums", strings.NewReader(`{"title":"CSRF"}`))
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		req.Header.Set("X-Forwarded-For", c.ip)
		resp, err := c.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnsupportedMediaType {
			t.Errorf("Content-Type %q: got %d, want 415", ct, resp.StatusCode)
		}
	}
	// С параметром charset — обычный JSON.
	req, _ := http.NewRequest("POST", env.srv.URL+"/api/v1/shops/"+shop.ID+"/albums", strings.NewReader(`{"title":"ok"}`))
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("X-Forwarded-For", c.ip)
	resp, err := c.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Errorf("application/json; charset=utf-8: got %d, want 201", resp.StatusCode)
	}
}

// Тело `null` — не объект: раньше оно раскладывалось в пустую структуру,
// и PATCH альбома отвечал 200, ничего не получив.
func TestNullJSONBodyRejected(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	for _, body := range []string{"null", " null\n"} {
		req, _ := http.NewRequest("PATCH", env.srv.URL+"/api/v1/shops/"+shop.ID+"/albums/"+album.ID, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", c.ip)
		resp, err := c.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %q: got %d, want 400", body, resp.StatusCode)
		}
	}
}
