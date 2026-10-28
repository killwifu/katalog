package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/config"
	"katalog/backend/internal/db"
)

// Вход через Яндекс и VK (макеты 04 и 06 · «Войти с помощью»): OAuth 2.0
// authorization code + PKCE (S256) + state. state живёт в Redis и в cookie
// браузера, начавшего вход: колбэк, пришедший в другой браузер (подброшенная
// ссылка), отвергается. Впервые вошедший так продавец получает аккаунт сразу
// с подтверждённой почтой и попадает на создание витрины.
//
// MAX публичного OAuth для сторонних сайтов не предоставляет (dev.max.ru:
// боты, мини-приложения и «Цифровой ID» для юрлиц) — кнопки нет.

const (
	oauthStateCookie = "katalog_oauth"
	oauthStateTTL    = 10 * time.Minute
)

// oauthOrder — порядок кнопок на экранах входа.
var oauthOrder = []string{"yandex", "vk"}

func (a *API) oauthProvider(name string) (config.OAuthProvider, bool) {
	p, ok := a.Cfg.OAuth[name]
	if !ok || p.ClientID == "" || (name == "yandex" && p.ClientSecret == "") {
		return config.OAuthProvider{}, false
	}
	return p, true
}

func (a *API) oauthRedirectURI(provider string) string {
	return strings.TrimRight(a.Cfg.SiteURL, "/") + "/api/v1/auth/oauth/" + provider + "/callback"
}

