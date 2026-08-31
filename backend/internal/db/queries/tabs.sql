-- name: CreateTab :one
INSERT INTO tabs (shop_id, title, slug, is_system, sort_order)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- Тенант-изоляция: вкладка только в связке с shop_id владельца.
-- name: GetTabForShop :one
SELECT * FROM tabs
WHERE id = $1 AND shop_id = $2;

-- name: ListTabsByShop :many
SELECT * FROM tabs
WHERE shop_id = $1
ORDER BY sort_order, created_at;

-- name: UpdateTab :one
UPDATE tabs
SET title      = $3,
    sort_order = $4,
    updated_at = now()
WHERE id = $1 AND shop_id = $2
RETURNING *;

-- Системные вкладки продавец не удаляет: they генерируются автоматически.
-- name: DeleteCustomTab :execrows
DELETE FROM tabs
WHERE id = $1 AND shop_id = $2 AND is_system = false;

-- name: CreateSection :one
INSERT INTO sections (tab_id, title, sort_order)
VALUES ($1, $2, $3)
RETURNING *;

-- Секция проверяется через вкладку: собственного shop_id у неё нет.
-- name: GetSectionForShop :one
SELECT s.* FROM sections s
JOIN tabs t ON t.id = s.tab_id
WHERE s.id = $1 AND t.shop_id = $2;

-- name: ListSectionsByShop :many
SELECT s.*, t.slug AS tab_slug FROM sections s
JOIN tabs t ON t.id = s.tab_id
WHERE t.shop_id = $1
ORDER BY t.sort_order, s.sort_order, s.created_at;

-- name: UpdateSection :one
UPDATE sections s
SET title = $3, sort_order = $4
FROM tabs t
WHERE s.tab_id = t.id AND s.id = $1 AND t.shop_id = $2
RETURNING s.*;

-- name: DeleteSection :execrows
DELETE FROM sections s
USING tabs t
WHERE s.tab_id = t.id AND s.id = $1 AND t.shop_id = $2;

-- Состав секции задаётся целиком: редактор всё равно сохраняет и порядок.
-- name: ClearSectionAlbums :exec
DELETE FROM album_sections WHERE section_id = $1;

-- Альбом обязан принадлежать тому же магазину — иначе чужой альбом
-- попал бы в чужую витрину.
-- name: AddAlbumToSection :exec
INSERT INTO album_sections (album_id, section_id, sort_order)
SELECT a.id, $2, $3 FROM albums a
WHERE a.id = $1 AND a.shop_id = $4
ON CONFLICT (album_id, section_id) DO UPDATE SET sort_order = EXCLUDED.sort_order;

-- name: ListSectionAlbumIDs :many
SELECT album_id FROM album_sections
WHERE section_id = $1
ORDER BY sort_order;

-- Публичная выкладка: секции вкладки со своими альбомами, одним запросом.
-- Скрытые альбомы не отдаются.
-- name: ListPublicSectionAlbums :many
SELECT s.id AS section_id, s.title AS section_title, s.sort_order AS section_order,
       a.*
FROM sections s
JOIN tabs t ON t.id = s.tab_id
LEFT JOIN album_sections asec ON asec.section_id = s.id
LEFT JOIN albums a ON a.id = asec.album_id AND a.status = 'published' AND NOT a.hidden_by_plan AND NOT a.blocked_by_moderator
WHERE t.shop_id = $1 AND t.slug = $2
ORDER BY s.sort_order, s.created_at, asec.sort_order;

-- Порядок вкладок задаётся целиком одним запросом: обмен двумя апдейтами
-- рвался посередине и оставлял у соседей одинаковый sort_order.
-- name: SetTabOrder :execrows
UPDATE tabs
SET sort_order = data.ord, updated_at = now()
FROM unnest($2::uuid[]) WITH ORDINALITY AS data(id, ord)
WHERE tabs.id = data.id AND tabs.shop_id = $1;
