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
WHERE album_id = $1 AND shop_id = $2 AND deleted_at IS NULL
-- id в сортировке — не украшение: при одинаковых sort_order и created_at
-- порядок между запросами не определён, и фото на границе страниц может
-- задвоиться или пропасть. У публичной выборки это уже учтено.
ORDER BY sort_order, created_at, id
LIMIT $3 OFFSET $4;

-- name: CountPhotosByAlbum :one
SELECT count(*) FROM photos
WHERE album_id = $1 AND shop_id = $2 AND deleted_at IS NULL;

-- Переход uploading -> processing после подтверждения загрузки в S3.
-- Здесь же фотография занимает место в альбоме: sort_order приходит
-- сразу после обложки (FirstAlbumSortOrder + ShiftAlbumPhotosAfter).
-- На presign он оставался нулём, и выдача падала
-- на created_at — то есть на порядок, в котором до сервера доехали
-- запросы параллельного загрузчика.
-- name: SetPhotoProcessing :one
UPDATE photos
SET status = 'processing', orig_size = $2, sort_order = $3, updated_at = now()
WHERE id = $1 AND status = 'uploading'
RETURNING *;

-- Только из processing: пока воркер собирал деривативы, модератор мог
-- заблокировать фото, и безусловный ready снимал блокировку — фото
-- возвращалось на витрину. Ноль строк — фото уже не ждёт обработки.
-- name: SetPhotoReady :execrows
UPDATE photos
SET status = 'ready', width = $2, height = $3, phash = $4, drv_size = $5, updated_at = now()
WHERE id = $1 AND status = 'processing';

-- name: SetPhotoFailed :exec
UPDATE photos
SET status = 'failed', fail_reason = $2, updated_at = now()
WHERE id = $1;

-- Файл не прошёл проверку (не картинка, SVG, «бомба»): оригинал — мусор,
-- повторять обработку незачем. Байты оригинала возвращаются в тариф,
-- orig_size обнуляется (инвариант: orig_size+drv_size — учтённые байты).
-- Возвращает, сколько байт освободить; нет строки — фото уже не в processing.
-- name: FailPhotoReleaseOrig :one
UPDATE photos p
SET status = 'failed', fail_reason = sqlc.arg(fail_reason), orig_size = 0, updated_at = now()
FROM (SELECT ph.id, ph.orig_size FROM photos ph WHERE ph.id = sqlc.arg(id) AND ph.status = 'processing' FOR UPDATE) old
WHERE p.id = old.id
RETURNING old.orig_size::bigint AS released;

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
-- Причина 'lost' отличает нашу поломку от негодного файла: остальные коды
-- (unsupported_format, corrupt, too_large, empty) говорят продавцу, что не так
-- с его файлом, а здесь с файлом всё в порядке — потерялась задача.
-- name: FailStaleProcessing :many
UPDATE photos
SET status = 'failed', fail_reason = 'lost', updated_at = now()
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

-- Деривативы удалены (блокировка модератором) — размер обнуляется вместе
-- с возвратом байтов в квоту, иначе повторная обработка учтёт их дважды.
-- name: ResetPhotoDerivativeSize :exec
UPDATE photos SET drv_size = 0, updated_at = now() WHERE id = $1;

-- --- Корзина ---------------------------------------------------------------
-- Удаление в два шага: сначала пометка, потом ночная уборка по сроку. Место
-- в хранилище при пометке не возвращаем — объекты в S3 никуда не делись.

-- name: SoftDeletePhoto :execrows
UPDATE photos
SET deleted_at = now(), updated_at = now()
WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL;

-- album_title и bytes — для карточки «из «альбома»» и тоста «освободилось N МБ».
-- name: ListDeletedPhotos :many
SELECT sqlc.embed(photos), a.title AS album_title, (photos.orig_size + photos.drv_size)::bigint AS bytes
FROM photos
JOIN albums a ON a.id = photos.album_id
WHERE photos.shop_id = $1 AND photos.deleted_at IS NOT NULL
  -- Фото, уехавшие вместе с альбомом, показываются одной строкой — самим
  -- альбомом; по отдельности их не восстановить, альбома-то нет.
  AND NOT EXISTS (SELECT 1 FROM albums a WHERE a.id = photos.album_id AND a.deleted_at IS NOT NULL)
ORDER BY photos.deleted_at DESC, photos.id
LIMIT $2 OFFSET $3;

-- name: CountDeletedPhotos :one
SELECT count(*) FROM photos
WHERE photos.shop_id = $1 AND photos.deleted_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM albums a WHERE a.id = photos.album_id AND a.deleted_at IS NOT NULL);

