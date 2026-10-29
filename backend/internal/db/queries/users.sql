-- name: CreateUser :one
INSERT INTO users (email, password_hash, tg_user_id)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users
WHERE id = $1;

-- name: GetUserByEmail :one
SELECT * FROM users
WHERE email = $1;

-- name: UpdateUserPassword :exec
UPDATE users
SET password_hash = $2, updated_at = now()
WHERE id = $1;

-- name: DeleteUser :exec
DELETE FROM users
WHERE id = $1;

-- Аккаунт, созданный входом через внешнего провайдера: почта провайдера
-- подтверждена им самим, пароля нет.
-- name: CreateOAuthUser :one
INSERT INTO users (email, email_verified_at)
VALUES ($1, now())
RETURNING *;

-- name: GetUserIdentity :one
SELECT user_id FROM user_identities
WHERE provider = $1 AND subject = $2;

-- name: CreateUserIdentity :exec
INSERT INTO user_identities (provider, subject, user_id, label)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- Подключённые входы аккаунта (Настройки · «Вход через соцсети»).
-- name: ListUserIdentities :many
SELECT provider, label, created_at FROM user_identities
WHERE user_id = $1
ORDER BY created_at;

-- name: UpdateUserPhone :exec
UPDATE users
SET phone = $2, updated_at = now()
WHERE id = $1;

-- Привязка входа через провайдера к аккаунту с неподтверждённой почтой:
-- пароль сбрасывается. Иначе чужой человек мог заранее зарегистрировать
-- адрес владельца со своим паролем и сохранить доступ после его входа.
-- name: VerifyUserDropPassword :exec
UPDATE users
SET email_verified_at = now(), password_hash = NULL, updated_at = now()
WHERE id = $1;

-- Смена почты по ссылке из письма: новая почта сразу подтверждена.
-- name: UpdateUserEmail :exec
UPDATE users
SET email = $2, email_verified_at = now(), updated_at = now()
WHERE id = $1;
