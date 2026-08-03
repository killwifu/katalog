-- Жалобы правообладателей (notice-and-takedown) и действия модератора.

-- name: CreateComplaint :one
INSERT INTO complaints (shop_id, photo_id, reason, reporter_name, reporter_email, content_url)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetComplaint :one
SELECT * FROM complaints
WHERE id = $1;

-- Список для админ-зоны: с slug магазина и альбомом фото (для действий).
-- name: ListComplaints :many
SELECT c.*, s.slug AS shop_slug, p.album_id AS photo_album_id
FROM complaints c
LEFT JOIN shops s ON s.id = c.shop_id
LEFT JOIN photos p ON p.id = c.photo_id
WHERE sqlc.narg('status')::complaint_status IS NULL OR c.status = sqlc.narg('status')
ORDER BY c.created_at DESC
LIMIT 200;

-- name: SetComplaintStatus :one
UPDATE complaints
SET status      = $2,
    resolved_at = CASE WHEN $2::complaint_status IN ('resolved', 'rejected')
                       THEN now() ELSE resolved_at END
WHERE id = $1
RETURNING *;

-- Блокировка фото модератором: исчезает с витрины (status фильтруется
-- везде по 'ready'), деривативы удаляются из S3 в handler. Оригинал остаётся.
-- name: AdminBlockPhoto :one
UPDATE photos
SET status = 'blocked', updated_at = now()
WHERE id = $1 AND status != 'blocked'
RETURNING *;

-- name: SetPhotoFlagged :exec
UPDATE photos
SET flagged = $2, updated_at = now()
WHERE id = $1;

-- name: ListFlaggedPhotos :many
SELECT p.*, s.slug AS shop_slug
FROM photos p
JOIN shops s ON s.id = p.shop_id
WHERE p.flagged
ORDER BY p.updated_at DESC
LIMIT 200;

-- name: AdminHideAlbum :one
UPDATE albums
SET is_hidden = true, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: AdminSuspendShop :one
UPDATE shops
SET status = 'suspended', updated_at = now()
WHERE id = $1
RETURNING *;

-- Для резолва жалобы по URL: магазин по slug независимо от статуса.
-- name: GetShopBySlugAny :one
SELECT * FROM shops
WHERE slug = $1;

-- name: CreateModerationLog :one
INSERT INTO moderation_log (admin_id, action, complaint_id, shop_id, album_id, photo_id, note)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: SetUserEmailVerified :exec
UPDATE users
SET email_verified_at = now(), updated_at = now()
WHERE id = $1;
