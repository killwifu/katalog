-- Порядок альбомов внутри категории (макет v2, экран 14: «Порядок альбомов
-- внутри категории или подкатегории — перетаскиванием карточки. В этом
-- порядке альбомы показываются на витрине»).
--
-- Место альбома у каждой категории своё: один и тот же альбом может стоять
-- первым в «Куртках» и последним в «Опте», поэтому номер живёт в связи,
-- а не в albums.sort_order.

-- +goose Up
ALTER TABLE album_categories ADD COLUMN sort_order int NOT NULL DEFAULT 0;

-- Существующие связи получают номера в том порядке, в каком альбомы
-- стояли до сих пор (по порядку альбомов магазина).
UPDATE album_categories ac
SET sort_order = numbered.pos
FROM (
    SELECT ac2.album_id, ac2.category_id,
           row_number() OVER (PARTITION BY ac2.category_id ORDER BY a.sort_order, a.created_at DESC) AS pos
    FROM album_categories ac2
    JOIN albums a ON a.id = ac2.album_id
) numbered
WHERE ac.album_id = numbered.album_id AND ac.category_id = numbered.category_id;

-- +goose Down
ALTER TABLE album_categories DROP COLUMN sort_order;
