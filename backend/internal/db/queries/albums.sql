-- name: CreateAlbum :one
INSERT INTO albums (shop_id, parent_id, title, sort_order)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- Тенант-изоляция: доступ к альбому только в связке с shop_id владельца.
-- name: GetAlbumForShop :one
SELECT * FROM albums
WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL;

-- name: ListAlbumsByShop :many
SELECT * FROM albums
WHERE shop_id = $1 AND deleted_at IS NULL
ORDER BY sort_order, created_at;

-- name: UpdateAlbum :one
UPDATE albums
SET title          = $3,
    sort_order     = $4,
    status         = $5,
    cover_photo_id = $6,
    description    = $7,
    parent_id      = $8,
    updated_at     = now()
WHERE id = $1 AND shop_id = $2
RETURNING *;

-- Есть ли у альбома подальбомы: родителем можно назначить только тот,
-- у которого их нет, иначе получится третий уровень.
-- name: CountAlbumChildren :one
SELECT count(*) FROM albums WHERE parent_id = $1 AND deleted_at IS NULL;

-- name: DeleteAlbum :execrows
DELETE FROM albums
WHERE id = $1 AND shop_id = $2;

-- photo_count — готовые фото альбома, не убранные в корзину по одному
-- (уехавшие вместе с альбомом считаются: альбом вернётся с ними). Раньше
-- счётчик двигали на ±1 по статусу, прочитанному до изменения, и гонки
-- (блокировка во время обработки, блокировка фото из корзины) уводили его
-- от факта навсегда. Пересчёт идёт после LockAlbumForOrder в той же
-- транзакции: без замка подзапрос видит снимок до чужого коммита.
-- name: RecountAlbumPhotos :exec
UPDATE albums a
SET photo_count = (
    SELECT count(*) FROM photos p
    WHERE p.album_id = a.id AND p.status = 'ready'
      AND (p.deleted_at IS NULL OR p.deleted_at = a.deleted_at)
), updated_at = now()
WHERE a.id = $1;

-- name: CountAlbumsByShop :one
SELECT count(*) FROM albums WHERE shop_id = $1 AND deleted_at IS NULL;

-- Пароль альбома: NULL снимает защиту. Хеш наружу не отдаётся никогда —
-- кабинет видит только признак has_password.
-- name: SetAlbumPassword :one
UPDATE albums
SET password_hash = $3, updated_at = now()
WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL
RETURNING *;

-- Корзина. Альбом уезжает вместе с подальбомами; метка времени приходит
-- из приложения и одна на всё дерево — по ней восстановление находит
-- фото, удалённые вместе с альбомом.
-- name: SoftDeleteAlbumTree :execrows
UPDATE albums
SET deleted_at = $3, updated_at = now()
WHERE shop_id = $2 AND deleted_at IS NULL AND (id = $1 OR parent_id = $1);

-- name: SoftDeleteAlbumTreePhotos :execrows
UPDATE photos
SET deleted_at = $3, updated_at = now()
WHERE photos.shop_id = $2 AND photos.deleted_at IS NULL
  AND photos.album_id IN (SELECT a.id FROM albums a WHERE a.shop_id = $2 AND a.deleted_at = $3 AND (a.id = $1 OR a.parent_id = $1));

-- name: GetDeletedAlbumForShop :one
SELECT * FROM albums
WHERE id = $1 AND shop_id = $2 AND deleted_at IS NOT NULL;

-- Удалённые альбомы для «Удаленного». Подальбом, уехавший вместе с
-- родителем, отдельной строкой не показываем — он вернётся вместе с ним.
-- tree_photos/tree_bytes — фото альбома с подальбомами, уехавшие вместе
-- с ним: «Альбом и 12 фото… Освободится 16 МБ» (макет 20).
-- name: ListDeletedAlbums :many
SELECT sqlc.embed(a),
       coalesce(t.photos, 0)::bigint AS tree_photos,
       coalesce(t.bytes, 0)::bigint  AS tree_bytes
FROM albums a
LEFT JOIN LATERAL (
    SELECT count(*) AS photos, sum(p.orig_size + p.drv_size) AS bytes
    FROM photos p JOIN albums c ON c.id = p.album_id
    WHERE (c.id = a.id OR c.parent_id = a.id) AND p.deleted_at = a.deleted_at
) t ON true
WHERE a.shop_id = $1 AND a.deleted_at IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM albums p
        WHERE p.id = a.parent_id AND p.deleted_at = a.deleted_at)
ORDER BY a.deleted_at DESC, a.id;

-- Восстановление: сначала фото (пока у альбома ещё стоит метка, по которой
-- их искать), затем сам альбом с подальбомами.
-- name: RestoreAlbumTreePhotos :execrows
UPDATE photos
SET deleted_at = NULL, updated_at = now()
WHERE photos.shop_id = $2 AND photos.deleted_at = $3
  AND photos.album_id IN (SELECT a.id FROM albums a WHERE a.shop_id = $2 AND a.deleted_at = $3 AND (a.id = $1 OR a.parent_id = $1));

-- name: RestoreAlbumTree :execrows
UPDATE albums
SET deleted_at = NULL, updated_at = now()
WHERE shop_id = $2 AND deleted_at = $3 AND (id = $1 OR parent_id = $1);

-- Окончательная уборка альбомов из корзины. Фотографии к этому моменту
-- уже убраны своими запросами (нужны их id и байты для S3 и квоты), а
-- что осталось — снесёт каскад.
-- name: PurgeDeletedAlbums :execrows
DELETE FROM albums
WHERE shop_id = $1 AND deleted_at IS NOT NULL;

-- name: PurgeExpiredAlbums :execrows
DELETE FROM albums
WHERE deleted_at IS NOT NULL
  AND deleted_at < now() - make_interval(days => $1::int);

-- Обложка удалённого альбома для «Удаленного»: его фото тоже помечены
-- deleted_at, поэтому обычный фолбэк «первое готовое фото» их не видит.
-- name: FirstAlbumPhotoAny :one
SELECT id FROM photos
WHERE album_id = $1 AND status = 'ready'
ORDER BY sort_order, created_at, id
LIMIT 1;

-- Знак альбома: NULL — как у магазина.
-- name: SetAlbumWatermark :one
UPDATE albums
SET watermark = $3, updated_at = now()
WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL
RETURNING *;

-- Для воркера: знак альбома обрабатываемого фото.
-- name: GetAlbumWatermark :one
SELECT watermark FROM albums WHERE id = $1;