-- Возврат из корзины. Альбом мог уехать вместе с удалением самого альбома —
-- тогда каскад унёс и строку фотографии, и возвращать нечего.
-- name: RestorePhoto :one
UPDATE photos
SET deleted_at = NULL, updated_at = now()
WHERE photos.id = $1 AND photos.shop_id = $2 AND photos.deleted_at IS NOT NULL
  -- Возвращать фото в удалённый альбом некуда: сначала восстанавливают альбом.
  AND NOT EXISTS (SELECT 1 FROM albums a WHERE a.id = photos.album_id AND a.deleted_at IS NOT NULL)
RETURNING *;

-- Окончательное удаление одной фотографии из корзины.
-- name: PurgePhoto :one
DELETE FROM photos
WHERE id = $1 AND shop_id = $2 AND deleted_at IS NOT NULL
RETURNING id, album_id, status, (orig_size + drv_size)::bigint AS bytes;

-- Очистить корзину целиком: id и байты нужны для уборки S3 и возврата квоты.
-- name: PurgeShopTrash :many
DELETE FROM photos
WHERE shop_id = $1 AND deleted_at IS NOT NULL
RETURNING id, (orig_size + drv_size)::bigint AS bytes;

-- Ночная уборка: всё, что пролежало в корзине дольше срока хранения.
-- name: PurgeExpiredTrash :many
DELETE FROM photos
WHERE deleted_at IS NOT NULL
  AND deleted_at < now() - make_interval(days => $1::int)
RETURNING id, shop_id, (orig_size + drv_size)::bigint AS bytes;

-- Порядок фотографий в альбоме — как у вкладок, одним запросом. Список
-- приходит страницей, а не альбомом целиком, поэтому новые номера не
-- назначаются с единицы: перестановка раздаёт этим же фото их же номера
-- в новом порядке, и фото с соседних страниц остаются на своих местах.
-- shop_id и album_id в условии: чужие id не совпадут ни с одной строкой.
-- name: SetPhotoOrder :execrows
WITH wanted AS (
    SELECT t.id, t.ord
    FROM unnest($3::uuid[]) WITH ORDINALITY AS t(id, ord)
), mine AS (
    SELECT p.id,
           p.sort_order,
           row_number() OVER (ORDER BY p.sort_order, p.created_at, p.id) AS old_pos,
           row_number() OVER (ORDER BY w.ord) AS new_pos
    FROM photos p
    JOIN wanted w ON w.id = p.id
    WHERE p.shop_id = $1 AND p.album_id = $2 AND p.deleted_at IS NULL
)
UPDATE photos
SET sort_order = slot.sort_order, updated_at = now()
FROM mine m
JOIN mine slot ON slot.old_pos = m.new_pos
WHERE photos.id = m.id;

-- Отмена загрузки: фото, которое так и не подтвердили, убирается совсем,
-- а не в корзину — показывать и восстанавливать там нечего. Условие по
-- статусу держит гонку с confirm: если он успел первым, строка не
-- удалится и фото пойдёт обычным путём через корзину.
-- name: DeleteUploadingPhoto :execrows
DELETE FROM photos
WHERE id = $1 AND shop_id = $2 AND status = 'uploading';

-- Место первой фотографии альбома (она же обложка по умолчанию). Нужна,
-- чтобы поставить новые фото сразу после неё.
-- name: FirstAlbumSortOrder :one
SELECT sort_order FROM photos
WHERE album_id = $1 AND deleted_at IS NULL AND status <> 'uploading'
ORDER BY sort_order, created_at, id
LIMIT 1;

-- Освободить номер под новое фото: всё, что стоит на нём и дальше, сдвигается
-- на одну позицию. Неподтверждённые загрузки не трогаем — своё место они
-- получат при подтверждении.
-- name: ShiftAlbumPhotosFrom :exec
UPDATE photos
SET sort_order = sort_order + 1
WHERE album_id = sqlc.arg(album_id) AND sort_order >= sqlc.arg(from_pos)::int AND status <> 'uploading';

-- Раздача мест новым фото альбома идёт по очереди: строка альбома под замком
-- до конца транзакции подтверждения.
-- name: LockAlbumForOrder :exec
SELECT id FROM albums WHERE id = $1 FOR UPDATE;

-- Разовая зачистка метаданных в старых деривативах (worker strip-exif).
-- name: ListReadyPhotoRefs :many
SELECT id, shop_id FROM photos
WHERE status = 'ready' AND drv_size > 0
ORDER BY created_at;

-- name: AdjustPhotoDrvSize :exec
UPDATE photos SET drv_size = greatest(drv_size + sqlc.arg(delta)::bigint, 0)
WHERE id = sqlc.arg(id);

-- Перерисовка деривативов после смены водяного знака альбома.
-- name: ListReadyAlbumPhotoRefs :many
SELECT id, shop_id FROM photos
WHERE album_id = $1 AND status = 'ready'
ORDER BY sort_order;
