-- +goose Up
ALTER TABLE shops ADD COLUMN logo_upload_id uuid;

-- +goose Down
ALTER TABLE shops DROP COLUMN logo_upload_id;
