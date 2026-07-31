-- name: CreatePhoto :one
INSERT INTO photos (album_id, shop_id, orig_size, source, sort_order)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetPhoto :one
SELECT * FROM photos
WHERE id = $1;

-- Тенант-изоляция: доступ к фото только в связке с shop_id владельца.
-- name: GetPhotoForShop :one
SELECT * FROM photos
WHERE id = $1 AND shop_id = $2;

-- name: ListPhotosByAlbum :many
SELECT * FROM photos
WHERE album_id = $1 AND shop_id = $2
ORDER BY sort_order, created_at;

-- Переход uploading -> processing после подтверждения загрузки в S3.
-- name: SetPhotoProcessing :one
UPDATE photos
SET status = 'processing', orig_size = $2, updated_at = now()
WHERE id = $1 AND status = 'uploading'
RETURNING *;

-- name: SetPhotoReady :exec
UPDATE photos
SET status = 'ready', width = $2, height = $3, phash = $4, updated_at = now()
WHERE id = $1;

-- name: SetPhotoFailed :exec
UPDATE photos
SET status = 'failed', updated_at = now()
WHERE id = $1;

-- name: UpdatePhotoCaption :one
UPDATE photos
SET caption = $3, updated_at = now()
WHERE id = $1 AND shop_id = $2
RETURNING *;

-- name: DeletePhoto :execrows
DELETE FROM photos
WHERE id = $1 AND shop_id = $2;
