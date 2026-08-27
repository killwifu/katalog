-- +goose Up
-- Описание альбома показывается покупателю над фотографиями: размеры,
-- цена, условия отправки (макет cabinet/editor). Это единственное место,
-- где продавец объясняет условия покупки — подписи к фото для этого коротки.
ALTER TABLE albums ADD COLUMN description text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE albums DROP COLUMN description;
