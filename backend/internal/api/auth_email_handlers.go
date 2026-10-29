package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/db"
	"katalog/backend/internal/mail"
	"katalog/backend/internal/tasks"
)

// Почтовые auth-потоки (макеты 05, 07, 09): подтверждение почты после
// регистрации, повторная отправка, сброс пароля, смена почты.
// Одноразовые токены в Redis (auth.Tokens), письма — через очередь email:send.

const (
	tokenPurposeVerify = "everify"
	tokenPurposeReset  = "pwreset"
	// Макет 09: «Ссылка действует 24 часа» (подтверждение) и «1 час» (сброс).
	verifyTokenTTL = 24 * time.Hour
	resetTokenTTL  = time.Hour
	emailChangeTTL = 24 * time.Hour
	// resendInterval — не чаще одного письма в минуту на адрес (макеты 05/07:
	// «Отправить ещё раз через 0:59»).
	resendInterval = time.Minute
)

// sendEmail — постановка письма в очередь; ошибки не валят запрос.
func (a *API) sendEmail(ctx context.Context, to, subject, text string) {
	a.sendTemplate(ctx, to, mail.Template{Subject: subject, Text: text})
}

func (a *API) sendTemplate(ctx context.Context, to string, tpl mail.Template) {
	if to == "" {
		return
	}
	task, err := tasks.NewEmailSend(to, tpl.Subject, tpl.Text, tpl.HTML)
	if err != nil {
		a.Log.Error("build email task failed", "error", err)
		return
	}
	if _, err := a.Tasks.EnqueueContext(ctx, task); err != nil {
		a.Log.Error("enqueue email failed", "to", to, "error", err)
	}
}

// resendAllowed — true, если по ключу письмо не отправлялось последнюю
// минуту (и отмечает отправку). Redis недоступен — не мешаем.
func (a *API) resendAllowed(ctx context.Context, key string) bool {
	ok, err := a.RDB.SetNX(ctx, "resend:"+key, 1, resendInterval).Result()
	if err != nil {
		a.Log.Error("resend limit failed", "error", err)
		return true
	}
	return ok
}

// signupIntent — тариф, с которым продавец пришёл на регистрацию с лендинга
// или из «Тарифов» (макеты 04 · «Пробный период «Про»» и «Выбран тариф»).
// Едет в ссылке из письма, чтобы после подтверждения на другом устройстве
// кабинет всё равно знал, что включить после создания витрины.
type signupIntent struct {
	Plan   string `json:"plan,omitempty"`
	Period string `json:"period,omitempty"`
	Trial  bool   `json:"trial,omitempty"`
}

// query — параметры для ссылки; неизвестные значения отбрасываются.
func (i signupIntent) query() string {
	v := url.Values{}
	if i.Trial {
		v.Set("trial", "1")
	} else if i.Plan == "standard" || i.Plan == "pro" || i.Plan == "business" {
		v.Set("plan", i.Plan)
		if i.Period == "year" {
			v.Set("period", "year")
		}
	}
	if len(v) == 0 {
		return ""
	}
	return "&" + v.Encode()
}

// sendVerificationEmail — письмо «Подтвердите почту» со ссылкой.
func (a *API) sendVerificationEmail(ctx context.Context, user db.User, intent signupIntent) {
	if user.Email == nil {
		return
	}
	token, err := a.Tokens.Create(ctx, tokenPurposeVerify, user.ID, verifyTokenTTL)
	if err != nil {
		a.Log.Error("create verify token failed", "error", err)
		return
	}
	link := a.Cfg.SiteURL + "/app/verify-email?token=" + token + intent.query()
	a.sendTemplate(ctx, *user.Email, mail.VerifyEmail(a.Cfg.SiteURL, *user.Email, link))
}

