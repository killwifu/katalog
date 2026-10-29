package integration

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"katalog/backend/internal/config"
)

// Регистрация и вход v2 (макеты 04–09).

// fakeOAuth — Яндекс ID и VK ID в одном сервере. Код выдаёт сам тест
// (allow), токен-эндпоинт сверяет PKCE: sha256(code_verifier) == challenge
// из authorize-ссылки, которую построил API.
type fakeOAuth struct {
	srv   *httptest.Server
	mu    sync.Mutex
	codes map[string]fakeGrant // code -> грант
	toks  map[string]fakeGrant // access_token -> грант
}

type fakeGrant struct {
	challenge string
	subject   string
	email     string
}

func newFakeOAuth() *fakeOAuth {
	f := &fakeOAuth{codes: map[string]fakeGrant{}, toks: map[string]fakeGrant{}}
	mux := http.NewServeMux()
	token := func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		g, ok := f.codes[r.Form.Get("code")]
		delete(f.codes, r.Form.Get("code"))
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge {
			f.mu.Unlock()
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		tok := "at-" + r.Form.Get("code")
		f.toks[tok] = g
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": tok, "user_id": 42})
	}
	mux.HandleFunc("POST /yandex/token", token)
	mux.HandleFunc("POST /vk/token", token)
	mux.HandleFunc("GET /yandex/info", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		g, ok := f.toks[strings.TrimPrefix(r.Header.Get("Authorization"), "OAuth ")]
		f.mu.Unlock()
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": g.subject, "default_email": g.email})
	})
	mux.HandleFunc("POST /vk/userinfo", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		g, ok := f.toks[r.Form.Get("access_token")]
		f.mu.Unlock()
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"user_id": g.subject, "email": g.email}})
	})
	f.srv = httptest.NewServer(mux)
	return f
}

func (f *fakeOAuth) providers() map[string]config.OAuthProvider {
	return map[string]config.OAuthProvider{
		"yandex": {ClientID: "ya-id", ClientSecret: "ya-secret", AuthURL: f.srv.URL + "/yandex/authorize",
			TokenURL: f.srv.URL + "/yandex/token", UserInfoURL: f.srv.URL + "/yandex/info"},
		"vk": {ClientID: "vk-id", AuthURL: f.srv.URL + "/vk/authorize",
			TokenURL: f.srv.URL + "/vk/token", UserInfoURL: f.srv.URL + "/vk/userinfo"},
	}
}

// oauthLogin проходит вход: start -> (провайдер «разрешил») -> callback.
// Возвращает адрес, куда API отправил браузер после колбэка.
func oauthLogin(t *testing.T, c *client, provider, query, subject, email string) string {
	t.Helper()
	noFollow := *c.http
	noFollow.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	get := func(path string) *http.Response {
		req, _ := http.NewRequest("GET", env.srv.URL+path, nil)
		req.Header.Set("X-Forwarded-For", c.ip)
		resp, err := noFollow.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
		return resp
	}
	start := get("/api/v1/auth/oauth/" + provider + "/start" + query)
	if start.StatusCode != http.StatusFound {
		t.Fatalf("start: status %d", start.StatusCode)
	}
	loc, _ := url.Parse(start.Header.Get("Location"))
	q := loc.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || q.Get("client_id") == "" {
		t.Fatalf("authorize url без PKCE/state: %s", loc)
	}
	code := fmt.Sprintf("code-%d", clientSeq.Add(1))
	env.oauth.mu.Lock()
	env.oauth.codes[code] = fakeGrant{challenge: q.Get("code_challenge"), subject: subject, email: email}
	env.oauth.mu.Unlock()
	cb := get("/api/v1/auth/oauth/" + provider + "/callback?code=" + code + "&state=" + q.Get("state") + "&device_id=dev1")
	if cb.StatusCode != http.StatusFound {
		t.Fatalf("callback: status %d", cb.StatusCode)
	}
	return cb.Header.Get("Location")
}

type meJSON struct {
	ID            string  `json:"id"`
	Email         *string `json:"email"`
	EmailVerified bool    `json:"email_verified"`
	PendingEmail  *string `json:"pending_email"`
	HasPassword   bool    `json:"has_password"`
}

