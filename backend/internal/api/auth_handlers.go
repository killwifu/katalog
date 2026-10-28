package api

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/db"
)

type credentialsRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	signupIntent
}

type userResponse struct {
	ID            string  `json:"id"`
	Email         *string `json:"email"`
	Role          string  `json:"role"`
	EmailVerified bool    `json:"email_verified"`
	// PendingEmail — новая почта из «Настроек», ждущая подтверждения по ссылке.
	PendingEmail *string `json:"pending_email"`
	// HasPassword — false у аккаунта, созданного входом через Яндекс/VK:
	// смена почты и пароля у него не спрашивает текущий пароль.
	HasPassword bool `json:"has_password"`
	// Phone — для связи по вопросам аккаунта (Настройки · «Личные данные»).
	Phone *string `json:"phone"`
	// Identities — подключённые входы через соцсети (Настройки).
	Identities []identityResponse `json:"identities,omitempty"`
}

type identityResponse struct {
	Provider string  `json:"provider"`
	Label    *string `json:"label"`
}

func toUserResponse(u db.User) userResponse {
	return userResponse{
		ID:            u.ID.String(),
		Email:         u.Email,
		Role:          string(u.Role),
		EmailVerified: u.EmailVerifiedAt.Valid,
		HasPassword:   u.PasswordHash != nil,
		Phone:         u.Phone,
	}
}

func (a *API) userResponse(ctx context.Context, u db.User) userResponse {
	resp := toUserResponse(u)
	if p, err := a.RDB.Get(ctx, emailPendingKey(u.ID)).Result(); err == nil && p != "" {
		resp.PendingEmail = &p
	}
	ids, err := a.Q.ListUserIdentities(ctx, u.ID)
	if err != nil {
		a.Log.Warn("list identities", "user_id", u.ID, "error", err)
	}
	resp.Identities = []identityResponse{}
	for _, id := range ids {
		resp.Identities = append(resp.Identities, identityResponse{Provider: id.Provider, Label: id.Label})
	}
	return resp
}

// parseNewEmail — разбор почты для регистрации и смены почты. Сверх
// ParseAddress требует точку в домене: «seoulwear@mail» формально адрес,
// но письмо до него не дойдёт (макет 04 · «Ошибки в полях»).
func parseNewEmail(raw string) (string, bool) {
	email := normalizeEmail(raw)
	_, domain, _ := strings.Cut(email, "@")
	if email == "" || !strings.Contains(domain, ".") || strings.HasSuffix(domain, ".") || strings.HasPrefix(domain, ".") {
		return "", false
	}
	return email, true
}

// Блокировка входа (макет 06 · «Слишком много попыток»): после 5 неверных
// паролей подряд вход на эту почту закрыт на 15 минут — и для верного пароля
// тоже. Считается по почте, а не по IP: перебор идёт с многих адресов.
const (
	loginMaxFails = 5
	loginLockTTL  = 15 * time.Minute
)

func loginFailKey(email string) string { return "loginfail:" + email }
func loginLockKey(email string) string { return "loginlock:" + email }

// loginFailed учитывает неверную попытку; true — почта только что заблокирована.
func (a *API) loginFailed(ctx context.Context, email string) bool {
	n, err := a.RDB.Incr(ctx, loginFailKey(email)).Result()
	if err != nil {
		a.Log.Error("login fail counter failed", "error", err)
		return false
	}
	if n == 1 {
		a.RDB.Expire(ctx, loginFailKey(email), loginLockTTL)
	}
	if n < loginMaxFails {
		return false
	}
	a.RDB.Set(ctx, loginLockKey(email), 1, loginLockTTL)
	a.RDB.Del(ctx, loginFailKey(email))
	return true
}

func loginLocked(w http.ResponseWriter) {
	apiError(w, http.StatusTooManyRequests, "login_locked", "too many failed attempts, try again in 15 minutes")
}

// normalizeEmail приводит адрес к тому виду, в котором он лежит в базе:
// ParseAddress принимает и «Имя <a@b>», а хранить и искать надо голый
// адрес. Пустая строка означает, что разобрать не удалось.
func normalizeEmail(raw string) string {
	addr, err := mail.ParseAddress(strings.ToLower(strings.TrimSpace(raw)))
	if err != nil {
		return ""
	}
	return strings.ToLower(addr.Address)
}

// maxAccountPassword — верхняя граница пароля аккаунта. argon2 хеширует вход
// целиком, и пароль на мегабайт (столько пропускает тело запроса) был бы
// дешёвым способом нагрузить сервер. 128 символов хватает любому менеджеру паролей.
const maxAccountPassword = 128

// dummyPasswordHash — хеш для сверки, когда пользователя нет (выравнивает время).
var dummyPasswordHash = func() string {
	h, err := auth.HashPassword("timing-equalizer-not-a-password")
	if err != nil {
		panic(err)
	}
	return h
}()

// validNewPassword проверяет новый пароль аккаунта (регистрация, сброс, смена).
// Длина в символах, а не в байтах: по len() кириллический пароль проходил
// с четырёх символов — «абвг» это ровно 8 байт.
func validNewPassword(w http.ResponseWriter, password string) bool {
	n := len([]rune(password))
	if n < 8 {
		apiError(w, http.StatusBadRequest, "weak_password", "password must be at least 8 characters")
		return false
	}
	if n > maxAccountPassword {
		apiError(w, http.StatusBadRequest, "password_too_long", "password must be at most 128 characters")
		return false
	}
	return true
}

