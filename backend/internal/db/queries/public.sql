-- Публичное чтение витрины. Только активные магазины, не скрытые альбомы,
-- фото в статусе ready. Приватные поля наружу не отдаются (см. handlers).

-- Потолок здесь — страховка горячего пути: страница магазина отдаётся
-- на каждый заход покупателя, и число альбомов в ней не должно зависеть
-- от того, сколько их успел наделать продавец. Совпадает с потолком на
-- создание альбомов, так что честный каталог не обрезается.
-- name: ListPublicAlbums :many
SELECT a.id, a.parent_id, a.title, a.sort_order, a.photo_count, a.category_id,
       a.created_at,
       (a.password_hash IS NOT NULL)::boolean AS has_password,
       c.id AS cover_id
FROM albums a
LEFT JOIN photos c ON c.id = a.cover_photo_id AND c.status = 'ready' AND c.deleted_at IS NULL
WHERE a.shop_id = $1 AND a.status = 'published' AND NOT a.hidden_by_plan
  AND NOT a.blocked_by_moderator AND a.deleted_at IS NULL
  -- Подальбом не виднее родителя: скрытый, черновой, закрытый паролем
  -- или снятый модератором родитель уводит из выдачи и свою ветку.
  AND NOT EXISTS (SELECT 1 FROM albums pa WHERE pa.id = a.parent_id
        AND (pa.status <> 'published' OR pa.hidden_by_plan OR pa.blocked_by_moderator
             OR pa.deleted_at IS NOT NULL OR pa.password_hash IS NOT NULL))
-- Пустой альбом покупателю показывать незачем: тап по нему упирается
-- в «здесь пока нет фото». Родителя, у которого фотографии лежат в
-- подальбомах, при этом прятать нельзя — иначе исчезает целая ветка.
  AND (a.photo_count > 0 OR EXISTS (
        SELECT 1 FROM albums ch
        WHERE ch.parent_id = a.id AND ch.status = 'published' AND ch.deleted_at IS NULL
          AND NOT ch.hidden_by_plan AND NOT ch.blocked_by_moderator
          AND ch.photo_count > 0))
ORDER BY a.sort_order, a.created_at
LIMIT 1000;

-- Фолбэк обложки: первое ready-фото каждого альбома магазина
-- (merge с ListPublicAlbums — в handler).
-- name: ListFirstReadyPhotos :many
SELECT DISTINCT ON (album_id) album_id, id
FROM photos
WHERE shop_id = $1 AND status = 'ready' AND deleted_at IS NULL
ORDER BY album_id, sort_order, created_at;

-- name: GetPublicAlbum :one
SELECT a.* FROM albums a
WHERE a.id = $1 AND a.shop_id = $2 AND a.status <> 'draft' AND NOT a.hidden_by_plan
  AND NOT a.blocked_by_moderator AND a.deleted_at IS NULL
  -- Подальбом по прямой ссылке не открывается, если родитель снят с витрины
  -- (черновик, тариф, модератор, корзина). Пароль родителя проверяет handler.
  AND NOT EXISTS (SELECT 1 FROM albums pa WHERE pa.id = a.parent_id
        AND (pa.status = 'draft' OR pa.hidden_by_plan OR pa.blocked_by_moderator
             OR pa.deleted_at IS NOT NULL));

-- name: ListPublicPhotos :many
SELECT * FROM photos
WHERE album_id = $1 AND status = 'ready' AND deleted_at IS NULL
ORDER BY sort_order, created_at, id
LIMIT $2 OFFSET $3;

-- name: CountPublicPhotos :one
SELECT count(*) FROM photos
WHERE album_id = $1 AND status = 'ready' AND deleted_at IS NULL;

-- Поиск по подписям: FTS с русской конфигурацией (основной путь).
-- name: SearchPhotosFTS :many
SELECT p.*,
       ts_rank(p.caption_tsv, websearch_to_tsquery('russian', $2)) AS rank
