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

-- Смена адреса — отдельным запросом: она ограничена по частоте и должна
-- отмечать дату, а обычное сохранение настроек этого делать не должно.
-- name: UpdateShopSlug :one
UPDATE shops
SET slug = $3, slug_changed_at = now(), updated_at = now()
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

-- name: CountShopsByOwner :one
SELECT count(*) FROM shops WHERE owner_id = $1;

-- Освобождённый адрес: занять его может только прежний владелец, пока
-- не истёк срок брони.
-- name: ReserveReleasedSlug :exec
INSERT INTO released_slugs (slug, shop_id)
VALUES ($1, $2)
ON CONFLICT (slug) DO UPDATE
SET shop_id = EXCLUDED.shop_id, released_at = now();

-- name: GetSlugReservation :one
SELECT shop_id, released_at FROM released_slugs
WHERE slug = $1 AND released_at > now() - make_interval(days => $2::int);

-- Магазин занял адрес — бронь на него больше не нужна.
-- name: DropSlugReservation :exec
DELETE FROM released_slugs WHERE slug = $1;
