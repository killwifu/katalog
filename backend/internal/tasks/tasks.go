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
	TypePhotoProcess     = "photo:process"
	TypeStatsAggregate   = "stats:aggregate"
	TypeUploadsCleanup   = "uploads:cleanup"
	TypeStoragePurge     = "storage:purge"
	TypeBillingLifecycle = "billing:lifecycle"
	TypeBillingRenew     = "billing:renew"
	TypeBillingReconcile = "billing:reconcile"
	TypeEmailSend        = "email:send"
	TypeStatsDigest      = "stats:digest"
	TypeTrafficAlert     = "stats:traffic-alert"
)

// StatsDigestPayload — месяц дайджеста в формате YYYY-MM (UTC).
// Пустой = прошлый календарный месяц (для запуска по cron 1-го числа).
type StatsDigestPayload struct {
	Month string `json:"month"`
}

func NewStatsDigest(month string) (*asynq.Task, error) {
	payload, err := json.Marshal(StatsDigestPayload{Month: month})
	if err != nil {
		return nil, fmt.Errorf("marshal stats:digest payload: %w", err)
	}
	return asynq.NewTask(TypeStatsDigest, payload,
		asynq.MaxRetry(3),
		asynq.Timeout(30*time.Minute),
	), nil
}

// TrafficAlertPayload — дата проверки в формате YYYY-MM-DD (UTC).
// Пустая = вчера (запуск по cron после ночной агрегации).
type TrafficAlertPayload struct {
	Date string `json:"date"`
}

func NewTrafficAlert(date string) (*asynq.Task, error) {
	payload, err := json.Marshal(TrafficAlertPayload{Date: date})
	if err != nil {
		return nil, fmt.Errorf("marshal stats:traffic-alert payload: %w", err)
	}
	return asynq.NewTask(TypeTrafficAlert, payload,
		asynq.MaxRetry(3),
		asynq.Timeout(10*time.Minute),
	), nil
}

type EmailSendPayload struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Text    string `json:"text"`
}

// NewEmailSend — асинхронная отправка письма воркером (ретраи бесплатно).
func NewEmailSend(to, subject, text string) (*asynq.Task, error) {
	payload, err := json.Marshal(EmailSendPayload{To: to, Subject: subject, Text: text})
	if err != nil {
		return nil, fmt.Errorf("marshal email:send payload: %w", err)
	}
	return asynq.NewTask(TypeEmailSend, payload,
		asynq.MaxRetry(5),
		asynq.Timeout(time.Minute),
	), nil
}

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

// NewBillingLifecycle — ежедневные переходы биллинговых состояний магазинов
// (ok -> grace -> suspended). Без payload, идемпотентна.
func NewBillingLifecycle() *asynq.Task {
	return asynq.NewTask(TypeBillingLifecycle, nil,
		asynq.MaxRetry(3),
		asynq.Timeout(10*time.Minute),
	)
}

// NewUploadsCleanup — уборка зависших загрузок: фото, оставшихся в статусе
// uploading, потому что confirm до сервера не дошёл. Они занимают квоту
// продавца и место в S3, а вернуть их уже нечем.
func NewUploadsCleanup() *asynq.Task {
	return asynq.NewTask(TypeUploadsCleanup, nil,
		asynq.MaxRetry(3),
		asynq.Timeout(10*time.Minute),
	)
}

// NewBillingRenew — ежедневные рекуррентные списания по истекающим подпискам.
func NewBillingRenew() *asynq.Task {
	return asynq.NewTask(TypeBillingRenew, nil,
		asynq.MaxRetry(3),
		asynq.Timeout(10*time.Minute),
	)
}

// NewBillingReconcile — сверка зависших платежей с ЮKassa: уведомление
// о финальном статусе могло не дойти, а платёж в pending блокирует
// следующее списание.
func NewBillingReconcile() *asynq.Task {
	return asynq.NewTask(TypeBillingReconcile, nil, asynq.MaxRetry(3), asynq.Timeout(5*time.Minute))
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

// StoragePurgePayload — объекты, оставшиеся в S3 после каскадного удаления
// строк. Пустой PhotoIDs означает «весь магазин»: при удалении магазина
// перечислять фото уже негде.
type StoragePurgePayload struct {
	ShopID   uuid.UUID   `json:"shop_id"`
	PhotoIDs []uuid.UUID `json:"photo_ids"`
}

// NewStoragePurge — уборка объектов S3 после удаления альбома или магазина.
// Отдельной задачей, потому что альбом на тысячу фото — это тысячи запросов
// к хранилищу, и держать на них HTTP-соединение продавца нельзя.
func NewStoragePurge(shopID uuid.UUID, photoIDs []uuid.UUID) (*asynq.Task, error) {
	payload, err := json.Marshal(StoragePurgePayload{ShopID: shopID, PhotoIDs: photoIDs})
	if err != nil {
		return nil, fmt.Errorf("marshal storage:purge payload: %w", err)
	}
	return asynq.NewTask(TypeStoragePurge, payload,
		asynq.MaxRetry(5),
		asynq.Timeout(30*time.Minute),
	), nil
}
