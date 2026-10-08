package integration

import (
	"net/http"
	"testing"
)

// TestChangePassword: смена пароля из кабинета требует текущий пароль,
// закрывает остальные сессии и оставляет продавца в текущей.
func TestChangePassword(t *testing.T) {
	c := newClient(t)
	u := registerUser(c)

	// Вторая сессия того же продавца — «чужой компьютер».
	other := newClient(t)
	other.mustJSON("POST", "/api/v1/auth/login",
		map[string]string{"email": *u.Email, "password": "password123"}, http.StatusOK, nil)

	change := func(current, next string) int {
		status, _ := c.do("POST", "/api/v1/auth/password/change",
			map[string]string{"current_password": current, "new_password": next})
		return status
	}
	if st := change("wrong-password", "new-password-1"); st != http.StatusBadRequest {
		t.Fatalf("wrong current password: status %d, want 400", st)
	}
	if st := change("password123", "short"); st != http.StatusBadRequest {
		t.Fatalf("short new password: status %d, want 400", st)
	}
	if st := change("password123", "new-password-1"); st != http.StatusNoContent {
		t.Fatalf("change: status %d, want 204", st)
	}

	if st, _ := c.do("GET", "/api/v1/auth/me", nil); st != http.StatusOK {
		t.Fatalf("current session after change: status %d, want 200", st)
	}
	if st, _ := other.do("GET", "/api/v1/auth/me", nil); st != http.StatusUnauthorized {
		t.Fatalf("other session after change: status %d, want 401", st)
	}

	fresh := newClient(t)
	if st, _ := fresh.do("POST", "/api/v1/auth/login",
		map[string]string{"email": *u.Email, "password": "password123"}); st != http.StatusUnauthorized {
		t.Fatalf("login with old password: status %d, want 401", st)
	}
	fresh.mustJSON("POST", "/api/v1/auth/login",
		map[string]string{"email": *u.Email, "password": "new-password-1"}, http.StatusOK, nil)

	// Без сессии эндпоинт закрыт.
	anon := newClient(t)
	if st, _ := anon.do("POST", "/api/v1/auth/password/change",
		map[string]string{"current_password": "x", "new_password": "new-password-2"}); st != http.StatusUnauthorized {
		t.Fatalf("anonymous change: status %d, want 401", st)
	}
}
