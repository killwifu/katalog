-- +goose Up
-- Контакты, настройки и аккаунт по макетам 16–17.

-- Канал «Авито» (ссылка на профиль или магазин продавца).
ALTER TYPE lead_channel ADD VALUE IF NOT EXISTS 'avito';

-- Телефон продавца для связи по вопросам аккаунта; покупателям не виден.
ALTER TABLE users ADD COLUMN phone text;

-- Как подписать подключённый вход в «Настройках»: логин Яндекса, имя в VK.
ALTER TABLE user_identities ADD COLUMN label text;

-- Логотип витрины: id картинки, она же ключ S3 (drv/{shop_id}/{logo_id}/small.webp).
ALTER TABLE shops ADD COLUMN logo_id uuid;

-- +goose Down
ALTER TABLE shops DROP COLUMN logo_id;
ALTER TABLE user_identities DROP COLUMN label;
ALTER TABLE users DROP COLUMN phone;
-- Значение enum не удаляется; клики «avito» переводим в vk не будем — оставляем как есть.
