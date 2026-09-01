-- +goose Up
-- Причина, по которой фото не обработалось. Раньше она только писалась
-- в лог воркера, а продавец видел «Ошибка файла» — в пачке из трёхсот
-- снимков по такому сообщению нечего чинить: формат, размер, битый файл
-- и слишком большое разрешение выглядят одинаково.
ALTER TABLE photos ADD COLUMN fail_reason text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE photos DROP COLUMN fail_reason;
