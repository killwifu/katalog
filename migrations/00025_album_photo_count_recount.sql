-- Счётчик фотографий альбома (albums.photo_count) расходился с фактом.
--
-- Его двигали на ±1 по статусу фото, прочитанному до изменения. Блокировка
-- модератором во время обработки не вычитала фото, которое воркер успел
-- сделать готовым; блокировка фото из корзины вычитала его второй раз.
-- photo_count = 0 прячет альбом с витрины, лишняя единица показывает пустой.
-- С этой миграции счётчик пересчитывается запросом RecountAlbumPhotos,
-- здесь — разовое выравнивание накопленного.

-- +goose Up
UPDATE albums a
SET photo_count = c.n
FROM (
    SELECT al.id, (
        SELECT count(*) FROM photos p
        WHERE p.album_id = al.id AND p.status = 'ready'
          AND (p.deleted_at IS NULL OR p.deleted_at = al.deleted_at)
    ) AS n
    FROM albums al
) c
WHERE c.id = a.id AND a.photo_count <> c.n;

-- +goose Down
-- Пересчёт необратим и откатывать его незачем: прежние значения были ошибкой.
SELECT 1;
