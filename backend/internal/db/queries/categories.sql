-- Место не задано (0) — категория встаёт в конец своего уровня (макет 14:
-- новая строка появляется в конце списка). Раньше все новые получали 0 и
-- вставали перед теми, что продавец уже расставил перетаскиванием.
-- name: CreateCategory :one
INSERT INTO categories (shop_id, parent_id, title, slug, sort_order)
VALUES (
    sqlc.arg(shop_id), sqlc.arg(parent_id), sqlc.arg(title), sqlc.arg(slug),
    CASE WHEN sqlc.arg(sort_order)::int > 0 THEN sqlc.arg(sort_order)::int
         ELSE (SELECT coalesce(max(c.sort_order), -1) + 1 FROM categories c
               WHERE c.shop_id = sqlc.arg(shop_id)
                 AND c.parent_id IS NOT DISTINCT FROM sqlc.arg(parent_id))
    END
)
RETURNING *;

-- Тенант-изоляция: доступ к категории только в связке с shop_id владельца.
-- name: GetCategoryForShop :one
SELECT * FROM categories
WHERE id = $1 AND shop_id = $2;

-- name: ListCategoriesByShop :many
SELECT * FROM categories
WHERE shop_id = $1
ORDER BY sort_order, created_at;

-- sort_order не передан (NULL) — место категории не меняется. Раньше
-- переименование в кабинете слало 0, и категория прыгала в начало списка.
-- name: UpdateCategory :one
UPDATE categories
SET title      = sqlc.arg(title),
    slug       = sqlc.arg(slug),
    sort_order = coalesce(sqlc.narg(sort_order)::int, sort_order),
    parent_id  = sqlc.arg(parent_id),
    updated_at = now()
WHERE id = sqlc.arg(id) AND shop_id = sqlc.arg(shop_id)
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
INSERT INTO album_categories (album_id, category_id, sort_order)
SELECT ac.album_id, sqlc.arg(target)::uuid,
       -- Переехавшие встают в конец новой категории, сохраняя свой порядок.
       (SELECT coalesce(max(t.sort_order), 0) FROM album_categories t WHERE t.category_id = sqlc.arg(target)::uuid)
         + row_number() OVER (ORDER BY ac.sort_order, ac.created_at)
FROM album_categories ac
JOIN albums a ON a.id = ac.album_id
WHERE a.shop_id = sqlc.arg(shop_id) AND ac.category_id = sqlc.arg(source)::uuid
ON CONFLICT DO NOTHING;

-- name: SetAlbumCategory :one
UPDATE albums
SET category_id = $3, updated_at = now()
WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL
RETURNING *;

-- Альбом в нескольких категориях. Обе стороны проверяются по магазину:
-- ни чужой альбом, ни чужая категория в связь не попадут.
-- Новый альбом встаёт в конец категории.
-- name: AddAlbumCategory :execrows
INSERT INTO album_categories (album_id, category_id, sort_order)
SELECT a.id, c.id,
       (SELECT coalesce(max(t.sort_order), 0) + 1 FROM album_categories t WHERE t.category_id = c.id)
FROM albums a, categories c
WHERE a.id = sqlc.arg(album_id) AND a.shop_id = sqlc.arg(shop_id) AND a.deleted_at IS NULL
  AND c.id = sqlc.arg(category_id) AND c.shop_id = sqlc.arg(shop_id)
ON CONFLICT DO NOTHING;

-- name: RemoveAlbumCategory :execrows
DELETE FROM album_categories ac
USING albums a
WHERE ac.album_id = a.id AND a.shop_id = sqlc.arg(shop_id)
  AND ac.album_id = sqlc.arg(album_id) AND ac.category_id = sqlc.arg(category_id);

-- name: ClearAlbumCategories :exec
DELETE FROM album_categories ac
USING albums a
WHERE ac.album_id = a.id AND a.shop_id = sqlc.arg(shop_id) AND ac.album_id = sqlc.arg(album_id);

-- Пары «альбом — категория» магазина: кабинет собирает из них category_ids.
-- name: ListAlbumCategoryPairs :many
SELECT ac.album_id, ac.category_id, ac.sort_order
FROM album_categories ac
JOIN albums a ON a.id = ac.album_id
WHERE a.shop_id = $1
ORDER BY ac.created_at, ac.category_id;

