-- +goose Up
-- Жалоба покупателя с витрины (макет 15 · «Жалоба»): анонимная, на витрину,
-- альбом или фото, причина из списка. Лежит в той же таблице, что и жалоба
-- правообладателя, — модератор разбирает их в одной очереди. У жалобы
-- правообладателя target_type и reason_code пустые (NULL).
-- reason — комментарий покупателя (может быть пустым), content_url —
-- ссылка на объект, собранная сервером.
ALTER TABLE complaints
    ADD COLUMN target_type text CHECK (target_type IN ('shop', 'album', 'photo')),
    ADD COLUMN reason_code text CHECK (reason_code IN
        ('prohibited', 'violence', 'adult', 'fraud', 'counterfeit', 'hate', 'spam', 'other')),
    ADD COLUMN album_id uuid REFERENCES albums (id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE complaints
    DROP COLUMN album_id,
    DROP COLUMN reason_code,
    DROP COLUMN target_type;