// Без подтверждённой почты витрину не создать; ссылка из письма
// подтверждает почту, открывает сессию и несёт выбранный тариф.
func TestSignupRequiresVerifiedEmail(t *testing.T) {
	c := newClient(t)
	email := uniqueEmail()
	c.mustJSON("POST", "/api/v1/auth/register",
		map[string]any{"email": email, "password": "password123", "plan": "standard", "period": "year"}, http.StatusCreated, nil)
	status, raw := c.do("POST", "/api/v1/shops", map[string]any{"slug": uniqueSlug(), "name": "S"})
	if status != http.StatusForbidden || !strings.Contains(string(raw), "email_not_verified") {
		t.Fatalf("shop before verification: %d %s", status, raw)
	}
	// Повтор письма — не раньше чем через минуту после первого.
	if status, _ := c.do("POST", "/api/v1/auth/verify-email/resend", map[string]any{}); status != http.StatusTooManyRequests {
		t.Fatalf("resend right after register: %d, want 429", status)
	}

	msg := waitEmail(t, email, "Подтвердите почту")
	if msg.HTML == "" || !strings.Contains(msg.HTML, "Подтвердить почту") {
		t.Fatalf("нет HTML-версии письма: %q", msg.HTML)
	}
	if !strings.Contains(msg.Text, "plan=standard") || !strings.Contains(msg.Text, "period=year") {
		t.Fatalf("тариф не доехал до ссылки: %s", msg.Text)
	}
	token := extractToken(t, msg.Text, "/app/verify-email?token=")
	token, _, _ = strings.Cut(token, "&")

	// Ссылку открыли на другом устройстве — сессия появляется там.
	other := newClient(t)
	var me meJSON
	other.mustJSON("POST", "/api/v1/auth/verify-email", map[string]string{"token": token}, http.StatusOK, &me)
	if !me.EmailVerified {
		t.Fatal("почта не подтверждена")
	}
	createShop(other)
	// Ссылка одноразовая.
	other.mustJSON("POST", "/api/v1/auth/verify-email", map[string]string{"token": token}, http.StatusBadRequest, nil)
}

// «seoulwear@mail» — формально адрес, но без точки в домене: ошибка у поля.
func TestRegisterRejectsDotlessDomain(t *testing.T) {
	c := newClient(t)
	status, raw := c.do("POST", "/api/v1/auth/register", map[string]string{"email": "seoulwear@mail", "password": "password123"})
	if status != http.StatusBadRequest || !strings.Contains(string(raw), "invalid_email") {
		t.Fatalf("got %d %s", status, raw)
	}
}

// После 5 неверных паролей подряд вход закрыт на 15 минут — и с верным
// паролем; сброс пароля снимает блокировку.
func TestLoginLockout(t *testing.T) {
	c := newClient(t)
	u := registerUser(c)
	email := *u.Email
	for i := 1; i <= 5; i++ {
		status, raw := newClient(t).do("POST", "/api/v1/auth/login", map[string]string{"email": email, "password": "wrong-pass"})
		want := http.StatusUnauthorized
		if i == 5 {
			want = http.StatusTooManyRequests
		}
		if status != want {
			t.Fatalf("attempt %d: %d %s, want %d", i, status, raw, want)
		}
	}
	status, raw := newClient(t).do("POST", "/api/v1/auth/login", map[string]string{"email": email, "password": "password123"})
	if status != http.StatusTooManyRequests || !strings.Contains(string(raw), "login_locked") {
		t.Fatalf("correct password while locked: %d %s", status, raw)
	}
	// «Забыли пароль?» работает и при блокировке.
	anon := newClient(t)
	anon.mustJSON("POST", "/api/v1/auth/password/forgot", map[string]string{"email": email}, http.StatusNoContent, nil)
	token := resetTokenFor(t, context.Background(), email)
	anon.mustJSON("POST", "/api/v1/auth/password/reset/check", map[string]string{"token": token}, http.StatusNoContent, nil)
	anon.mustJSON("POST", "/api/v1/auth/password/reset/check", map[string]string{"token": "nope"}, http.StatusBadRequest, nil)
	var out struct {
		Email string `json:"email"`
	}
	anon.mustJSON("POST", "/api/v1/auth/password/reset", map[string]string{"token": token, "password": "newpassword9"}, http.StatusOK, &out)
	if out.Email != email {
		t.Fatalf("reset вернул почту %q, want %q", out.Email, email)
	}
	newClient(t).mustJSON("POST", "/api/v1/auth/login", map[string]string{"email": email, "password": "newpassword9"}, http.StatusOK, nil)
	// Повторный запрос сброса в ту же минуту письма не шлёт, но ответ тот же.
	anon.mustJSON("POST", "/api/v1/auth/password/forgot", map[string]string{"email": email}, http.StatusNoContent, nil)
}

