-- name: CreateAlbum :one
INSERT INTO albums (shop_id, parent_id, title, sort_order)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- Тенант-изоляция: доступ к альбому только в связке с shop_id владельца.
-- name: GetAlbumForShop :one
SELECT * FROM albums
WHERE id = $1 AND shop_id = $2;

-- name: ListAlbumsByShop :many
SELECT * FROM albums
WHERE shop_id = $1
ORDER BY sort_order, created_at;

-- name: UpdateAlbum :one
UPDATE albums
SET title          = $3,
    sort_order     = $4,
    is_hidden      = $5,
    cover_photo_id = $6,
    updated_at     = now()
WHERE id = $1 AND shop_id = $2
RETURNING *;

-- name: DeleteAlbum :execrows
DELETE FROM albums
WHERE id = $1 AND shop_id = $2;

-- name: AddAlbumPhotoCount :exec
UPDATE albums
SET photo_count = photo_count + $2, updated_at = now()
WHERE id = $1;
