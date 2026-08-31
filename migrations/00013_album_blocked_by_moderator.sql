-- +goose Up
-- Модератор скрывал альбом, переводя его в draft, — то есть тем же полем,
-- которым управляет сам продавец. Продавец, на которого и пришла жалоба,
-- возвращал альбом на витрину одним переключателем в кабинете.
--
-- Отдельный флаг, как blocked у фотографий: продавец его не меняет,
-- витрина не показывает альбом независимо от статуса.
ALTER TABLE albums ADD COLUMN blocked_by_moderator boolean NOT NULL DEFAULT false;

-- Частичный индекс: выборки витрины отсекают заблокированные, а таких
-- в норме единицы.
CREATE INDEX albums_blocked_idx ON albums (shop_id) WHERE blocked_by_moderator;

-- +goose Down
DROP INDEX albums_blocked_idx;
ALTER TABLE albums DROP COLUMN blocked_by_moderator;