FROM photos p
JOIN albums a ON a.id = p.album_id
WHERE p.shop_id = $1
  AND p.status = 'ready'
  AND p.deleted_at IS NULL
  AND a.status = 'published'
  AND NOT a.hidden_by_plan
  AND NOT a.blocked_by_moderator
  AND a.deleted_at IS NULL
  -- Подписи из закрытого паролем альбома в поиске выдали бы его содержимое.
  AND a.password_hash IS NULL
  -- Подальбом не виднее родителя: скрытый, черновой, закрытый паролем
  -- или снятый модератором родитель уводит из выдачи и свою ветку.
  AND NOT EXISTS (SELECT 1 FROM albums pa WHERE pa.id = a.parent_id
        AND (pa.status <> 'published' OR pa.hidden_by_plan OR pa.blocked_by_moderator
             OR pa.deleted_at IS NOT NULL OR pa.password_hash IS NOT NULL))
  AND p.caption_tsv @@ websearch_to_tsquery('russian', $2)
ORDER BY rank DESC, p.created_at DESC, p.id
LIMIT $3;

-- Fallback при пустом FTS-результате: pg_trgm по словам подписи
-- (опечатки, частичные совпадения). Порог 0.3 подобран под кириллицу.
-- name: SearchPhotosTrgm :many
SELECT p.*,
       word_similarity($2, p.caption) AS sim
FROM photos p
JOIN albums a ON a.id = p.album_id
WHERE p.shop_id = $1
  AND p.status = 'ready'
  AND p.deleted_at IS NULL
  AND a.status = 'published'
  AND NOT a.hidden_by_plan
  AND NOT a.blocked_by_moderator
  AND a.deleted_at IS NULL
  -- Подписи из закрытого паролем альбома в поиске выдали бы его содержимое.
  AND a.password_hash IS NULL
  -- Подальбом не виднее родителя: скрытый, черновой, закрытый паролем
  -- или снятый модератором родитель уводит из выдачи и свою ветку.
  AND NOT EXISTS (SELECT 1 FROM albums pa WHERE pa.id = a.parent_id
        AND (pa.status <> 'published' OR pa.hidden_by_plan OR pa.blocked_by_moderator
             OR pa.deleted_at IS NOT NULL OR pa.password_hash IS NOT NULL))
  -- %> — индексируемая форма (photos_caption_trgm_idx); порог 0.3 задан для
  -- базы миграцией 00024. Функцией ниже — точная граница «> 0.3», как раньше.
  AND p.caption %> $2
  AND word_similarity($2, p.caption) > 0.3
ORDER BY sim DESC, p.created_at DESC, p.id
LIMIT $3;

-- name: GetActiveShopByID :one
SELECT * FROM shops
WHERE id = $1 AND status = 'active' AND billing_state != 'suspended';

-- name: CreateLeadClick :exec
INSERT INTO lead_clicks (shop_id, photo_id, channel, visitor_hash)
VALUES ($1, $2, $3, $4);

-- Для sitemap: slug и дата обновления активных магазинов.
-- name: ListActiveShopSlugs :many
SELECT slug, updated_at FROM shops
WHERE status = 'active' AND billing_state != 'suspended'
ORDER BY created_at
LIMIT 50000;

-- Подальбомы открытого альбома: покупатель приходит по прямой ссылке на
-- родительскую категорию, и без них видит пустую страницу — вложенные
-- альбомы показывались только на главной магазина.
-- name: ListPublicChildAlbums :many
SELECT a.id, a.parent_id, a.title, a.sort_order, a.photo_count,
       (a.password_hash IS NOT NULL)::boolean AS has_password,
       c.id AS cover_id
FROM albums a
LEFT JOIN photos c ON c.id = a.cover_photo_id AND c.status = 'ready' AND c.deleted_at IS NULL
WHERE a.parent_id = $1 AND a.status = 'published' AND a.deleted_at IS NULL
  AND NOT a.hidden_by_plan AND NOT a.blocked_by_moderator
  -- Глубже двух уровней альбомов не бывает, поэтому здесь достаточно
  -- собственного счётчика.
  AND a.photo_count > 0
ORDER BY a.sort_order, a.created_at, a.id
LIMIT 200;
