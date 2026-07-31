-- +goose Up
-- +goose StatementBegin
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- +goose StatementEnd

CREATE TYPE shop_status AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE shop_plan AS ENUM ('free', 'pro');
CREATE TYPE photo_status AS ENUM ('uploading', 'processing', 'ready', 'failed', 'blocked');
CREATE TYPE photo_source AS ENUM ('upload', 'import');
CREATE TYPE lead_channel AS ENUM ('telegram', 'whatsapp', 'max', 'vk');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'canceled', 'expired');
CREATE TYPE complaint_status AS ENUM ('open', 'in_review', 'resolved', 'rejected');

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext UNIQUE,
    password_hash text,
    tg_user_id    bigint UNIQUE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_identity_check CHECK (email IS NOT NULL OR tg_user_id IS NOT NULL)
);

CREATE TABLE shops (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    slug          citext NOT NULL UNIQUE,
    name          text NOT NULL,
    description   text NOT NULL DEFAULT '',
    contacts      jsonb NOT NULL DEFAULT '{}',
    settings      jsonb NOT NULL DEFAULT '{}',
    status        shop_status NOT NULL DEFAULT 'active',
    plan          shop_plan NOT NULL DEFAULT 'free',
    storage_used  bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shops_owner_id_idx ON shops (owner_id);

CREATE TABLE albums (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id        uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    parent_id      uuid REFERENCES albums (id) ON DELETE CASCADE,
    title          text NOT NULL,
    cover_photo_id uuid,
    sort_order     integer NOT NULL DEFAULT 0,
    is_hidden      boolean NOT NULL DEFAULT false,
    password_hash  text,
    photo_count    integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX albums_shop_id_sort_order_idx ON albums (shop_id, sort_order);
CREATE INDEX albums_parent_id_idx ON albums (parent_id);

CREATE TABLE photos (
    -- id одновременно является ключом объекта в S3: orig/{shop_id}/{id}
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    album_id    uuid NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    shop_id     uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    caption     text NOT NULL DEFAULT '',
    caption_tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian', caption)) STORED,
    status      photo_status NOT NULL DEFAULT 'uploading',
    orig_size   bigint NOT NULL DEFAULT 0,
    width       integer NOT NULL DEFAULT 0,
    height      integer NOT NULL DEFAULT 0,
    phash       bigint,
    source      photo_source NOT NULL DEFAULT 'upload',
    sort_order  integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX photos_caption_tsv_idx ON photos USING gin (caption_tsv);
CREATE INDEX photos_album_id_sort_order_idx ON photos (album_id, sort_order);
CREATE INDEX photos_shop_id_idx ON photos (shop_id);

ALTER TABLE albums
    ADD CONSTRAINT albums_cover_photo_id_fkey
    FOREIGN KEY (cover_photo_id) REFERENCES photos (id) ON DELETE SET NULL;

CREATE TABLE lead_clicks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id      uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    photo_id     uuid REFERENCES photos (id) ON DELETE SET NULL,
    channel      lead_channel NOT NULL,
    visitor_hash text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lead_clicks_shop_id_created_at_idx ON lead_clicks (shop_id, created_at);

CREATE TABLE daily_stats (
    shop_id         uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    date            date NOT NULL,
    album_id        uuid REFERENCES albums (id) ON DELETE CASCADE,
    views           bigint NOT NULL DEFAULT 0,
    unique_visitors bigint NOT NULL DEFAULT 0,
    lead_clicks     bigint NOT NULL DEFAULT 0,
    UNIQUE NULLS NOT DISTINCT (shop_id, date, album_id)
);

CREATE TABLE subscriptions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id      uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    plan         shop_plan NOT NULL,
    status       subscription_status NOT NULL DEFAULT 'active',
    period_start timestamptz NOT NULL,
    period_end   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_shop_id_idx ON subscriptions (shop_id);

CREATE TABLE complaints (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id     uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    photo_id    uuid REFERENCES photos (id) ON DELETE SET NULL,
    reason      text NOT NULL,
    status      complaint_status NOT NULL DEFAULT 'open',
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

CREATE INDEX complaints_shop_id_idx ON complaints (shop_id);

-- +goose Down
DROP TABLE complaints;
DROP TABLE subscriptions;
DROP TABLE daily_stats;
DROP TABLE lead_clicks;
ALTER TABLE albums DROP CONSTRAINT albums_cover_photo_id_fkey;
DROP TABLE photos;
DROP TABLE albums;
DROP TABLE shops;
DROP TABLE users;
DROP TYPE complaint_status;
DROP TYPE subscription_status;
DROP TYPE lead_channel;
DROP TYPE photo_source;
DROP TYPE photo_status;
DROP TYPE shop_plan;
DROP TYPE shop_status;
