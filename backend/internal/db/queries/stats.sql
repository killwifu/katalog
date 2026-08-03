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
