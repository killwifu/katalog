-- Ночная агрегация просмотров из Redis и лидов из lead_clicks в daily_stats.

-- Просмотры/уникальные приходят из Redis и после агрегации удаляются:
-- GREATEST защищает от обнуления при повторном запуске за тот же день.
-- Лиды пересчитываются из lead_clicks (PG) — обычная перезапись.
-- name: UpsertDailyStats :exec
INSERT INTO daily_stats (shop_id, date, album_id, views, unique_visitors, lead_clicks)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (shop_id, date, album_id)
DO UPDATE SET views           = greatest(daily_stats.views, EXCLUDED.views),
              unique_visitors = greatest(daily_stats.unique_visitors, EXCLUDED.unique_visitors),
              lead_clicks     = EXCLUDED.lead_clicks;

-- name: CountLeadClicksBetween :many
SELECT shop_id, count(*) AS clicks
FROM lead_clicks
WHERE created_at >= $1 AND created_at < $2
GROUP BY shop_id;

-- Дашборд продавца. Строки album_id IS NULL — уровень магазина: shop-ключ
-- инкрементится на каждой странице витрины, т.е. это общие просмотры;
-- альбомные строки — разбивка по альбомам (подмножество).

-- name: GetShopStatsTotals :one
SELECT coalesce(sum(views), 0)::bigint           AS views,
       coalesce(sum(unique_visitors), 0)::bigint AS unique_visitors,
       coalesce(sum(lead_clicks), 0)::bigint     AS lead_clicks
FROM daily_stats
WHERE shop_id = $1 AND album_id IS NULL AND date >= $2 AND date <= $3;

-- name: GetShopStatsDaily :many
SELECT date, views, unique_visitors, lead_clicks
FROM daily_stats
WHERE shop_id = $1 AND album_id IS NULL AND date >= $2 AND date <= $3
ORDER BY date;

-- name: GetShopTopAlbums :many
SELECT d.album_id, a.title, sum(d.views)::bigint AS views
FROM daily_stats d
JOIN albums a ON a.id = d.album_id
WHERE d.shop_id = $1 AND d.album_id IS NOT NULL AND d.date >= $2 AND d.date <= $3
GROUP BY d.album_id, a.title
ORDER BY views DESC, a.title
LIMIT 5;

-- Клики «написать» — реальное время из lead_clicks (не ждут ночной агрегации).
-- name: GetShopLeadsByChannel :many
SELECT channel, count(*)::bigint AS clicks
FROM lead_clicks
WHERE shop_id = $1 AND created_at >= $2 AND created_at < $3
GROUP BY channel
ORDER BY clicks DESC;

-- name: GetShopTopPhotos :many
SELECT l.photo_id, p.caption, p.status, count(*)::bigint AS clicks
FROM lead_clicks l
JOIN photos p ON p.id = l.photo_id
WHERE l.shop_id = $1 AND l.created_at >= $2 AND l.created_at < $3
GROUP BY l.photo_id, p.caption, p.status
ORDER BY clicks DESC, l.photo_id
LIMIT 10;

-- Месячный дайджест: totals за период по активным магазинам с email владельца.
-- name: ListShopsStatsRange :many
SELECT s.id AS shop_id, s.name, s.slug, u.email,
       coalesce(sum(d.views), 0)::bigint           AS views,
       coalesce(sum(d.unique_visitors), 0)::bigint AS unique_visitors,
       coalesce(sum(d.lead_clicks), 0)::bigint     AS lead_clicks
FROM shops s
JOIN users u ON u.id = s.owner_id
LEFT JOIN daily_stats d
       ON d.shop_id = s.id AND d.album_id IS NULL AND d.date >= $1 AND d.date < $2
WHERE s.status = 'active' AND u.email IS NOT NULL
GROUP BY s.id, s.name, s.slug, u.email
ORDER BY s.created_at;

-- Аномальный трафик: просмотры за день $1 против среднего за 7 предыдущих
-- дней. Порог min_views отсекает мелкие магазины, multiplier — кратность.
-- name: ListTrafficAnomalies :many
WITH daily AS (
    SELECT shop_id, date, views
    FROM daily_stats
    WHERE album_id IS NULL AND date >= sqlc.arg(day)::date - 7 AND date <= sqlc.arg(day)::date
)
SELECT y.shop_id, s.slug, s.name,
       y.views::bigint AS day_views,
       coalesce(avg(w.views), 0)::bigint AS week_avg
FROM daily y
JOIN shops s ON s.id = y.shop_id
LEFT JOIN daily w ON w.shop_id = y.shop_id AND w.date < y.date
WHERE y.date = sqlc.arg(day)::date
GROUP BY y.shop_id, s.slug, s.name, y.views
HAVING y.views >= sqlc.arg(min_views)::bigint
   AND y.views::float8 > sqlc.arg(multiplier)::float8 * coalesce(avg(w.views), 0)
ORDER BY y.views DESC;

-- Бизнес-метрики для /metrics.
-- name: CountPhotosUploadedSince :one
SELECT count(*) FROM photos
WHERE created_at >= $1;

-- name: CountActiveShops :one
SELECT count(*) FROM shops
WHERE status = 'active';

-- Ретеншн. Сырые события переходов и дневные агрегаты живут ограниченный
-- срок: lead_clicks хранит visitor_hash, то есть данные о посетителях,
-- и держать их годами незачем — в daily_stats уже лежит агрегат.
--
-- payments и moderation_log сознательно не чистятся: первое — финансовые
-- записи, второе — доказательство, что и почему сняли по жалобе.
-- name: DeleteOldLeadClicks :execrows
DELETE FROM lead_clicks
WHERE created_at < now() - make_interval(days => sqlc.arg(keep_days)::int);

-- name: DeleteOldDailyStats :execrows
DELETE FROM daily_stats
WHERE date < current_date - sqlc.arg(keep_days)::int;