-- То же для витрины: слаги только видимых категорий.
-- name: ListPublicAlbumCategorySlugs :many
SELECT ac.album_id, c.slug, ac.sort_order
FROM album_categories ac
JOIN albums a ON a.id = ac.album_id
JOIN categories c ON c.id = ac.category_id
WHERE a.shop_id = $1 AND NOT c.is_hidden
  AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.id = c.parent_id AND p.is_hidden)
ORDER BY ac.created_at, c.slug;

-- albums.category_id — «первая категория» альбома; после любой правки
-- связей её выравнивают по таблице связей.
-- name: SyncShopPrimaryCategories :exec
UPDATE albums a
SET category_id = (
    SELECT ac.category_id FROM album_categories ac
    WHERE ac.album_id = a.id
    ORDER BY ac.created_at, ac.category_id
    LIMIT 1)
WHERE a.shop_id = $1
  AND a.category_id IS DISTINCT FROM (
    SELECT ac.category_id FROM album_categories ac
    WHERE ac.album_id = a.id
    ORDER BY ac.created_at, ac.category_id
    LIMIT 1);

-- Публичное дерево категорий витрины: только те, где есть видимые альбомы,
-- либо есть потомок с видимыми. Горячий путь покупателя — один запрос.
-- name: ListPublicCategories :many
SELECT c.*, count(a.id) FILTER (WHERE a.status = 'published' AND NOT a.hidden_by_plan AND NOT a.blocked_by_moderator AND a.deleted_at IS NULL) AS album_count
FROM categories c
LEFT JOIN album_categories ac ON ac.category_id = c.id
LEFT JOIN albums a ON a.id = ac.album_id
WHERE c.shop_id = $1
  -- Скрытая категория не видна покупателю вместе со всеми подкатегориями.
  AND NOT c.is_hidden
  AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.id = c.parent_id AND p.is_hidden)
GROUP BY c.id
ORDER BY c.sort_order, c.created_at;

-- Порядок — как продавец расставил альбомы в самой категории; альбомы
-- подкатегорий идут следом, каждый на своём месте в подкатегории.
-- name: ListPublicAlbumsByCategory :many
SELECT a.* FROM albums a
JOIN album_categories ac ON ac.album_id = a.id
JOIN categories c ON c.id = ac.category_id
WHERE a.shop_id = $1 AND a.deleted_at IS NULL
  AND a.status = 'published' AND NOT a.hidden_by_plan AND NOT a.blocked_by_moderator
  AND (a.photo_count > 0 OR EXISTS (
        SELECT 1 FROM albums ch
        WHERE ch.parent_id = a.id AND ch.status = 'published' AND ch.deleted_at IS NULL
          AND NOT ch.hidden_by_plan AND NOT ch.blocked_by_moderator
          AND ch.photo_count > 0))
  AND (c.slug = $2 OR c.parent_id = (SELECT id FROM categories WHERE shop_id = $1 AND slug = $2))
  -- Скрытая категория по своему адресу тоже ничего не отдаёт.
  AND NOT c.is_hidden
  AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.id = c.parent_id AND p.is_hidden)
  AND NOT EXISTS (SELECT 1 FROM categories self WHERE self.shop_id = $1 AND self.slug = $2 AND self.is_hidden)
GROUP BY a.id
ORDER BY min(CASE WHEN c.slug = $2 THEN 0 ELSE 1 END), min(ac.sort_order), a.created_at DESC;

-- Видимость категории: скрыта с витрины и показывается ли на главной.
-- name: SetCategoryVisibility :one
UPDATE categories
SET is_hidden = $3, on_home = $4, updated_at = now()
WHERE id = $1 AND shop_id = $2
RETURNING *;

-- Порядок альбомов в категории одним запросом: альбомы получают номера
-- по месту в списке. Категория проверяется по магазину — чужая не совпадёт
-- ни с одной строкой; альбомы не из этой категории просто пропускаются.
-- name: SetCategoryAlbumOrder :execrows
UPDATE album_categories ac
SET sort_order = wanted.ord
FROM unnest(sqlc.arg(album_ids)::uuid[]) WITH ORDINALITY AS wanted(id, ord), categories c
WHERE ac.album_id = wanted.id
  AND ac.category_id = sqlc.arg(category_id)
  AND c.id = ac.category_id AND c.shop_id = sqlc.arg(shop_id);

-- name: LockCategoryForShop :exec
-- Строка категории под замком до конца транзакции: добавления альбомов
-- в неё идут по очереди, и max(sort_order)+1 не выдаёт двум одно место.
SELECT id FROM categories WHERE id = sqlc.arg(id) AND shop_id = sqlc.arg(shop_id) FOR UPDATE;
