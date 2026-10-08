-- Счётчик места (shops.storage_used) расходился с фактом.
--
-- Инвариант с этой миграции: у каждой фотографии orig_size + drv_size — ровно
-- те байты, что за неё учтены в storage_used. Раньше presign записывал в
-- orig_size заявленный размер, хотя в счётчик байты попадают только на confirm.
-- Окончательное удаление фото, не дошедшего до confirm (или отклонённого там
-- как слишком большое), вычитало эти неучтённые байты — счётчик уходил вниз;
-- на стенде у магазинов расхождение доходило до десятков мегабайт в обе
-- стороны.
--
-- Здесь: обнуляем orig_size у строк, байты которых не учитывались, и
-- пересчитываем storage_used по фотографиям.

-- +goose Up
UPDATE photos SET orig_size = 0
WHERE orig_size <> 0
  AND (status = 'uploading' OR (status = 'failed' AND fail_reason = 'file_too_large'));

UPDATE shops s
SET storage_used = coalesce((
    SELECT sum(p.orig_size + p.drv_size) FROM photos p WHERE p.shop_id = s.id
), 0)
WHERE s.storage_used IS DISTINCT FROM coalesce((
    SELECT sum(p.orig_size + p.drv_size) FROM photos p WHERE p.shop_id = s.id
), 0);

-- +goose Down
-- Пересчёт необратим и откатывать его незачем: прежние значения были ошибкой.
SELECT 1;
