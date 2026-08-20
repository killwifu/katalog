-- +goose Up
-- Системные вкладки заводятся при создании магазина, но магазины, созданные
-- до появления вкладок, остались без них. Без вкладки home секции главной
-- не отдаются вообще, то есть выкладка витрины для таких магазинов не
-- работает. Догоняем существующие.
INSERT INTO tabs (shop_id, title, slug, is_system, sort_order)
SELECT s.id, t.title, t.slug, true, t.sort_order
FROM shops s
CROSS JOIN (VALUES
    ('Главная',  'home',     0),
    ('Альбомы',  'albums',   1),
    ('Контакты', 'contacts', 2)
) AS t (title, slug, sort_order)
WHERE NOT EXISTS (
    SELECT 1 FROM tabs existing
    WHERE existing.shop_id = s.id AND existing.slug = t.slug
);

-- +goose Down
-- Обратно не удаляем: вкладки могли обрасти секциями, а отличить созданные
-- этой миграцией от заведённых продавцом нельзя.
SELECT 1;
