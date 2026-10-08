-- Видимость категорий (макет v2, экран 14 · меню «⋯»).
--
-- is_hidden — «Скрыть с витрины»: покупатель не видит категорию ни в меню,
-- ни по её адресу. Альбомы при этом остаются доступны — по ссылке и на
-- вкладке «Альбомы». Продавцу это нужно, чтобы собирать категорию не на
-- глазах у покупателей.
--
-- on_home — «На главной»: категория показывается блоком на главной
-- странице витрины. По умолчанию включено — так главная собирается сама.

-- +goose Up
ALTER TABLE categories ADD COLUMN is_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE categories ADD COLUMN on_home boolean NOT NULL DEFAULT true;

-- +goose Down
ALTER TABLE categories DROP COLUMN on_home;
ALTER TABLE categories DROP COLUMN is_hidden;
