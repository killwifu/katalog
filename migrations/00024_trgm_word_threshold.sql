-- Поиск-фолбэк по подписям (pg_trgm) не использовал индекс photos_caption_trgm_idx:
-- условие было записано функцией word_similarity(q, caption) > 0.3, а GIN-индекс
-- понимает только оператор caption %> q. Каждый запрос без совпадений в FTS
-- проходил все фото таблицы: 65 мс на 20 тысячах фото против 0.2 мс с индексом.
--
-- Оператор %> сравнивает с порогом pg_trgm.word_similarity_threshold (по
-- умолчанию 0.6). Выдача подобрана под 0.3 — ставим его значением по умолчанию
-- для базы; новые соединения подхватывают настройку сами.

-- +goose Up
-- +goose StatementBegin
DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET pg_trgm.word_similarity_threshold = 0.3', current_database());
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I RESET pg_trgm.word_similarity_threshold', current_database());
END $$;
-- +goose StatementEnd