func (a *API) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// Берём разобранный адрес, а не строку как есть: ParseAddress принимает
	// и форму «Имя <a@b>». Такая строка уезжала в базу целиком — письма
	// потом не уходили (RCPT TO принимает только голый адрес), а один и тот
	// же ящик мог зарегистрироваться дважды в разных формах.
	email, ok := parseNewEmail(req.Email)
	if !ok {
		apiError(w, http.StatusBadRequest, "invalid_email", "invalid email address")
		return
	}
	if !validNewPassword(w, req.Password) {
		return
	}

	if _, err := a.Q.GetUserByEmail(r.Context(), &email); err == nil {
		apiError(w, http.StatusConflict, "email_taken", "email is already registered")
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		a.internalError(w, "check email uniqueness", err)
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		a.internalError(w, "hash password", err)
		return
	}
	user, err := a.Q.CreateUser(r.Context(), db.CreateUserParams{
		Email:        &email,
		PasswordHash: &hash,
	})
	// Проверка выше и вставка не атомарны: параллельные регистрации одного
	// адреса обе проходят проверку, и вторая упиралась в UNIQUE — 500 вместо 409.
	if isUniqueViolation(err) {
		apiError(w, http.StatusConflict, "email_taken", "email is already registered")
		return
	}
	if err != nil {
		a.internalError(w, "create user", err)
		return
	}
	if !a.startSession(w, r, user) {
		return
	}
	// Первое письмо открывает минутный интервал до «Отправить ещё раз».
	a.resendAllowed(r.Context(), "verify:"+user.ID.String())
	a.sendVerificationEmail(r.Context(), user, req.signupIntent)
	writeJSON(w, http.StatusCreated, toUserResponse(user))
}

func (a *API) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// Тот же разбор, что и при регистрации: иначе форма «Имя <a@b>»
	// не совпадёт с сохранённым голым адресом.
	email := normalizeEmail(req.Email)
	if n, _ := a.RDB.Exists(r.Context(), loginLockKey(email)).Result(); n > 0 {
		loginLocked(w)
		return
	}
	// Неверная попытка: 401, а пятая подряд — блокировка.
	fail := func() {
		if a.loginFailed(r.Context(), email) {
			loginLocked(w)
			return
		}
		apiError(w, http.StatusUnauthorized, "invalid_credentials", "wrong email or password")
	}
	// Слишком длинный пароль заведомо не подходит — не хешируем его.
	if len([]rune(req.Password)) > maxAccountPassword {
		fail()
		return
	}
	user, err := a.Q.GetUserByEmail(r.Context(), &email)
	if errors.Is(err, pgx.ErrNoRows) {
		// Тот же argon2, что и для существующего адреса: иначе по времени
		// ответа (2 мс против 35 мс) видно, зарегистрирован ли email.
		_, _ = auth.VerifyPassword(req.Password, dummyPasswordHash)
		fail()
		return
	}
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	if user.PasswordHash == nil {
		fail()
		return
	}
	ok, err := auth.VerifyPassword(req.Password, *user.PasswordHash)
	if err != nil {
		a.internalError(w, "verify password", err)
		return
	}
	if !ok {
		fail()
		return
	}
	a.RDB.Del(r.Context(), loginFailKey(email))
	if !a.startSession(w, r, user) {
		return
	}
	// Почта не подтверждена — кабинет покажет «Подтвердите почту» (макет 05)
	// с таймером, поэтому свежее письмо уходит сразу: прежнее могло истечь.
	if !user.EmailVerifiedAt.Valid && a.resendAllowed(r.Context(), "verify:"+user.ID.String()) {
		a.sendVerificationEmail(r.Context(), user, signupIntent{})
	}
	writeJSON(w, http.StatusOK, toUserResponse(user))
}

func (a *API) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(auth.SessionCookie); err == nil {
		if err := a.Sessions.Delete(r.Context(), cookie.Value); err != nil {
			a.Log.Error("delete session failed", "error", err)
		}
	}
	http.SetCookie(w, a.sessionCookie("", -1))
	http.SetCookie(w, a.signedHintCookie("", -1))
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleMe(w http.ResponseWriter, r *http.Request) {
	user, err := a.Q.GetUserByID(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "load current user", err)
		return
	}
	writeJSON(w, http.StatusOK, a.userResponse(r.Context(), user))
}

func (a *API) startSession(w http.ResponseWriter, r *http.Request, user db.User) bool {
	token, err := a.Sessions.Create(r.Context(), user.ID)
	if err != nil {
		a.internalError(w, "create session", err)
		return false
	}
	http.SetCookie(w, a.sessionCookie(token, int(a.Cfg.SessionTTL.Seconds())))
	http.SetCookie(w, a.signedHintCookie("1", int(a.Cfg.SessionTTL.Seconds())))
	return true
}

func (a *API) sessionCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     auth.SessionCookie,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   a.Cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	}
}

// signedHintCookie — маркер для публичных страниц: httpOnly у него нет
// намеренно, иначе скрипт шапки его не прочитает. Значение — просто "1".
func (a *API) signedHintCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     auth.SignedHintCookie,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: false,
		Secure:   a.Cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	}
}

func (a *API) internalError(w http.ResponseWriter, op string, err error) {
	a.Log.Error(op+" failed", "error", err)
	apiError(w, http.StatusInternalServerError, "internal", "internal error")
}
