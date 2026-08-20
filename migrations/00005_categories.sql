-- +goose Up
-- Категория — классификация альбома (kit: «Категория ≠ секция главной»).
-- У альбома категория одна; вложенность, как и у альбомов, максимум 2 уровня
-- (проверяется в handler'е: родитель сам не может быть вложенным).
CREATE TABLE categories (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id    uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    parent_id  uuid REFERENCES categories (id) ON DELETE CASCADE,
    title      text NOT NULL,
    slug       citext NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shop_id, slug)
);

CREATE INDEX categories_shop_parent_idx ON categories (shop_id, parent_id, sort_order);

-- ON DELETE SET NULL, а не CASCADE: удаление категории не должно уносить
-- альбомы. Продавцу предлагается перенести их или оставить без категории.
ALTER TABLE albums ADD COLUMN category_id uuid REFERENCES categories (id) ON DELETE SET NULL;
CREATE INDEX albums_category_idx ON albums (category_id) WHERE category_id IS NOT NULL;

-- +goose Down
DROP INDEX albums_category_idx;
ALTER TABLE albums DROP COLUMN category_id;
DROP TABLE categories;
