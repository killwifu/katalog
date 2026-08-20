-- name: CreateShop :one
INSERT INTO shops (owner_id, slug, name, description, contacts, settings)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetShopByID :one
SELECT * FROM shops
WHERE id = $1;

-- Публичная витрина: только активные магазины; suspended по биллингу — скрыты.
-- name: ListShopsByOwner :many
SELECT * FROM shops
WHERE owner_id = $1
ORDER BY created_at;

-- Тенант-изоляция: обновление только владельцем (owner_id из сессии).
-- name: UpdateShop :one
UPDATE shops
SET name        = $3,
    description = $4,
    contacts    = $5,
    settings    = $6,
    updated_at  = now()
WHERE id = $1 AND owner_id = $2
RETURNING *;

-- name: DeleteShop :execrows
DELETE FROM shops
WHERE id = $1 AND owner_id = $2;

-- Тенант-изоляция: доступ к магазину только владельцем.
-- name: GetShopForOwner :one
SELECT * FROM shops
WHERE id = $1 AND owner_id = $2;

-- name: AddShopStorageUsed :exec
UPDATE shops
SET storage_used = greatest(storage_used + $2, 0), updated_at = now()
WHERE id = $1;
