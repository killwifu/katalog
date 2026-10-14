-- Водяной знак на уровне альбома (макет v2, экраны 11–13: «Водяной знак ·
-- Положение» в окнах альбома).
--
-- NULL — как у магазина (shops.settings.watermark). Иначе
-- {"enabled": bool, "position": "tl".."br"}; текст знака общий для
-- магазина — это его подпись, а не настройка альбома.

-- +goose Up
ALTER TABLE albums ADD COLUMN watermark jsonb;

-- +goose Down
ALTER TABLE albums DROP COLUMN watermark;
