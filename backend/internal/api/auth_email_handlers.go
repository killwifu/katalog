package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/db"
	"katalog/backend/internal/tasks"
)

// Почтовые auth-потоки: подтверждение регистрации и сброс пароля.
// Одноразовые токены в Redis (auth.Tokens), письма — через очередь email:send.

const (
	tokenPurposeVerify = "everify"
	tokenPurposeReset  = "pwreset"
	verifyTokenTTL     = 48 * time.Hour
	resetTokenTTL      = time.Hour
)

// sendEmail — постановка письма в очередь; ошибки не валят запрос.
func (a *API) sendEmail(ctx context.Context, to, subject, text string) {
	if to == "" {
		return
	}
	task, err := tasks.NewEmailSend(to, subject, text)
	if err != nil {
		a.Log.Error("build email task failed", "error", err)
		return
	}
	if _, err := a.Tasks.EnqueueContext(ctx, task); err != nil {
		a.Log.Error("enqueue email failed", "to", to, "error", err)
	}
}

// sendVerificationEmail — письмо «подтверждение регистрации» со ссылкой.
func (a *API) sendVerificationEmail(ctx context.Context, user db.User) {
	if user.Email == nil {
		return
	}
	token, err := a.Tokens.Create(ctx, tokenPurposeVerify, user.ID, verifyTokenTTL)
	if err != nil {
		a.Log.Error("create verify token failed", "error", err)
		return
	}
	link := a.Cfg.SiteURL + "/app/verify-email?token=" + token
	a.sendEmail(ctx, *user.Email, "Подтвердите регистрацию в Katalog",
		"Здравствуйте!\n\n"+
			"Вы зарегистрировались в Katalog. Подтвердите ваш email по ссылке:\n"+
			link+"\n\n"+
			"Ссылка действует 48 часов. Если это были не вы — просто проигнорируйте письмо.")
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

// handleForgotPassword — запрос сброса пароля. Всегда 204, чтобы не
// раскрывать, зарегистрирован ли email (enumeration).
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
	if err == nil && user.PasswordHash != nil {
		token, terr := a.Tokens.Create(r.Context(), tokenPurposeReset, user.ID, resetTokenTTL)
		if terr != nil {
			a.internalError(w, "create reset token", terr)
			return
		}
		link := a.Cfg.SiteURL + "/app/reset-password?token=" + token
		a.sendEmail(r.Context(), email, "Сброс пароля в Katalog",
			"Здравствуйте!\n\n"+
				"Вы запросили сброс пароля в Katalog. Задайте новый пароль по ссылке:\n"+
				link+"\n\n"+
				"Ссылка действует 1 час. Если это были не вы — проигнорируйте письмо, "+
				"пароль останется прежним.")
	}
	w.WriteHeader(http.StatusNoContent)
}

type resetPasswordRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

// handleResetPassword — установка нового пароля по одноразовому токену.
func (a *API) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var req resetPasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// Длина в символах, а не в байтах (см. handleRegister).
	if len([]rune(req.Password)) < 8 {
		apiError(w, http.StatusBadRequest, "weak_password", "password must be at least 8 characters")
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
	w.WriteHeader(http.StatusNoContent)
}

type verifyEmailRequest struct {
	Token string `json:"token"`
}

// handleVerifyEmail — подтверждение email по токену из письма регистрации.
func (a *API) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req verifyEmailRequest
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
	w.WriteHeader(http.StatusNoContent)
}
