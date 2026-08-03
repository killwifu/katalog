package api

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"

	"github.com/jackc/pgx/v5"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/db"
)

type credentialsRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type userResponse struct {
	ID            string  `json:"id"`
	Email         *string `json:"email"`
	Role          string  `json:"role"`
	EmailVerified bool    `json:"email_verified"`
}

func toUserResponse(u db.User) userResponse {
	return userResponse{
		ID:            u.ID.String(),
		Email:         u.Email,
		Role:          string(u.Role),
		EmailVerified: u.EmailVerifiedAt.Valid,
	}
}

func (a *API) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if _, err := mail.ParseAddress(email); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_email", "invalid email address")
		return
	}
	if len(req.Password) < 8 {
		apiError(w, http.StatusBadRequest, "weak_password", "password must be at least 8 characters")
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
	if err != nil {
		a.internalError(w, "create user", err)
		return
	}
	if !a.startSession(w, r, user) {
		return
	}
	a.sendVerificationEmail(r.Context(), user)
	writeJSON(w, http.StatusCreated, toUserResponse(user))
}

func (a *API) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	user, err := a.Q.GetUserByEmail(r.Context(), &email)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, http.StatusUnauthorized, "invalid_credentials", "wrong email or password")
		return
	}
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	if user.PasswordHash == nil {
		apiError(w, http.StatusUnauthorized, "invalid_credentials", "wrong email or password")
		return
	}
	ok, err := auth.VerifyPassword(req.Password, *user.PasswordHash)
	if err != nil {
		a.internalError(w, "verify password", err)
		return
	}
	if !ok {
		apiError(w, http.StatusUnauthorized, "invalid_credentials", "wrong email or password")
		return
	}
	if !a.startSession(w, r, user) {
		return
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
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleMe(w http.ResponseWriter, r *http.Request) {
	user, err := a.Q.GetUserByID(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "load current user", err)
		return
	}
	writeJSON(w, http.StatusOK, toUserResponse(user))
}

func (a *API) startSession(w http.ResponseWriter, r *http.Request, user db.User) bool {
	token, err := a.Sessions.Create(r.Context(), user.ID)
	if err != nil {
		a.internalError(w, "create session", err)
		return false
	}
	http.SetCookie(w, a.sessionCookie(token, int(a.Cfg.SessionTTL.Seconds())))
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

func (a *API) internalError(w http.ResponseWriter, op string, err error) {
	a.Log.Error(op+" failed", "error", err)
	apiError(w, http.StatusInternalServerError, "internal", "internal error")
}
