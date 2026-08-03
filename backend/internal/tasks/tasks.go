// Package tasks — типы asynq-задач, общие для api (producer) и worker.
package tasks

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
)

const (
	TypePhotoProcess   = "photo:process"
	TypeStatsAggregate = "stats:aggregate"
)

type PhotoProcessPayload struct {
	PhotoID uuid.UUID `json:"photo_id"`
}

// StatsAggregatePayload — дата агрегации в формате YYYY-MM-DD (UTC).
// Пустая дата = вчера (для периодического запуска по cron).
type StatsAggregatePayload struct {
	Date string `json:"date"`
}

func NewStatsAggregate(date string) (*asynq.Task, error) {
	payload, err := json.Marshal(StatsAggregatePayload{Date: date})
	if err != nil {
		return nil, fmt.Errorf("marshal stats:aggregate payload: %w", err)
	}
	return asynq.NewTask(TypeStatsAggregate, payload,
		asynq.MaxRetry(3),
		asynq.Timeout(10*time.Minute),
	), nil
}

func NewPhotoProcess(photoID uuid.UUID) (*asynq.Task, error) {
	payload, err := json.Marshal(PhotoProcessPayload{PhotoID: photoID})
	if err != nil {
		return nil, fmt.Errorf("marshal photo:process payload: %w", err)
	}
	return asynq.NewTask(TypePhotoProcess, payload,
		asynq.MaxRetry(5),
		asynq.Timeout(2*time.Minute),
	), nil
}
