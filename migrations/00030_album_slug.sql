-- +goose Up
-- Адрес альбома на витрине по слагу: /{shop}/{album_slug} вместо
-- /{shop}/a/{uuid} (макет 15). Слаг — транслит названия, уникален в
-- пределах магазина и при переименовании не меняется: ссылки на альбом
-- уже разосланы покупателям в мессенджеры, и они не должны ломаться.

-- Транслит как у слагов категорий в кабинете (CategoriesPage.slugify);
-- латиница с диакритикой — без неё (Stüssy → stussy).
-- +goose StatementBegin
CREATE FUNCTION album_slug_base(title text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(nullif(regexp_replace(left(trim(BOTH '-' FROM regexp_replace(
        replace(replace(replace(replace(replace(replace(replace(replace(
            translate(lower(title),
                'абвгдеёзийклмнопрстуфхцыэàáâäãåçèéêëìíîïñòóôöõøùúûüýÿ',
                'abvgdeeziyklmnoprstufhcyeaaaaaaceeeeiiiinoooooouuuuyy'),
            'ж', 'zh'), 'ч', 'ch'), 'ш', 'sh'), 'щ', 'sch'),
            'ю', 'yu'), 'я', 'ya'), 'ъ', ''), 'ь', ''),
        '[^a-z0-9]+', '-', 'g')), 60), '-+$', ''), ''), 'album')
$$;
-- +goose StatementEnd

-- Свободный слаг в магазине: base, base-2, base-3… Слова, занятые путями
-- витрины (/{shop}/a/…, /c/, /p/, /t/, /search), альбому не достаются.
-- Слаг альбома в корзине остаётся за ним: альбом вернётся по старой ссылке.
-- +goose StatementBegin
CREATE FUNCTION album_slug_free(p_shop uuid, p_title text, p_self uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    base text := album_slug_base(p_title);
    cand text := base;
    n int := 1;
BEGIN
    WHILE cand IN ('a', 'c', 'p', 't', 'search')
       OR EXISTS (SELECT 1 FROM albums WHERE shop_id = p_shop AND slug = cand AND id <> p_self) LOOP
        n := n + 1;
        cand := base || '-' || n;
    END LOOP;
    RETURN cand;
END
$$;
-- +goose StatementEnd

ALTER TABLE albums ADD COLUMN slug text;

-- По строке за оператор: каждый следующий видит слаги, выданные до него
-- (у старшего альбома — слаг без номера).
-- +goose StatementBegin
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT id, shop_id, title FROM albums ORDER BY created_at, id LOOP
        UPDATE albums SET slug = album_slug_free(r.shop_id, r.title, r.id) WHERE id = r.id;
    END LOOP;
END
$$;
-- +goose StatementEnd

-- Любая вставка получает слаг сама — кабинет, сид и тесты, вставляющие
-- альбомы напрямую. Конкурентные вставки в один магазин сериализует замок
-- магазина (inOrderLock); уникальный индекс — последняя страховка.
-- +goose StatementBegin
CREATE FUNCTION albums_set_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.slug IS NULL THEN
        NEW.slug := album_slug_free(NEW.shop_id, NEW.title, NEW.id);
    END IF;
    RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER albums_set_slug BEFORE INSERT ON albums
FOR EACH ROW EXECUTE FUNCTION albums_set_slug();

ALTER TABLE albums ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX albums_shop_slug_key ON albums (shop_id, slug);

-- +goose Down
DROP TRIGGER albums_set_slug ON albums;
DROP FUNCTION albums_set_slug();
DROP INDEX albums_shop_slug_key;
ALTER TABLE albums DROP COLUMN slug;
DROP FUNCTION album_slug_free(uuid, text, uuid);
DROP FUNCTION album_slug_base(text);
