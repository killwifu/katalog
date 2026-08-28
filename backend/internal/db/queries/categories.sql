-- name: CreateCategory :one
INSERT INTO categories (shop_id, parent_id, title, slug, sort_order)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- Тенант-изоляция: доступ к категории только в связке с shop_id владельца.
-- name: GetCategoryForShop :one
SELECT * FROM categories
WHERE id = $1 AND shop_id = $2;

-- name: ListCategoriesByShop :many
SELECT * FROM categories
WHERE shop_id = $1
ORDER BY sort_order, created_at;

-- name: UpdateCategory :one
UPDATE categories
SET title      = $3,
    slug       = $4,
    sort_order = $5,
    parent_id  = $6,
    updated_at = now()
WHERE id = $1 AND shop_id = $2
RETURNING *;

-- Есть ли у категории дети: родителем можно назначить только ту,
-- у которой их нет, иначе получится третий уровень.
-- name: CountCategoryChildren :one
SELECT count(*) FROM categories WHERE parent_id = $1;

-- name: DeleteCategory :execrows
DELETE FROM categories
WHERE id = $1 AND shop_id = $2;

-- Перенос альбомов при удалении категории: продавец выбирает целевую
-- (NULL = оставить без категории). Ограничение по shop_id — на случай
-- подставленного чужого id.
-- name: MoveAlbumsToCategory :exec
UPDATE albums
SET category_id = $3, updated_at = now()
WHERE shop_id = $1 AND category_id = $2;

-- name: SetAlbumCategory :one
UPDATE albums
SET category_id = $3, updated_at = now()
WHERE id = $1 AND shop_id = $2
RETURNING *;

-- Публичное дерево категорий витрины: только те, где есть видимые альбомы,
-- либо есть потомок с видимыми. Горячий путь покупателя — один запрос.
-- name: ListPublicCategories :many
SELECT c.*, count(a.id) FILTER (WHERE a.status = 'published' AND NOT a.hidden_by_plan) AS album_count
FROM categories c
LEFT JOIN albums a ON a.category_id = c.id
WHERE c.shop_id = $1
GROUP BY c.id
ORDER BY c.sort_order, c.created_at;

-- name: ListPublicAlbumsByCategory :many
SELECT a.* FROM albums a
JOIN categories c ON c.id = a.category_id
WHERE a.shop_id = $1
  AND a.status = 'published' AND NOT a.hidden_by_plan
  AND (c.slug = $2 OR c.parent_id = (SELECT id FROM categories WHERE shop_id = $1 AND slug = $2))
ORDER BY a.sort_order, a.created_at DESC;
