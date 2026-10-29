-- +goose Up
-- Регистрация и вход v2 (макеты 04–09): обязательное подтверждение почты
-- и вход через Яндекс / VK.

-- Подтверждение почты становится обязательным. Кто зарегистрировался до
-- этого, считается подтверждённым — иначе существующих продавцов выкинуло бы
-- из кабинета на экран «Подтвердите почту».
UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL;

-- Аккаунт, созданный входом через VK, может прийти без почты (у пользователя
-- VK её нет или он не дал доступ) — тогда его опознаёт запись в user_identities.
ALTER TABLE users DROP CONSTRAINT users_identity_check;

-- Внешние аккаунты: (провайдер, id у провайдера) -> наш пользователь.
CREATE TABLE user_identities (
    provider   text        NOT NULL,
    subject    text        NOT NULL,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- +goose Down
DROP TABLE user_identities;
-- Аккаунты без почты и без Telegram ограничение не пропустит — их сначала надо удалить.
ALTER TABLE users ADD CONSTRAINT users_identity_check CHECK (email IS NOT NULL OR tg_user_id IS NOT NULL);
