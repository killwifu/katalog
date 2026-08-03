-- +goose Up
-- Этап 4: notice-and-takedown, модерация, транзакционная почта.

CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE moderation_action AS ENUM
    ('complaint_status', 'block_photo', 'hide_album', 'suspend_shop', 'unflag_photo');

ALTER TABLE users
    ADD COLUMN role user_role NOT NULL DEFAULT 'user',
    ADD COLUMN email_verified_at timestamptz;

-- Жалоба правообладателя подаётся без auth по произвольной ссылке:
-- shop_id/photo_id заполняются, только если URL удалось распознать.
ALTER TABLE complaints
    ALTER COLUMN shop_id DROP NOT NULL,
    ADD COLUMN reporter_name text NOT NULL DEFAULT '',
    ADD COLUMN reporter_email text NOT NULL DEFAULT '',
    ADD COLUMN content_url text NOT NULL DEFAULT '';

CREATE INDEX complaints_status_created_at_idx ON complaints (status, created_at);

-- Стоп-слова в подписи: флаг ручной проверки модератором (не автоблок).
ALTER TABLE photos ADD COLUMN flagged boolean NOT NULL DEFAULT false;
CREATE INDEX photos_flagged_idx ON photos (updated_at) WHERE flagged;

-- Аудит-лог действий модератора.
CREATE TABLE moderation_log (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    action       moderation_action NOT NULL,
    complaint_id uuid REFERENCES complaints (id) ON DELETE SET NULL,
    shop_id      uuid REFERENCES shops (id) ON DELETE SET NULL,
    album_id     uuid REFERENCES albums (id) ON DELETE SET NULL,
    photo_id     uuid REFERENCES photos (id) ON DELETE SET NULL,
    note         text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_log_created_at_idx ON moderation_log (created_at);

-- +goose Down
DROP TABLE moderation_log;
DROP INDEX photos_flagged_idx;
ALTER TABLE photos DROP COLUMN flagged;
DROP INDEX complaints_status_created_at_idx;
ALTER TABLE complaints
    DROP COLUMN content_url,
    DROP COLUMN reporter_email,
    DROP COLUMN reporter_name;
-- NOT NULL на complaints.shop_id не восстанавливаем: могли появиться NULL.
ALTER TABLE users
    DROP COLUMN email_verified_at,
    DROP COLUMN role;
DROP TYPE moderation_action;
DROP TYPE user_role;
