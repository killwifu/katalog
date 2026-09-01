-- +goose Up
-- Адрес витрины — это и есть продукт: продавец рассылает ссылку в
-- мессенджерах, печатает на визитках и вкладышах. При смене адреса старый
-- освобождался мгновенно, и любой мог его занять — все разосланные ссылки
-- начинали вести в чужой магазин.
--
-- Освобождённый адрес держим занятым: вернуть его может только прежний
-- владелец, остальным он недоступен, пока ссылки ещё ходят.
CREATE TABLE released_slugs (
    slug        citext PRIMARY KEY,
    shop_id     uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    released_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX released_slugs_released_at_idx ON released_slugs (released_at);

-- +goose Down
DROP TABLE released_slugs;
