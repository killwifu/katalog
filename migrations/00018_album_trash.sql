-- Корзина для альбомов (макет v2 кабинета).
--
-- Удаление альбома уносило его вместе со всеми фотографиями сразу и
-- навсегда — один промах по крестику стоил продавцу каталога. Теперь
-- альбом помечается deleted_at и лежит в «Удаленном» вместе со своими фото
-- (у них тот же deleted_at — по нему восстановление отличает «удалено
-- вместе с альбомом» от «удалено раньше по отдельности»).
--
-- Пароль альбома новой колонки не требует: albums.password_hash заведена
-- ещё в 00001 и до сих пор не использовалась.

-- +goose Up
ALTER TABLE albums ADD COLUMN deleted_at timestamptz;

-- Частичный индекс: корзину смотрят редко, а «deleted_at IS NULL» стоит
-- в каждом чтении альбомов.
CREATE INDEX albums_deleted_at_idx ON albums (shop_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

-- +goose Down
DROP INDEX albums_deleted_at_idx;
ALTER TABLE albums DROP COLUMN deleted_at;