// «Изменить почту» на экране подтверждения удаляет неподтверждённый аккаунт;
// подтверждённый так удалить нельзя.
func TestCancelRegistration(t *testing.T) {
	c := newClient(t)
	email := uniqueEmail()
	c.mustJSON("POST", "/api/v1/auth/register", map[string]string{"email": email, "password": "password123"}, http.StatusCreated, nil)
	c.mustJSON("POST", "/api/v1/auth/register/cancel", map[string]any{}, http.StatusNoContent, nil)
	if status, _ := c.do("GET", "/api/v1/auth/me", nil); status != http.StatusUnauthorized {
		t.Fatalf("session survived cancel: %d", status)
	}
	// Адрес снова свободен.
	c.mustJSON("POST", "/api/v1/auth/register", map[string]string{"email": email, "password": "password123"}, http.StatusCreated, nil)

	v := newClient(t)
	registerUser(v)
	v.mustJSON("POST", "/api/v1/auth/register/cancel", map[string]any{}, http.StatusConflict, nil)
}

// Смена почты: письмо на новую почту, до перехода — pending, после — новая
// почта для входа. Чужая или занятая почта и неверный пароль — отказ.
func TestChangeEmail(t *testing.T) {
	c := newClient(t)
	u := registerUser(c)
	shop := createShop(c)
	other := newClient(t)
	ou := registerUser(other)

	c.mustJSON("POST", "/api/v1/auth/email/change", map[string]string{"email": *ou.Email, "password": "password123"}, http.StatusConflict, nil)
	newEmail := uniqueEmail()
	c.mustJSON("POST", "/api/v1/auth/email/change", map[string]string{"email": newEmail, "password": "wrong-pass"}, http.StatusBadRequest, nil)
	c.mustJSON("POST", "/api/v1/auth/email/change", map[string]string{"email": newEmail, "password": "password123"}, http.StatusNoContent, nil)

	var me meJSON
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if me.PendingEmail == nil || *me.PendingEmail != newEmail || *me.Email != *u.Email {
		t.Fatalf("pending: %+v", me)
	}
	msg := waitEmail(t, newEmail, "Подтвердите новую почту")
	if !strings.Contains(msg.Text, shop.Name) {
		t.Fatalf("в письме нет названия витрины: %s", msg.Text)
	}
	token := extractToken(t, msg.Text, "/app/confirm-email?token=")
	newClient(t).mustJSON("POST", "/api/v1/auth/email/confirm", map[string]string{"token": token}, http.StatusNoContent, nil)
	newClient(t).mustJSON("POST", "/api/v1/auth/email/confirm", map[string]string{"token": token}, http.StatusBadRequest, nil)
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if me.PendingEmail != nil || *me.Email != newEmail || !me.EmailVerified {
		t.Fatalf("after confirm: %+v", me)
	}
	newClient(t).mustJSON("POST", "/api/v1/auth/login", map[string]string{"email": newEmail, "password": "password123"}, http.StatusOK, nil)
}

// Проверка адреса витрины при вводе: свой адрес свободен, чужой занят.
func TestSlugCheck(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	stranger := newClient(t)
	registerUser(stranger)

	check := func(c *client, slug string) map[string]any {
		var out map[string]any
		c.mustJSON("GET", "/api/v1/shops/slug-check?slug="+url.QueryEscape(slug), nil, http.StatusOK, &out)
		return out
	}
	if out := check(stranger, shop.Slug); out["available"] != false || out["error"] != "slug_taken" {
		t.Fatalf("чужой адрес: %v", out)
	}
	if out := check(owner, shop.Slug); out["available"] != true {
		t.Fatalf("свой адрес: %v", out)
	}
	if out := check(stranger, "app"); out["error"] != "slug_reserved" {
		t.Fatalf("служебный адрес: %v", out)
	}
	if out := check(stranger, "a"); out["error"] != "invalid_slug" {
		t.Fatalf("короткий адрес: %v", out)
	}
	if out := check(stranger, uniqueSlug()); out["available"] != true {
		t.Fatalf("свободный адрес: %v", out)
	}
	if status, _ := newClient(t).do("GET", "/api/v1/shops/slug-check?slug=abc", nil); status != http.StatusUnauthorized {
		t.Fatalf("без сессии: %d", status)
	}
}

