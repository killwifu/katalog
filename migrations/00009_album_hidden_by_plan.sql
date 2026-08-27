-- +goose Up
-- Понижение тарифа: лишние альбомы скрываются, но НЕ удаляются и не
-- становятся черновиками. Отдельный флаг, а не status: черновик ставит
-- продавец сам, и при возврате подписки его нельзя опубликовать обратно
-- скопом — а скрытые тарифом альбомы вернуть надо ровно все.
ALTER TABLE albums ADD COLUMN hidden_by_plan boolean NOT NULL DEFAULT false;

CREATE INDEX albums_hidden_by_plan_idx ON albums (shop_id) WHERE hidden_by_plan;

-- +goose Down
DROP INDEX albums_hidden_by_plan_idx;
ALTER TABLE albums DROP COLUMN hidden_by_plan;
