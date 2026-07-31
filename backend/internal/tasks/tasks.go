// Package tasks — типы asynq-задач, общие для api (producer) и worker.
package tasks

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
)

const TypePhotoProcess = "photo:process"

type PhotoProcessPayload struct {
	PhotoID uuid.UUID `json:"photo_id"`
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
