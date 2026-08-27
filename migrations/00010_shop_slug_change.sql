-- +goose Up
-- Смена адреса витрины ломает уже разосланные покупателям ссылки, поэтому
-- макет ограничивает её «не чаще раза в полгода». Дату последней смены
-- храним рядом с магазином: без неё ограничение не проверить.
-- NULL = адрес ни разу не меняли.
ALTER TABLE shops ADD COLUMN slug_changed_at timestamptz;

-- +goose Down
ALTER TABLE shops DROP COLUMN slug_changed_at;
