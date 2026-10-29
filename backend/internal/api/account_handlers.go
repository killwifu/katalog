package api

import (
	"net/http"
	"regexp"
	"strings"

	"katalog/backend/internal/db"
)

// Личные данные и удаление аккаунта (макет 17 · «Настройки»).

// phonePattern — цифры с +, пробелами, дефисами и скобками; 10–15 цифр
// проверяются отдельно.
var phonePattern = regexp.MustCompile(`^\+?[0-9 ()\-]{10,24}$`)

type updateMeRequest struct {
	Phone *string `json:"phone"`
}

// handleUpdateMe — телефон для связи по вопросам аккаунта. Пустая строка
// убирает его. Покупателям не показывается.
func (a *API) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	var req updateMeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Phone != nil {
		phone := strings.TrimSpace(*req.Phone)
		digits := 0
		for _, c := range phone {
			if c >= '0' && c <= '9' {
				digits++
			}
		}
		if phone != "" && (!phonePattern.MatchString(phone) || digits < 10 || digits > 15) {
			apiError(w, http.StatusBadRequest, "invalid_phone", "phone must be 10-15 digits")
			return
		}
		var value *string
		if phone != "" {
			value = &phone
		}
		if err := a.Q.UpdateUserPhone(r.Context(), db.UpdateUserPhoneParams{ID: userID(r), Phone: value}); err != nil {
			a.internalError(w, "update phone", err)
			return
		}
	}
	user, err := a.Q.GetUserByID(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	writeJSON(w, http.StatusOK, a.userResponse(r.Context(), user))
}

type deleteMeRequest struct {
	Password string `json:"password"`
}

// handleDeleteMe удаляет аккаунт целиком: магазины, альбомы и фото уходят
// каскадом, объекты S3 — задачей уборки. Только с верным паролем: открытая
// на чужом компьютере сессия не должна позволять стереть всё. У аккаунта без
// пароля (вход через Яндекс/VK) его сначала нужно задать.
func (a *API) handleDeleteMe(w http.ResponseWriter, r *http.Request) {
	var req deleteMeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := a.Q.GetUserByID(r.Context(), userID(r))
	if err != nil {
		a.internalError(w, "load user", err)
		return
	}
	if !a.passwordMatches(w, user, req.Password) {
		return
	}
	shops, err := a.Q.ListShopsByOwner(r.Context(), user.ID)
	if err != nil {
		a.internalError(w, "list shops", err)
		return
	}
	if err := a.Q.DeleteUser(r.Context(), user.ID); err != nil {
		a.internalError(w, "delete user", err)
		return
	}
	for _, s := range shops {
		a.purgeStorage(r, s.ID, nil)
		a.Revalidate.Shop(s.Slug)
	}
	if err := a.Sessions.DeleteAllForUser(r.Context(), user.ID); err != nil {
		a.Log.Error("delete account: revoke sessions", "user_id", user.ID, "error", err)
	}
	http.SetCookie(w, a.sessionCookie("", -1))
	http.SetCookie(w, a.signedHintCookie("", -1))
	w.WriteHeader(http.StatusNoContent)
}
