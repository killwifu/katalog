package integration

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestAuthFlow(t *testing.T) {
	c := newClient(t)
	email := uniqueEmail()

	var user userJSON
	c.mustJSON("POST", "/api/v1/auth/register",
		map[string]string{"email": email, "password": "password123"},
		http.StatusCreated, &user)
	if user.Email == nil || *user.Email != email {
		t.Fatalf("register: unexpected user %+v", user)
	}

	// Сессия установлена cookie.
	var me userJSON
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if me.ID != user.ID {
		t.Fatalf("me: got %s, want %s", me.ID, user.ID)
	}

	// Повторная регистрация того же email.
	c2 := newClient(t)
	c2.mustJSON("POST", "/api/v1/auth/register",
		map[string]string{"email": email, "password": "password123"},
		http.StatusConflict, nil)

	// Logout инвалидирует сессию.
	c.mustJSON("POST", "/api/v1/auth/logout", nil, http.StatusNoContent, nil)
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusUnauthorized, nil)

	// Login с неверным паролем.
	c.mustJSON("POST", "/api/v1/auth/login",
		map[string]string{"email": email, "password": "wrong-password"},
		http.StatusUnauthorized, nil)

	// Login с верным паролем.
	c.mustJSON("POST", "/api/v1/auth/login",
		map[string]string{"email": email, "password": "password123"},
		http.StatusOK, nil)
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
}

func TestAuthValidation(t *testing.T) {
	c := newClient(t)
	tests := []struct {
		name string
		body map[string]string
		want int
	}{
		{name: "bad email", body: map[string]string{"email": "not-an-email", "password": "password123"}, want: http.StatusBadRequest},
		{name: "short password", body: map[string]string{"email": uniqueEmail(), "password": "short"}, want: http.StatusBadRequest},
		{name: "empty body fields", body: map[string]string{}, want: http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c.mustJSON("POST", "/api/v1/auth/register", tt.body, tt.want, nil)
		})
	}
}

func TestAuthRateLimit(t *testing.T) {
	c := newClient(t) // уникальный X-Forwarded-For -> изолированный лимит
	body := map[string]string{"email": "ratelimit@test.local", "password": "wrong"}

	limited := false
	for i := 0; i < 35; i++ {
		status, _ := c.do("POST", "/api/v1/auth/login", body)
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
		if status != http.StatusUnauthorized {
			t.Fatalf("attempt %d: unexpected status %d", i, status)
		}
	}
	if !limited {
		t.Fatal("rate limit did not trigger after 35 attempts (limit is 30/min)")
	}
}

func TestUnauthenticatedAccess(t *testing.T) {
	c := newClient(t)
	paths := []struct{ method, path string }{
		{"GET", "/api/v1/auth/me"},
		{"GET", "/api/v1/shops"},
		{"POST", "/api/v1/shops"},
		{"POST", "/api/v1/uploads/presign"},
		{"POST", "/api/v1/photos/confirm"},
	}
	for _, p := range paths {
		status, _ := c.do(p.method, p.path, map[string]string{})
		if status != http.StatusUnauthorized {
			t.Errorf("%s %s without session: status %d, want 401", p.method, p.path, status)
		}
	}
}

// TestSignedHintCookie: статическая главная витрины не знает о сессии —
// она отдаётся из кеша всем одинаково. Рядом с httpOnly-сессией кладём
// булев маркер, доступный скрипту, чтобы шапка написала «Кабинет».
// Маркер авторизацией не является: доступ по-прежнему проверяется сессией.
func TestSignedHintCookie(t *testing.T) {
	body := strings.NewReader(`{"email":"hint-` + uuid.NewString() + `@example.com","password":"Test12345!"}`)
	resp, err := http.Post(env.srv.URL+"/api/v1/auth/register", "application/json", body)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer resp.Body.Close()

	var session, hint *http.Cookie
	for _, ck := range resp.Cookies() {
		switch ck.Name {
		case "katalog_session":
			session = ck
		case "katalog_signed":
			hint = ck
		}
	}

	if session == nil {
		t.Fatal("сессионная cookie не выставлена")
	}
	if !session.HttpOnly {
		t.Error("сессия обязана оставаться httpOnly")
	}
	if hint == nil || hint.Value != "1" {
		t.Fatalf("маркер входа не выставлен: %+v", hint)
	}
	// Маркер должен быть читаем скриптом, иначе шапка его не увидит.
	if hint.HttpOnly {
		t.Error("маркер httpOnly — скрипт шапки его не прочитает")
	}
	// В маркере не должно быть ничего, кроме признака: это не токен.
	if hint.Value != "1" {
		t.Errorf("в маркере лишнее значение %q", hint.Value)
	}
}
