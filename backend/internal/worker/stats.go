package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgtype"

	"katalog/backend/internal/db"
	"katalog/backend/internal/tasks"
)

// Схема счётчиков просмотров в Redis (пишет Next route handler /t):
//   views:{YYYY-MM-DD}:{shop_id}:{album_id|-}  INCR   (просмотры страницы)
//   uv:{YYYY-MM-DD}:{shop_id}                  PFADD  (уникальные посетители)
// Даты — UTC. Ночной джоб переносит счётчики в daily_stats и удаляет ключи.
// Никаких записей в PG на GET витрины — только этот джоб.

const (
	viewsKeyPrefix = "views:"
	uvKeyPrefix    = "uv:"
)

// HandleStatsAggregate — агрегация за дату из payload (пустая = вчера, UTC):
// Redis-счётчики просмотров + lead_clicks из PG -> upsert в daily_stats.
// Идемпотентен: повторный запуск перезаписывает те же строки.
func (p *Processor) HandleStatsAggregate(ctx context.Context, t *asynq.Task) error {
	var payload tasks.StatsAggregatePayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %v: %w", err, asynq.SkipRetry)
	}
	date := payload.Date
	if date == "" {
		date = time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	}
	day, err := time.ParseInLocation("2006-01-02", date, time.UTC)
	if err != nil {
		return fmt.Errorf("parse date %q: %v: %w", date, err, asynq.SkipRetry)
	}
	log := p.Log.With("date", date)

	type key struct {
		shopID  uuid.UUID
		albumID uuid.NullUUID
	}
	views := map[key]int64{}
	var redisKeys []string

	// Просмотры: SCAN по ключам дня.
	iter := p.RDB.Scan(ctx, 0, viewsKeyPrefix+date+":*", 500).Iterator()
	for iter.Next(ctx) {
		k := iter.Val()
		parts := strings.Split(k, ":")
		if len(parts) != 4 {
			log.Warn("skip malformed views key", "key", k)
			continue
		}
		shopID, err := uuid.Parse(parts[2])
		if err != nil {
			log.Warn("skip views key with bad shop id", "key", k)
			continue
		}
		var albumID uuid.NullUUID
		if parts[3] != "-" {
			id, err := uuid.Parse(parts[3])
			if err != nil {
				log.Warn("skip views key with bad album id", "key", k)
				continue
			}
			albumID = uuid.NullUUID{UUID: id, Valid: true}
		}
		raw, err := p.RDB.Get(ctx, k).Result()
		if err != nil {
			return fmt.Errorf("get %s: %w", k, err)
		}
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			log.Warn("skip non-numeric views key", "key", k)
			continue
		}
		// Присваиваем, а не прибавляем: на дату ключ (shop, album) ровно
		// один, а SCAN по документации Redis может вернуть один и тот же
		// ключ несколько раз — при сложении просмотры продавца росли бы
		// на ровном месте, и вернуть их назад уже нечем (upsert берёт
		// greatest от прежнего значения).
		views[key{shopID, albumID}] = n
		redisKeys = append(redisKeys, k)
	}
	if err := iter.Err(); err != nil {
		return fmt.Errorf("scan views keys: %w", err)
	}

	// Лиды за день из PG.
	dayStart := pgtype.Timestamptz{Time: day, Valid: true}
	dayEnd := pgtype.Timestamptz{Time: day.AddDate(0, 0, 1), Valid: true}
	leadRows, err := p.Q.CountLeadClicksBetween(ctx, db.CountLeadClicksBetweenParams{
		CreatedAt:   dayStart,
		CreatedAt_2: dayEnd,
	})
	if err != nil {
		return fmt.Errorf("count lead clicks: %w", err)
	}
	leads := make(map[uuid.UUID]int64, len(leadRows))
	for _, row := range leadRows {
		leads[row.ShopID] = row.Clicks
	}

	// Магазины с лидами, но без просмотров, тоже получают строку за день.
	for shopID := range leads {
		k := key{shopID: shopID}
		if _, ok := views[k]; !ok {
			views[k] = 0
		}
	}

	pgDate := pgtype.Date{Time: day, Valid: true}
	var upserted int
	for k, v := range views {
		var uniqueVisitors, leadClicks int64
		if !k.albumID.Valid {
			// Уникальные посетители и лиды считаются на уровне магазина.
			uv, err := p.RDB.PFCount(ctx, uvKeyPrefix+date+":"+k.shopID.String()).Result()
			if err != nil {
				return fmt.Errorf("pfcount uv for %s: %w", k.shopID, err)
			}
			uniqueVisitors = uv
			leadClicks = leads[k.shopID]
		}
		if err := p.Q.UpsertDailyStats(ctx, db.UpsertDailyStatsParams{
			ShopID:         k.shopID,
			Date:           pgDate,
			AlbumID:        k.albumID,
			Views:          v,
			UniqueVisitors: uniqueVisitors,
			LeadClicks:     leadClicks,
		}); err != nil {
			return fmt.Errorf("upsert daily stats for shop %s: %w", k.shopID, err)
		}
		upserted++
	}

	// Ключи удаляются только после успешного upsert (ретрай не потеряет данные).
	for k := range views {
		if !k.albumID.Valid {
			redisKeys = append(redisKeys, uvKeyPrefix+date+":"+k.shopID.String())
		}
	}
	if len(redisKeys) > 0 {
		if err := p.RDB.Del(ctx, redisKeys...).Err(); err != nil {
			log.Warn("delete aggregated redis keys failed", "error", err)
		}
	}

	log.Info("daily stats aggregated", "rows", upserted)
	return nil
}
