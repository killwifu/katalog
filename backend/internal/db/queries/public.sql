-- Публичное чтение витрины. Только активные магазины, не скрытые альбомы,
-- фото в статусе ready. Приватные поля наружу не отдаются (см. handlers).

-- name: ListPublicAlbums :many
SELECT a.id, a.parent_id, a.title, a.sort_order, a.photo_count,
       c.id AS cover_id
FROM albums a
LEFT JOIN photos c ON c.id = a.cover_photo_id AND c.status = 'ready'
WHERE a.shop_id = $1 AND a.status = 'published' AND NOT a.hidden_by_plan
ORDER BY a.sort_order, a.created_at;

-- Фолбэк обложки: первое ready-фото каждого альбома магазина
-- (merge с ListPublicAlbums — в handler).
-- name: ListFirstReadyPhotos :many
SELECT DISTINCT ON (album_id) album_id, id
FROM photos
WHERE shop_id = $1 AND status = 'ready'
ORDER BY album_id, sort_order, created_at;

-- name: GetPublicAlbum :one
SELECT * FROM albums
WHERE id = $1 AND shop_id = $2 AND status <> 'draft' AND NOT hidden_by_plan;

-- name: ListPublicPhotos :many
SELECT * FROM photos
WHERE album_id = $1 AND status = 'ready'
ORDER BY sort_order, created_at, id
LIMIT $2 OFFSET $3;

-- name: CountPublicPhotos :one
SELECT count(*) FROM photos
WHERE album_id = $1 AND status = 'ready';

-- Поиск по подписям: FTS с русской конфигурацией (основной путь).
-- name: SearchPhotosFTS :many
SELECT p.*,
       ts_rank(p.caption_tsv, websearch_to_tsquery('russian', $2)) AS rank
FROM photos p
JOIN albums a ON a.id = p.album_id
WHERE p.shop_id = $1
  AND p.status = 'ready'
  AND a.status = 'published'
  AND NOT a.hidden_by_plan
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
  AND a.status = 'published'
  AND NOT a.hidden_by_plan
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
