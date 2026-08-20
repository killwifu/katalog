-- +goose Up
-- Выкладка витрины: вкладка -> секция -> альбом.
-- «Главная» и пользовательские вкладки — одна сущность с флагом is_system
-- (kit): системные генерируются автоматически и не удаляются продавцом.
CREATE TABLE tabs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id    uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    title      text NOT NULL,
    slug       citext NOT NULL,
    is_system  boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shop_id, slug)
);

CREATE INDEX tabs_shop_sort_idx ON tabs (shop_id, sort_order);

CREATE TABLE sections (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tab_id     uuid NOT NULL REFERENCES tabs (id) ON DELETE CASCADE,
    title      text NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sections_tab_sort_idx ON sections (tab_id, sort_order);

-- Альбом может лежать в нескольких секциях (kit: связь многие-ко-многим,
-- не поле section_id). Порядок внутри секции ручной, не по дате.
CREATE TABLE album_sections (
    album_id   uuid NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    section_id uuid NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
    sort_order integer NOT NULL DEFAULT 0,
    PRIMARY KEY (album_id, section_id)
);

CREATE INDEX album_sections_section_sort_idx ON album_sections (section_id, sort_order);

-- +goose Down
DROP TABLE album_sections;
DROP TABLE sections;
DROP TABLE tabs;
