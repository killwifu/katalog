-- Корзина: удаление фотографии перестало быть необратимым.
--
-- Промах по крестику на плитке стоил продавцу снимка навсегда: файл уходил
-- из S3 в том же запросе. Теперь фотография помечается deleted_at, пропадает
-- из кабинета и с витрины, но лежит в «Удаленном», откуда её можно вернуть.
-- Место в хранилище она при этом продолжает занимать — объекты в S3 на месте,
-- и обещать продавцу освобождённую квоту было бы враньём. Окончательно
-- убирает ночной джоб по сроку хранения.

-- +goose Up
ALTER TABLE photos ADD COLUMN deleted_at timestamptz;

-- Частичный индекс: выборки корзины редкие и узкие, а платить за них
-- на каждом чтении альбома (там deleted_at IS NULL) незачем.
CREATE INDEX photos_deleted_at_idx ON photos (shop_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

-- +goose Down
DROP INDEX photos_deleted_at_idx;
ALTER TABLE photos DROP COLUMN deleted_at;
