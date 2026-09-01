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

-- Страницами: альбом на тарифе «Продавец» — до 5000 фото, и выдача целиком
-- вешала кабинет на несколько секунд. У витрины пагинация была с самого
-- начала, у кабинета её не было.
-- name: ListPhotosByAlbum :many
SELECT * FROM photos
WHERE album_id = $1 AND shop_id = $2
-- id в сортировке — не украшение: при одинаковых sort_order и created_at
-- порядок между запросами не определён, и фото на границе страниц может
-- задвоиться или пропасть. У публичной выборки это уже учтено.
ORDER BY sort_order, created_at, id
LIMIT $3 OFFSET $4;

-- name: CountPhotosByAlbum :one
SELECT count(*) FROM photos
WHERE album_id = $1 AND shop_id = $2;

-- Переход uploading -> processing после подтверждения загрузки в S3.
-- name: SetPhotoProcessing :one
UPDATE photos
SET status = 'processing', orig_size = $2, updated_at = now()
WHERE id = $1 AND status = 'uploading'
RETURNING *;

-- name: SetPhotoReady :exec
UPDATE photos
SET status = 'ready', width = $2, height = $3, phash = $4, drv_size = $5, updated_at = now()
WHERE id = $1;

-- name: SetPhotoFailed :exec
UPDATE photos
SET status = 'failed', fail_reason = $2, updated_at = now()
WHERE id = $1;

-- name: UpdatePhotoCaption :one
UPDATE photos
SET caption = $3, updated_at = now()
WHERE id = $1 AND shop_id = $2
RETURNING *;

-- name: DeletePhoto :execrows
DELETE FROM photos
WHERE id = $1 AND shop_id = $2;

-- Уборка зависших загрузок. Фото попадает в uploading при выдаче presign
-- и выходит из него на confirm. Если confirm не дошёл — строка остаётся
-- навсегда и продолжает занимать квоту (CountShopPhotos считает всё, кроме
-- failed). На боевом стенде таких накопилось шесть штук за неделю.
-- name: DeleteStaleUploads :many
DELETE FROM photos
WHERE status = 'uploading'
  AND created_at < now() - make_interval(hours => $1::int)
RETURNING id, shop_id;

-- Фото, застрявшее в processing: задача потерялась (сброс Redis) либо
-- исчерпала ретраи и ушла в архив asynq — статус в БД при этом не меняется.
-- Такое фото навсегда висит в кабинете со спиннером и занимает квоту.
-- Оригинал в S3 не трогаем: поведение то же, что у обычного failed.
-- name: FailStaleProcessing :many
UPDATE photos
SET status = 'failed', updated_at = now()
WHERE status = 'processing'
  AND updated_at < now() - make_interval(hours => $1::int)
RETURNING id;

-- Фото удаляемого альбома (вместе с подальбомами: parent_id — один уровень).
-- Нужны и размеры для возврата квоты, и id для уборки объектов в S3:
-- каскад по FK снесёт строки, но об S3 и storage_used он не знает.
-- name: ListAlbumTreePhotos :many
SELECT id, (orig_size + drv_size)::bigint AS bytes FROM photos
WHERE album_id = $1 OR album_id IN (SELECT id FROM albums WHERE parent_id = $1);

-- Счётчик фотографий проверяется и увеличивается под блокировкой на магазин:
-- без неё параллельные presign читают одно и то же значение и все проходят.
-- Блокировка транзакционная, снимается сама, и она на магазин — соседние
-- продавцы друг друга не ждут.
-- name: LockShopForUpload :exec
SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint);
