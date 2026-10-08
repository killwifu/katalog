package api

import (
	"net/http"

	"katalog/backend/internal/auth"
	"katalog/backend/internal/db"
)

// Смена пароля из кабинета. Раньше сменить его можно было только через
// «Забыли пароль» — выйдя из аккаунта и дождавшись письма, а пункт меню
// «Настройки аккаунта» вёл на настройки витрины.

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (a *API) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var req changePasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// Длина в символах, а не в байтах (см. handleRegister).
	if !validNewPassword(w, req.NewPassword) {
		return
	}
	user, err := a.Q.GetUserByID(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	// Открытая на чужом компьютере сессия не должна позволять перехватить
	// аккаунт: без текущего пароля смены нет.
	if user.PasswordHash == nil || len([]rune(req.CurrentPassword)) > maxAccountPassword {
		apiError(w, http.StatusBadRequest, "wrong_password", "current password is wrong")
		return
	}
	ok, err := auth.VerifyPassword(req.CurrentPassword, *user.PasswordHash)
	if err != nil {
		a.internalError(w, "verify password", err)
		return
	}
	if !ok {
		apiError(w, http.StatusBadRequest, "wrong_password", "current password is wrong")
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		a.internalError(w, "hash password", err)
		return
	}
	if err := a.Q.UpdateUserPassword(r.Context(), db.UpdateUserPasswordParams{
		ID:           user.ID,
		PasswordHash: &hash,
	}); err != nil {
		a.internalError(w, "update password", err)
		return
	}
	// Остальные сессии закрываем, как при сбросе: пароль меняют и тогда,
	// когда подозревают чужой доступ. Текущую выдаём заново — продавец
	// остаётся в кабинете.
	if err := a.Sessions.DeleteAllForUser(r.Context(), user.ID); err != nil {
		a.Log.Error("change password: revoke sessions failed", "user_id", user.ID, "error", err)
	}
	if err := a.Tokens.RevokeAll(r.Context(), tokenPurposeReset, user.ID); err != nil {
		a.Log.Error("change password: revoke reset tokens failed", "user_id", user.ID, "error", err)
	}
	if !a.startSession(w, r, user) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
