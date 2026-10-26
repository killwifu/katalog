-- Версия картинок магазина. Деривативы раздаются как immutable на год, а
-- смена водяного знака альбома перерисовывает их по тем же ключам S3.
-- Номер уходит в адрес картинки (?v=N): после перерисовки адрес новый,
-- и браузер с CDN не отдают старую картинку со старым знаком.

-- +goose Up
ALTER TABLE shops ADD COLUMN media_rev integer NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE shops DROP COLUMN media_rev;
