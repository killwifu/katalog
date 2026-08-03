// Package mail — транзакционная почта: абстракция Sender и провайдеры.
// Письма отправляются асинхронно через asynq-задачу email:send (см. worker),
// поэтому провайдер нужен только воркеру.
package mail

import (
	"context"
	"fmt"
	"log/slog"
	"mime"
	"net/smtp"
	"strings"

	"katalog/backend/internal/config"
)

type Message struct {
	To      string
	Subject string
	Text    string
}

type Sender interface {
	Send(ctx context.Context, msg Message) error
}

// New — провайдер из конфига: SMTP, если задан хост, иначе лог (dev-режим).
func New(cfg config.MailConfig, log *slog.Logger) Sender {
	if cfg.SMTPHost == "" {
		return &LogSender{Log: log}
	}
	return &SMTPSender{cfg: cfg}
}

// SMTPSender шлёт через net/smtp (STARTTLS, если сервер поддерживает).
type SMTPSender struct {
	cfg config.MailConfig
}

func (s *SMTPSender) Send(_ context.Context, msg Message) error {
	var auth smtp.Auth
	if s.cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", s.cfg.SMTPUser, s.cfg.SMTPPass, s.cfg.SMTPHost)
	}
	addr := fmt.Sprintf("%s:%d", s.cfg.SMTPHost, s.cfg.SMTPPort)
	if err := smtp.SendMail(addr, auth, s.cfg.From, []string{msg.To}, buildRFC822(s.cfg.From, msg)); err != nil {
		return fmt.Errorf("smtp send to %s: %w", msg.To, err)
	}
	return nil
}

// buildRFC822 собирает простое text/plain письмо в UTF-8.
func buildRFC822(from string, msg Message) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + msg.To + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", msg.Subject) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("\r\n")
	b.WriteString(msg.Text)
	return []byte(b.String())
}

// LogSender — dev-режим без SMTP: письмо целиком уходит в лог.
type LogSender struct {
	Log *slog.Logger
}

func (l *LogSender) Send(_ context.Context, msg Message) error {
	l.Log.Info("email (log sender)", "to", msg.To, "subject", msg.Subject, "text", msg.Text)
	return nil
}
