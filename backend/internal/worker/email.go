package worker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/hibiken/asynq"

	"katalog/backend/internal/mail"
	"katalog/backend/internal/tasks"
)

// HandleEmailSend — отправка транзакционного письма через настроенный
// провайдер (SMTP или лог). Ошибки провайдера ретраятся asynq.
func (p *Processor) HandleEmailSend(ctx context.Context, t *asynq.Task) error {
	var payload tasks.EmailSendPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %v: %w", err, asynq.SkipRetry)
	}
	if err := p.Mail.Send(ctx, mail.Message{
		To:      payload.To,
		Subject: payload.Subject,
		Text:    payload.Text,
	}); err != nil {
		return fmt.Errorf("send email: %w", err)
	}
	return nil
}
