package integration

import (
	"fmt"
	"net/http"
	"testing"
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

// TestAuthRateLimitSpoofedXFF: подделанный X-Forwarded-For не даёт обойти
// лимит. Caddy дописывает адрес пира к тому, что прислал клиент, поэтому
// доверять можно только последнему адресу в списке — по первому перебор
// пароля обходился одним заголовком со случайным IP на каждый запрос.
func TestAuthRateLimitSpoofedXFF(t *testing.T) {
	c := newClient(t)
	body := map[string]string{"email": "spoof@test.local", "password": "wrong"}

	for i := 0; i < 35; i++ {
		// Каждый раз новый «клиентский» адрес слева, реальный — справа.
		status, _ := c.doWithXFF("POST", "/api/v1/auth/login", body,
			fmt.Sprintf("203.0.113.%d, %s", i%256, c.ip))
		if status == http.StatusTooManyRequests {
			return
		}
		if status != http.StatusUnauthorized {
			t.Fatalf("attempt %d: unexpected status %d", i, status)
		}
	}
	t.Fatal("rate limit bypassed via spoofed X-Forwarded-For")
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