// handleAuthOptions — включённые провайдеры и месячные цены тарифов
// (для плашки выбранного тарифа на регистрации, когда магазина ещё нет).
func (a *API) handleAuthOptions(w http.ResponseWriter, _ *http.Request) {
	providers := []string{}
	for _, name := range oauthOrder {
		if _, ok := a.oauthProvider(name); ok {
			providers = append(providers, name)
		}
	}
	prices := map[string]map[string]int64{}
	for _, plan := range []string{"standard", "pro", "business"} {
		prices[plan] = map[string]int64{
			"month": a.Cfg.Billing.Price(plan, false),
			"year":  a.Cfg.Billing.Price(plan, true),
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": providers, "prices": prices})
}

type oauthState struct {
	Provider string       `json:"provider"`
	Verifier string       `json:"verifier"`
	Intent   signupIntent `json:"intent"`
	// LinkUser — «Подключить» в Настройках: привязать вход к этому
	// аккаунту, а не входить (макет 17 · «Вход через соцсети»).
	LinkUser uuid.UUID `json:"link_user,omitempty"`
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (a *API) handleOAuthStart(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "provider")
	p, ok := a.oauthProvider(name)
	if !ok {
		apiError(w, http.StatusNotFound, "not_found", "provider is not configured")
		return
	}
	state, err := auth.NewToken()
	if err != nil {
		a.internalError(w, "oauth state", err)
		return
	}
	verifier, err := auth.NewToken()
	if err != nil {
		a.internalError(w, "oauth verifier", err)
		return
	}
	q := r.URL.Query()
	st := oauthState{Provider: name, Verifier: verifier, Intent: signupIntent{
		Plan: q.Get("plan"), Period: q.Get("period"), Trial: q.Get("trial") == "1",
	}}
	if q.Get("link") == "1" {
		uid, ok := a.sessionUser(r)
		if !ok {
			http.Redirect(w, r, "/app/login?redirect=%2Fsettings", http.StatusFound)
			return
		}
		st.LinkUser = uid
	}
	raw, _ := json.Marshal(st)
	if err := a.RDB.Set(r.Context(), "oauth:"+state, raw, oauthStateTTL).Err(); err != nil {
		a.internalError(w, "store oauth state", err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: oauthStateCookie, Value: state, Path: "/api/v1/auth/oauth",
		MaxAge: int(oauthStateTTL.Seconds()), HttpOnly: true, Secure: a.Cfg.CookieSecure,
		// Lax: колбэк — переход верхнего уровня с сайта провайдера.
		SameSite: http.SameSiteLaxMode,
	})
	v := url.Values{
		"response_type":         {"code"},
		"client_id":             {p.ClientID},
		"redirect_uri":          {a.oauthRedirectURI(name)},
		"state":                 {state},
		"code_challenge":        {pkceChallenge(verifier)},
		"code_challenge_method": {"S256"},
	}
	if p.Scope != "" {
		v.Set("scope", p.Scope)
	}
	sep := "?"
	if strings.Contains(p.AuthURL, "?") {
		sep = "&"
	}
	http.Redirect(w, r, p.AuthURL+sep+v.Encode(), http.StatusFound)
}

// oauthProfile — что нужно от провайдера: постоянный id и подтверждённая почта.
type oauthProfile struct {
	Subject string
	Email   string
	// Label — как подписать вход в Настройках: логин Яндекса, имя в VK.
	Label string
}

func (a *API) handleOAuthCallback(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "provider")
	fail := func(reason string, err error) {
		if err != nil {
			a.Log.Warn("oauth login failed", "provider", name, "reason", reason, "error", err)
		}
		http.Redirect(w, r, "/app/login?oauth_error=1", http.StatusFound)
	}
	p, ok := a.oauthProvider(name)
	if !ok {
		fail("not configured", nil)
		return
	}
	q := r.URL.Query()
	state := q.Get("state")
	cookie, err := r.Cookie(oauthStateCookie)
	if state == "" || err != nil || cookie.Value != state {
		fail("state mismatch", nil)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oauthStateCookie, Value: "", Path: "/api/v1/auth/oauth", MaxAge: -1, HttpOnly: true, Secure: a.Cfg.CookieSecure, SameSite: http.SameSiteLaxMode})
	raw, err := a.RDB.GetDel(r.Context(), "oauth:"+state).Bytes()
	if err != nil {
		fail("state expired", nil)
		return
	}
	var st oauthState
	if err := json.Unmarshal(raw, &st); err != nil || st.Provider != name {
		fail("state provider", err)
		return
	}
	code := q.Get("code")
	if code == "" {
		// Отказ на стороне провайдера (error=access_denied) — просто назад ко входу.
		fail("no code", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	var prof oauthProfile
	switch name {
	case "yandex":
		prof, err = yandexProfile(ctx, p, code, st.Verifier)
	case "vk":
		prof, err = vkProfile(ctx, p, code, st.Verifier, q.Get("device_id"), state, a.oauthRedirectURI(name))
	}
	if err == nil && prof.Subject == "" {
		err = errors.New("empty subject")
	}
	if err != nil {
		fail("provider exchange", err)
		return
	}
	if st.LinkUser != uuid.Nil {
		http.Redirect(w, r, a.oauthLink(r.Context(), name, prof, st.LinkUser), http.StatusFound)
		return
	}
	user, err := a.oauthUser(r.Context(), name, prof)
	if err != nil {
		fail("link user", err)
		return
	}
	if !a.startSession(w, r, user) {
		return
	}
	http.Redirect(w, r, "/app/"+strings.Replace(st.Intent.query(), "&", "?", 1), http.StatusFound)
}

// oauthLink привязывает вход через провайдера к аккаунту из Настроек и
// возвращает, куда вернуть продавца. Уже привязанный к другому аккаунту —
// ошибка «Этот аккаунт уже подключён к другой витрине» (макет 17).
func (a *API) oauthLink(ctx context.Context, provider string, prof oauthProfile, userID uuid.UUID) string {
	back := "/app/settings?oauth_linked=" + provider + "#account"
	uid, err := a.Q.GetUserIdentity(ctx, db.GetUserIdentityParams{Provider: provider, Subject: prof.Subject})
	switch {
	case err == nil && uid == userID:
		return back
	case err == nil:
		return "/app/settings?oauth_error=taken#account"
	case !errors.Is(err, pgx.ErrNoRows):
		a.Log.Error("oauth link: get identity", "error", err)
		return "/app/settings?oauth_error=1#account"
	}
	if err := a.Q.CreateUserIdentity(ctx, db.CreateUserIdentityParams{
		Provider: provider, Subject: prof.Subject, UserID: userID, Label: labelPtr(prof.Label),
	}); err != nil {
		a.Log.Error("oauth link: create identity", "error", err)
		return "/app/settings?oauth_error=1#account"
	}
	return back
}

func labelPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// sessionUser — пользователь текущей сессии на публичной ручке (без requireAuth).
func (a *API) sessionUser(r *http.Request) (uuid.UUID, bool) {
	cookie, err := r.Cookie(auth.SessionCookie)
	if err != nil {
		return uuid.Nil, false
	}
	uid, err := a.Sessions.Get(r.Context(), cookie.Value)
	return uid, err == nil
}

// oauthUser находит или заводит аккаунт: сначала по привязке (провайдер, id),
// потом по почте провайдера (привязка к существующему аккаунту), иначе новый.
func (a *API) oauthUser(ctx context.Context, provider string, prof oauthProfile) (db.User, error) {
	uid, err := a.Q.GetUserIdentity(ctx, db.GetUserIdentityParams{Provider: provider, Subject: prof.Subject})
	if err == nil {
		return a.Q.GetUserByID(ctx, uid)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, fmt.Errorf("get identity: %w", err)
	}
	var user db.User
	email := normalizeEmail(prof.Email)
	if email != "" {
		user, err = a.Q.GetUserByEmail(ctx, &email)
		switch {
		case err == nil:
			if !user.EmailVerifiedAt.Valid {
				// Почту владеет тот, кто вошёл через провайдера. Пароль, заданный
				// при неподтверждённой регистрации, мог задать кто угодно —
				// сбрасываем его и закрываем чужие сессии.
				if err := a.Q.VerifyUserDropPassword(ctx, user.ID); err != nil {
					return db.User{}, fmt.Errorf("verify linked user: %w", err)
				}
				_ = a.Sessions.DeleteAllForUser(ctx, user.ID)
			}
		case errors.Is(err, pgx.ErrNoRows):
			user, err = a.Q.CreateOAuthUser(ctx, &email)
			if err != nil {
				return db.User{}, fmt.Errorf("create user: %w", err)
			}
		default:
			return db.User{}, fmt.Errorf("get user by email: %w", err)
		}
	} else {
		user, err = a.Q.CreateOAuthUser(ctx, nil)
		if err != nil {
			return db.User{}, fmt.Errorf("create user: %w", err)
		}
	}
	if err := a.Q.CreateUserIdentity(ctx, db.CreateUserIdentityParams{
		Provider: provider, Subject: prof.Subject, UserID: user.ID, Label: labelPtr(prof.Label),
	}); err != nil {
		return db.User{}, fmt.Errorf("create identity: %w", err)
	}
	return a.Q.GetUserByID(ctx, user.ID)
}

var oauthHTTP = &http.Client{Timeout: 10 * time.Second}

// oauthJSON — запрос к провайдеру с разбором JSON-ответа.
func oauthJSON(req *http.Request, out any) error {
	resp, err := oauthHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: status %d: %.200s", req.URL.Host, resp.StatusCode, body)
	}
	return json.Unmarshal(body, out)
}

func postForm(ctx context.Context, u string, v url.Values) *http.Request {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(v.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return req
}

// yandexProfile: https://yandex.ru/dev/id/doc/ru/codes/code-url и
// https://yandex.ru/dev/id/doc/ru/user-information. default_email — адрес
// Яндекс ID, подтверждённый Яндексом.
func yandexProfile(ctx context.Context, p config.OAuthProvider, code, verifier string) (oauthProfile, error) {
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := oauthJSON(postForm(ctx, p.TokenURL, url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"client_id": {p.ClientID}, "client_secret": {p.ClientSecret}, "code_verifier": {verifier},
	}), &tok); err != nil {
		return oauthProfile{}, fmt.Errorf("token: %w", err)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.UserInfoURL, nil)
	req.Header.Set("Authorization", "OAuth "+tok.AccessToken)
	var info struct {
		ID           string `json:"id"`
		DefaultEmail string `json:"default_email"`
		Login        string `json:"login"`
	}
	if err := oauthJSON(req, &info); err != nil {
		return oauthProfile{}, fmt.Errorf("userinfo: %w", err)
	}
	return oauthProfile{Subject: info.ID, Email: info.DefaultEmail, Label: info.Login}, nil
}

// vkProfile: VK ID OAuth 2.1 — обмен кода с code_verifier и device_id из
// колбэка, затем /oauth2/user_info. Почты может не быть (не дал доступ).
func vkProfile(ctx context.Context, p config.OAuthProvider, code, verifier, deviceID, state, redirectURI string) (oauthProfile, error) {
	var tok struct {
		AccessToken string `json:"access_token"`
		UserID      int64  `json:"user_id"`
	}
	if err := oauthJSON(postForm(ctx, p.TokenURL, url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier},
		"client_id": {p.ClientID}, "device_id": {deviceID}, "redirect_uri": {redirectURI}, "state": {state},
	}), &tok); err != nil {
		return oauthProfile{}, fmt.Errorf("token: %w", err)
	}
	var info struct {
		User struct {
			// Строка или число — в документации VK ID встречается и то и другое.
			UserID    json.RawMessage `json:"user_id"`
			Email     string          `json:"email"`
			FirstName string          `json:"first_name"`
			LastName  string          `json:"last_name"`
		} `json:"user"`
	}
	if err := oauthJSON(postForm(ctx, p.UserInfoURL, url.Values{
		"client_id": {p.ClientID}, "access_token": {tok.AccessToken},
	}), &info); err != nil {
		return oauthProfile{}, fmt.Errorf("userinfo: %w", err)
	}
	sub := strings.Trim(string(info.User.UserID), `"`)
	if sub == "null" {
		sub = ""
	}
	if sub == "" && tok.UserID != 0 {
		sub = strconv.FormatInt(tok.UserID, 10)
	}
	label := strings.TrimSpace(info.User.FirstName + " " + info.User.LastName)
	return oauthProfile{Subject: sub, Email: info.User.Email, Label: label}, nil
}
