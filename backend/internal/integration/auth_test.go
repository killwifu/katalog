package integration

import (
	"context"
	"fmt"
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

// TestResetPasswordRevokesSessions: смена пароля закрывает прежние сессии.
// Сброс запрашивают в том числе когда подозревают чужой доступ, и cookie
// злоумышленника должна перестать работать сразу, а не по истечении TTL.
func TestResetPasswordRevokesSessions(t *testing.T) {
	ctx := context.Background()
	email := uniqueEmail()

	// Две сессии одного пользователя: «своя» и «угнанная».
	owner := newClient(t)
	owner.mustJSON("POST", "/api/v1/auth/register",
		map[string]string{"email": email, "password": "password123"}, http.StatusCreated, nil)
	intruder := newClient(t)
	intruder.mustJSON("POST", "/api/v1/auth/login",
		map[string]string{"email": email, "password": "password123"}, http.StatusOK, nil)

	if status, _ := intruder.do("GET", "/api/v1/auth/me", nil); status != http.StatusOK {
		t.Fatalf("intruder session not established: status %d", status)
	}

	owner.mustJSON("POST", "/api/v1/auth/password/forgot",
		map[string]string{"email": email}, http.StatusNoContent, nil)

	// Токен сброса читаем прямо из Redis: письмо тут не нужно.
	token := resetTokenFor(t, ctx, email)
	c := newClient(t)
	c.mustJSON("POST", "/api/v1/auth/password/reset",
		map[string]string{"token": token, "password": "newpassword456"}, http.StatusNoContent, nil)

	for name, cl := range map[string]*client{"owner": owner, "intruder": intruder} {
		if status, _ := cl.do("GET", "/api/v1/auth/me", nil); status != http.StatusUnauthorized {
			t.Fatalf("%s session survived password reset: status %d, want 401", name, status)
		}
	}

	// Новый пароль работает.
	fresh := newClient(t)
	fresh.mustJSON("POST", "/api/v1/auth/login",
		map[string]string{"email": email, "password": "newpassword456"}, http.StatusOK, nil)
}

// resetTokenFor находит выданный токен сброса в Redis по user_id.
func resetTokenFor(t *testing.T, ctx context.Context, email string) string {
	t.Helper()
	var uid string
	if err := env.pool.QueryRow(ctx, `SELECT id FROM users WHERE email = $1`, email).Scan(&uid); err != nil {
		t.Fatalf("load user: %v", err)
	}
	keys, err := env.rdb.Keys(ctx, "tok:pwreset:*").Result()
	if err != nil {
		t.Fatalf("scan tokens: %v", err)
	}
	for _, k := range keys {
		if v, err := env.rdb.Get(ctx, k).Result(); err == nil && v == uid {
			return strings.TrimPrefix(k, "tok:pwreset:")
		}
	}
	t.Fatalf("reset token for %s not found", email)
	return ""
}

// TestEmailNormalized: адрес хранится и ищется в голом виде.
// mail.ParseAddress принимает и форму «Имя <a@b>»; раньше такая строка
// уезжала в базу целиком — письма потом не уходили (RCPT TO принимает
// только адрес), и один ящик мог зарегистрироваться дважды.
func TestEmailNormalized(t *testing.T) {
	ctx := context.Background()
	plain := uniqueEmail()

	c := newClient(t)
	var u userJSON
	c.mustJSON("POST", "/api/v1/auth/register",
		map[string]string{"email": "Имя <" + plain + ">", "password": "password123"},
		http.StatusCreated, &u)

	var stored string
	if err := env.pool.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, u.ID).Scan(&stored); err != nil {
		t.Fatalf("read email: %v", err)
	}
	if stored != plain {
		t.Fatalf("сохранён адрес %q, ожидался %q", stored, plain)
	}

	// Тот же ящик повторно — конфликт, в какой бы форме его ни прислали.
	dup := newClient(t)
	if status, raw := dup.do("POST", "/api/v1/auth/register",
		map[string]string{"email": plain, "password": "password123"}); status != http.StatusConflict {
		t.Fatalf("повторная регистрация того же ящика: status %d, want 409; body: %s", status, raw)
	}

	// Вход работает и по голому адресу, и по форме с именем.
	for _, form := range []string{plain, "Имя <" + plain + ">"} {
		login := newClient(t)
		login.mustJSON("POST", "/api/v1/auth/login",
			map[string]string{"email": form, "password": "password123"}, http.StatusOK, nil)
	}
}

// TestTextLimitsCountRunes: лимиты длины считаются в символах, а не байтах.
// Кириллица в UTF-8 занимает два байта, поэтому побайтовый лимит давал
// продавцу вдвое меньше заявленного — при том что кабинет разрешал ввод
// до объявленной длины и сообщение об ошибке называло её же.
func TestTextLimitsCountRunes(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)

	// 150 кириллических символов — это 300 байт, но всего 150 символов.
	title := strings.Repeat("я", 150)
	var al albumJSON
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": title}, http.StatusCreated, &al)
	if al.Title != title {
		t.Fatalf("название сохранено не целиком: %d символов", len([]rune(al.Title)))
	}

	// Ровно за границей — отказ.
	if status, _ := c.do("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": strings.Repeat("я", 201)}); status != http.StatusBadRequest {
		t.Fatalf("название в 201 символ принято: status %d", status)
	}

	// Название магазина — тот же счёт.
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID,
		map[string]any{"name": strings.Repeat("я", 200)}, http.StatusOK, nil)
}

// TestPasswordLengthInRunes: минимальная длина пароля — 8 символов,
// а не 8 байт. По len() кириллический пароль проходил с четырёх символов:
// «абвг» — это ровно восемь байт в UTF-8.
func TestPasswordLengthInRunes(t *testing.T) {
	c := newClient(t)
	email := uniqueEmail()

	status, raw := c.do("POST", "/api/v1/auth/register",
		map[string]string{"email": email, "password": "абвг"})
	if status != http.StatusBadRequest {
		t.Fatalf("пароль из 4 символов принят: status %d, want 400; body: %s", status, raw)
	}

	// Восемь символов кириллицей — проходит.
	c.mustJSON("POST", "/api/v1/auth/register",
		map[string]string{"email": email, "password": "пароль12"}, http.StatusCreated, nil)

	// Тот же счёт и при сбросе пароля: берём настоящий токен из письма
	// (он лежит в Redis, как его туда положил handleForgotPassword).
	c.mustJSON("POST", "/api/v1/auth/password/forgot",
		map[string]string{"email": email}, http.StatusNoContent, nil)
	keys, err := env.rdb.Keys(context.Background(), "tok:pwreset:*").Result()
	if err != nil || len(keys) == 0 {
		t.Fatalf("токен сброса не найден в Redis: %v (%d ключей)", err, len(keys))
	}
	token := strings.TrimPrefix(keys[len(keys)-1], "tok:pwreset:")
	status, raw = c.do("POST", "/api/v1/auth/password/reset",
		map[string]string{"token": token, "password": "абвг"})
	if status != http.StatusBadRequest {
		t.Fatalf("сброс на пароль из 4 символов принят: status %d, want 400; body: %s", status, raw)
	}
}
