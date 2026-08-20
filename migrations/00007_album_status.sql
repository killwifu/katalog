-- +goose Up
-- Три статуса вместо булева is_hidden (kit):
--   published — виден на витрине и в списках;
--   unlisted  — «по ссылке»: не в списках, но открывается по прямой ссылке;
--   draft     — не виден покупателю нигде.
CREATE TYPE album_status AS ENUM ('published', 'unlisted', 'draft');

ALTER TABLE albums ADD COLUMN status album_status NOT NULL DEFAULT 'published';

-- Скрытые становятся черновиками: ближайший по смыслу статус,
-- «по ссылке» раньше выразить было нечем.
UPDATE albums SET status = 'draft' WHERE is_hidden;

ALTER TABLE albums DROP COLUMN is_hidden;

CREATE INDEX albums_shop_status_idx ON albums (shop_id, status);

-- +goose Down
ALTER TABLE albums ADD COLUMN is_hidden boolean NOT NULL DEFAULT false;
UPDATE albums SET is_hidden = true WHERE status <> 'published';
ALTER TABLE albums DROP COLUMN status;
DROP TYPE album_status;
