-- +goose Up
-- Ночная агрегация считает лиды за сутки по всем магазинам сразу:
--   WHERE created_at >= $1 AND created_at < $2 GROUP BY shop_id
-- Единственный индекс был (shop_id, created_at) — для выборки без shop_id
-- он бесполезен, и джоб каждую ночь читал таблицу целиком. Таблица растёт
-- с каждым переходом покупателя в мессенджер и не чистится.
CREATE INDEX lead_clicks_created_at_idx ON lead_clicks (created_at);

-- +goose Down
DROP INDEX lead_clicks_created_at_idx;