func TestAuthOptions(t *testing.T) {
	var out struct {
		Providers []string                    `json:"providers"`
		Prices    map[string]map[string]int64 `json:"prices"`
	}
	newClient(t).mustJSON("GET", "/api/v1/auth/options", nil, http.StatusOK, &out)
	if strings.Join(out.Providers, ",") != "yandex,vk" {
		t.Fatalf("providers: %v", out.Providers)
	}
	if out.Prices["standard"]["month"] != 39000 || out.Prices["standard"]["year"] != 351000 {
		t.Fatalf("prices: %v", out.Prices)
	}
}

// Вход через провайдера: новый аккаунт сразу с подтверждённой почтой;
// повторный вход — тот же аккаунт; тариф с лендинга доезжает до кабинета.
func TestOAuthNewUser(t *testing.T) {
	for _, provider := range []string{"yandex", "vk"} {
		t.Run(provider, func(t *testing.T) {
			c := newClient(t)
			email := uniqueEmail()
			sub := fmt.Sprintf("%s-%d", provider, clientSeq.Add(1))
			loc := oauthLogin(t, c, provider, "?trial=1", sub, email)
			if loc != "/app/?trial=1" {
				t.Fatalf("redirect after callback: %q", loc)
			}
			var me meJSON
			c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
			if !me.EmailVerified || me.Email == nil || *me.Email != email || me.HasPassword {
				t.Fatalf("me: %+v", me)
			}
			createShop(c)

			again := newClient(t)
			oauthLogin(t, again, provider, "", sub, "changed-"+email)
			var me2 meJSON
			again.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me2)
			if me2.ID != me.ID {
				t.Fatalf("повторный вход завёл новый аккаунт")
			}
		})
	}
}

// VK без почты — аккаунт всё равно создаётся (по привязке).
func TestOAuthWithoutEmail(t *testing.T) {
	c := newClient(t)
	oauthLogin(t, c, "vk", "", fmt.Sprintf("vk-noemail-%d", clientSeq.Add(1)), "")
	var me meJSON
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if me.Email != nil || !me.EmailVerified {
		t.Fatalf("me: %+v", me)
	}
}

// Почта провайдера совпала с неподтверждённой регистрацией: аккаунт
// привязывается, а пароль, заданный при регистрации (кем угодно), сбрасывается.
func TestOAuthLinksAndDropsUnverifiedPassword(t *testing.T) {
	attacker := newClient(t)
	email := uniqueEmail()
	attacker.mustJSON("POST", "/api/v1/auth/register", map[string]string{"email": email, "password": "attacker-pass"}, http.StatusCreated, nil)

	owner := newClient(t)
	oauthLogin(t, owner, "yandex", "", fmt.Sprintf("ya-%d", clientSeq.Add(1)), email)
	var me meJSON
	owner.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if !me.EmailVerified || me.HasPassword {
		t.Fatalf("me: %+v", me)
	}
	if status, _ := attacker.do("GET", "/api/v1/auth/me", nil); status != http.StatusUnauthorized {
		t.Fatalf("сессия регистрации пережила привязку: %d", status)
	}
	if status, _ := newClient(t).do("POST", "/api/v1/auth/login", map[string]string{"email": email, "password": "attacker-pass"}); status != http.StatusUnauthorized {
		t.Fatalf("старый пароль работает: %d", status)
	}
}

// Колбэк без cookie браузера, начавшего вход (подброшенная ссылка), — назад ко входу.
func TestOAuthStateMismatch(t *testing.T) {
	c := newClient(t)
	noFollow := *c.http
	noFollow.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := noFollow.Get(env.srv.URL + "/api/v1/auth/oauth/yandex/callback?code=x&state=forged")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound || !strings.Contains(resp.Header.Get("Location"), "oauth_error=1") {
		t.Fatalf("got %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if status, _ := c.do("GET", "/api/v1/auth/me", nil); status != http.StatusUnauthorized {
		t.Fatalf("сессия открылась: %d", status)
	}
	if status, _ := c.do("GET", "/api/v1/auth/oauth/max/start", nil); status != http.StatusNotFound {
		t.Fatalf("MAX: %d, want 404", status)
	}
}
