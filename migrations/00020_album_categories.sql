-- Альбом в нескольких категориях (макет v2, экран 14).
--
-- До сих пор у альбома была одна категория (albums.category_id). В макете
-- альбом можно положить сразу в несколько — «Куртки» и «Опт», — а убирая
-- его из одной, продавец оставляет его в остальных. Связь становится
-- многие-ко-многим.
--
-- albums.category_id остаётся как «первая категория» и поддерживается
-- приложением: по ней работают подписи и фильтры, которым достаточно одной.

-- +goose Up
CREATE TABLE album_categories (
    album_id    uuid NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    category_id uuid NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, category_id)
);
CREATE INDEX album_categories_category_idx ON album_categories (category_id);

INSERT INTO album_categories (album_id, category_id)
SELECT id, category_id FROM albums WHERE category_id IS NOT NULL;

-- +goose Down
DROP TABLE album_categories;
