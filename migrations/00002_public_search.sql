-- +goose Up
-- Триграммный индекс для fallback-поиска по подписям (pg_trgm),
-- когда FTS russian не даёт совпадений (опечатки, части слов).
CREATE INDEX photos_caption_trgm_idx ON photos USING gin (caption gin_trgm_ops);

-- +goose Down
DROP INDEX photos_caption_trgm_idx;