// handleResendVerification — «Отправить ещё раз» на экране «Подтвердите
// почту» и «Отправить новое письмо» на «Ссылка устарела» (макет 05).
func (a *API) handleResendVerification(w http.ResponseWriter, r *http.Request) {
	var intent signupIntent
	if !decodeJSON(w, r, &intent) {
		return
	}
	user, err := a.Q.GetUserByID(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	if user.EmailVerifiedAt.Valid || user.Email == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !a.resendAllowed(r.Context(), "verify:"+user.ID.String()) {
		apiError(w, http.StatusTooManyRequests, "resend_too_soon", "wait a minute before sending another email")
		return
	}
	a.sendVerificationEmail(r.Context(), user, intent)
	w.WriteHeader(http.StatusNoContent)
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

// handleForgotPassword — запрос сброса пароля. Всегда 204, чтобы не
// раскрывать, зарегистрирован ли email (enumeration). Повтор чаще раза
// в минуту на тот же адрес молча не шлёт письмо.
func (a *API) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	var req forgotPasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	email := normalizeEmail(req.Email)
	if email == "" {
		apiError(w, http.StatusBadRequest, "invalid_email", "invalid email address")
		return
	}
	user, err := a.Q.GetUserByEmail(r.Context(), &email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		a.internalError(w, "load user for reset", err)
		return
	}
	if err == nil && user.PasswordHash != nil && a.resendAllowed(r.Context(), "reset:"+email) {
		token, terr := a.Tokens.Create(r.Context(), tokenPurposeReset, user.ID, resetTokenTTL)
		if terr != nil {
			a.internalError(w, "create reset token", terr)
			return
		}
		link := a.Cfg.SiteURL + "/app/reset-password?token=" + token
		a.sendTemplate(r.Context(), email, mail.ResetPassword(a.Cfg.SiteURL, email, link))
	}
	w.WriteHeader(http.StatusNoContent)
}

type tokenRequest struct {
	Token string `json:"token"`
}

// handleCheckResetToken — жива ли ссылка сброса: экран «Ссылка устарела»
// (макет 07) показывается сразу при открытии, а не после ввода пароля.
func (a *API) handleCheckResetToken(w http.ResponseWriter, r *http.Request) {
	var req tokenRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	ok, err := a.Tokens.Valid(r.Context(), tokenPurposeReset, req.Token)
	if err != nil {
		a.internalError(w, "check reset token", err)
		return
	}
	if !ok {
		apiError(w, http.StatusBadRequest, "invalid_token", "token is invalid, expired or already used")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type resetPasswordRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

// handleResetPassword — установка нового пароля по одноразовому токену.
// Отвечает почтой аккаунта: «Войти» на экране «Пароль изменён» открывает
// вход с подставленной почтой (макет 07).
func (a *API) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var req resetPasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// Длина в символах, а не в байтах (см. handleRegister).
	if !validNewPassword(w, req.Password) {
		return
	}
	uid, err := a.Tokens.Consume(r.Context(), tokenPurposeReset, req.Token)
	if errors.Is(err, auth.ErrNoToken) {
		apiError(w, http.StatusBadRequest, "invalid_token", "token is invalid, expired or already used")
		return
	}
	if err != nil {
		a.internalError(w, "consume reset token", err)
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		a.internalError(w, "hash password", err)
		return
	}
	if err := a.Q.UpdateUserPassword(r.Context(), db.UpdateUserPasswordParams{
		ID:           uid,
		PasswordHash: &hash,
	}); err != nil {
		a.internalError(w, "update password", err)
		return
	}
	// Все прежние сессии закрываем: сброс пароля запрашивают в том числе
	// когда подозревают чужой доступ, и чужая cookie должна перестать
	// работать сразу, а не по истечении TTL.
	if err := a.Sessions.DeleteAllForUser(r.Context(), uid); err != nil {
		a.Log.Error("reset: revoke sessions failed", "user_id", uid, "error", err)
	}
	// И прочие ссылки на сброс: пароль уже новый, старые письма не должны его менять.
	if err := a.Tokens.RevokeAll(r.Context(), tokenPurposeReset, uid); err != nil {
		a.Log.Error("reset: revoke reset tokens failed", "user_id", uid, "error", err)
	}
	user, err := a.Q.GetUserByID(r.Context(), uid)
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	// Ссылка пришла на почту — значит, почта рабочая.
	if !user.EmailVerifiedAt.Valid {
		if err := a.Q.SetUserEmailVerified(r.Context(), uid); err != nil {
			a.Log.Error("reset: set email verified failed", "user_id", uid, "error", err)
		}
	}
	// Блокировку входа после неверных попыток снимаем: пароль новый.
	if user.Email != nil {
		a.RDB.Del(r.Context(), loginFailKey(*user.Email), loginLockKey(*user.Email))
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": user.Email})
}

// handleVerifyEmail — подтверждение почты по ссылке из письма. Ссылка
// заодно открывает сессию: письмо могли открыть на другом устройстве, а
// следующий экран — создание витрины (макет 05, заметка).
func (a *API) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req tokenRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	uid, err := a.Tokens.Consume(r.Context(), tokenPurposeVerify, req.Token)
	if errors.Is(err, auth.ErrNoToken) {
		apiError(w, http.StatusBadRequest, "invalid_token", "token is invalid, expired or already used")
		return
	}
	if err != nil {
		a.internalError(w, "consume verify token", err)
		return
	}
	if err := a.Q.SetUserEmailVerified(r.Context(), uid); err != nil {
		a.internalError(w, "set email verified", err)
		return
	}
	_ = a.Tokens.RevokeAll(r.Context(), tokenPurposeVerify, uid)
	user, err := a.Q.GetUserByID(r.Context(), uid)
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	if !a.startSession(w, r, user) {
		return
	}
	writeJSON(w, http.StatusOK, a.userResponse(r.Context(), user))
}

// handleCancelRegistration — «Изменить почту» на экране «Подтвердите почту»
// (макет 05): только что созданный аккаунт с неподтверждённой почтой и без
// витрины удаляется, продавец возвращается к регистрации с заполненными
// полями. Подтверждённый аккаунт так удалить нельзя.
func (a *API) handleCancelRegistration(w http.ResponseWriter, r *http.Request) {
	// Тело {} обязательно: JSON-тип запроса — защита от межсайтовой формы.
	var empty struct{}
	if !decodeJSON(w, r, &empty) {
		return
	}
	user, err := a.Q.GetUserByID(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	shops, err := a.Q.CountShopsByOwner(r.Context(), user.ID)
	if err != nil {
		a.internalError(w, "count shops", err)
		return
	}
	if user.EmailVerifiedAt.Valid || shops > 0 {
		apiError(w, http.StatusConflict, "already_verified", "account is already confirmed")
		return
	}
	if err := a.Sessions.DeleteAllForUser(r.Context(), user.ID); err != nil {
		a.Log.Error("cancel registration: revoke sessions failed", "error", err)
	}
	_ = a.Tokens.RevokeAll(r.Context(), tokenPurposeVerify, user.ID)
	if err := a.Q.DeleteUser(r.Context(), user.ID); err != nil {
		a.internalError(w, "delete user", err)
		return
	}
	http.SetCookie(w, a.sessionCookie("", -1))
	http.SetCookie(w, a.signedHintCookie("", -1))
	w.WriteHeader(http.StatusNoContent)
}

// Смена почты из «Настроек» (макет 09 · «Подтверждение почты из настроек»):
// новая почта сохраняется только после перехода по ссылке из письма,
// пришедшего на неё. До этого она «ожидает» (pending_email в /auth/me).

func emailChangeKey(token string) string { return "emchg:" + token }
func emailPendingKey(uid uuid.UUID) string {
	return "empending:" + uid.String()
}

type changeEmailRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (a *API) handleChangeEmail(w http.ResponseWriter, r *http.Request) {
	var req changeEmailRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	email, ok := parseNewEmail(req.Email)
	if !ok {
		apiError(w, http.StatusBadRequest, "invalid_email", "invalid email address")
		return
	}
	user, err := a.Q.GetUserByID(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	// Открытая на чужом компьютере сессия не должна позволять увести
	// аккаунт на свою почту: с паролем — только зная его.
	if user.PasswordHash != nil {
		ok, err := auth.VerifyPassword(req.Password, *user.PasswordHash)
		if err != nil || !ok || len([]rune(req.Password)) > maxAccountPassword {
			apiError(w, http.StatusBadRequest, "wrong_password", "current password is wrong")
			return
		}
	}
	if user.Email != nil && strings.EqualFold(*user.Email, email) {
		apiError(w, http.StatusBadRequest, "same_email", "this is the current email")
		return
	}
	if _, err := a.Q.GetUserByEmail(r.Context(), &email); err == nil {
		apiError(w, http.StatusConflict, "email_taken", "email is already registered")
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		a.internalError(w, "check email uniqueness", err)
		return
	}
	if !a.resendAllowed(r.Context(), "emchg:"+user.ID.String()) {
		apiError(w, http.StatusTooManyRequests, "resend_too_soon", "wait a minute before sending another email")
		return
	}
	token, err := auth.NewToken()
	if err != nil {
		a.internalError(w, "generate token", err)
		return
	}
	pipe := a.RDB.TxPipeline()
	pipe.Set(r.Context(), emailChangeKey(token), user.ID.String()+" "+email, emailChangeTTL)
	pipe.Set(r.Context(), emailPendingKey(user.ID), email, emailChangeTTL)
	if _, err := pipe.Exec(r.Context()); err != nil {
		a.internalError(w, "store email change", err)
		return
	}
	shopName := ""
	if shops, err := a.Q.ListShopsByOwner(r.Context(), user.ID); err == nil && len(shops) > 0 {
		shopName = shops[0].Name
	}
	link := a.Cfg.SiteURL + "/app/confirm-email?token=" + token
	a.sendTemplate(r.Context(), email, mail.ConfirmNewEmail(a.Cfg.SiteURL, shopName, link))
	w.WriteHeader(http.StatusNoContent)
}

// handleConfirmEmailChange — переход по ссылке «Подтвердите новую почту».
// Без сессии: письмо могли открыть на телефоне.
func (a *API) handleConfirmEmailChange(w http.ResponseWriter, r *http.Request) {
	var req tokenRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	val, err := a.RDB.GetDel(r.Context(), emailChangeKey(req.Token)).Result()
	if errors.Is(err, redis.Nil) || req.Token == "" {
		apiError(w, http.StatusBadRequest, "invalid_token", "token is invalid, expired or already used")
		return
	}
	if err != nil {
		a.internalError(w, "consume email change", err)
		return
	}
	idStr, email, _ := strings.Cut(val, " ")
	uid, err := uuid.Parse(idStr)
	if err != nil {
		a.internalError(w, "parse email change", err)
		return
	}
	err = a.Q.UpdateUserEmail(r.Context(), db.UpdateUserEmailParams{ID: uid, Email: &email})
	if isUniqueViolation(err) {
		apiError(w, http.StatusConflict, "email_taken", "email is already registered")
		return
	}
	if err != nil {
		a.internalError(w, "update email", err)
		return
	}
	// Ожидающая почта снимается, только если это она (могли запросить другую позже).
	if cur, _ := a.RDB.Get(r.Context(), emailPendingKey(uid)).Result(); cur == email {
		a.RDB.Del(r.Context(), emailPendingKey(uid))
	}
	w.WriteHeader(http.StatusNoContent)
}
