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
    status         = $5,
    cover_photo_id = $6,
    description    = $7,
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

-- Экран понижения тарифа: альбомы с числом фото и просмотрами за 30 дней.
-- Просмотры нужны для варианта «самые просматриваемые» — он предзаполнен,
-- потому что чаще всего это и есть правильный выбор.
-- name: ListAlbumsForDowngrade :many
SELECT a.id, a.title, a.photo_count, a.hidden_by_plan, a.created_at,
       coalesce(sum(d.views), 0)::bigint AS views
FROM albums a
LEFT JOIN daily_stats d
       ON d.album_id = a.id AND d.date >= (current_date - 30)
WHERE a.shop_id = $1
GROUP BY a.id
ORDER BY views DESC, a.created_at DESC;

-- Применение выбора: видимыми остаются только перечисленные альбомы.
-- Ничего не удаляется — снимается лишь видимость на витрине.
-- name: ApplyPlanVisibility :exec
UPDATE albums
SET hidden_by_plan = NOT (id = ANY($2::uuid[])),
    updated_at     = now()
WHERE shop_id = $1;

-- Возврат после оплаты: скрытое тарифом возвращается целиком и сразу.
-- name: ClearPlanVisibility :execrows
UPDATE albums
SET hidden_by_plan = false, updated_at = now()
WHERE shop_id = $1 AND hidden_by_plan;
