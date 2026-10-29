// Package mail — транзакционная почта: абстракция Sender и провайдеры.
// Письма отправляются асинхронно через asynq-задачу email:send (см. worker),
// поэтому провайдер нужен только воркеру.
package mail

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"mime"
	"net/mail"
	"net/smtp"
	"strings"

	"katalog/backend/internal/config"
)

type Message struct {
	To      string
	Subject string
	Text    string
	// HTML — вёрстка письма; пусто = только text/plain. Text остаётся
	// альтернативой для клиентов без HTML.
	HTML string
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
	from := (&mail.Address{Name: s.cfg.FromName, Address: s.cfg.From}).String()
	if err := smtp.SendMail(addr, auth, s.cfg.From, []string{msg.To}, buildRFC822(from, msg)); err != nil {
		return fmt.Errorf("smtp send to %s: %w", msg.To, err)
	}
	return nil
}

// mimeBoundary — граница частей multipart/alternative. Base64-тела её
// содержать не могут (в алфавите base64 нет «=_»), поэтому одна на все письма.
const mimeBoundary = "=_katalog_alt_boundary"

// buildRFC822 собирает письмо в UTF-8: text/plain или, если есть HTML,
// multipart/alternative (сначала текст, потом HTML — клиент берёт последнюю
// часть, которую умеет показать). from — уже готовый заголовок «Имя <адрес>».
func buildRFC822(from string, msg Message) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + msg.To + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", msg.Subject) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	if msg.HTML == "" {
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n\r\n")
		b.WriteString(msg.Text)
		return []byte(b.String())
	}
	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + mimeBoundary + "\"\r\n\r\n")
	for _, part := range []struct{ ctype, body string }{
		{"text/plain", msg.Text},
		{"text/html", msg.HTML},
	} {
		b.WriteString("--" + mimeBoundary + "\r\n")
		b.WriteString("Content-Type: " + part.ctype + "; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		enc := base64.StdEncoding.EncodeToString([]byte(part.body))
		for len(enc) > 76 {
			b.WriteString(enc[:76] + "\r\n")
			enc = enc[76:]
		}
		b.WriteString(enc + "\r\n")
	}
	b.WriteString("--" + mimeBoundary + "--\r\n")
	return []byte(b.String())
}

// LogSender — dev-режим без SMTP: письмо целиком уходит в лог.
type LogSender struct {
	Log *slog.Logger
}

func (l *LogSender) Send(_ context.Context, msg Message) error {
	// HTML в лог не пишем целиком — по тексту видно содержание и ссылки.
	l.Log.Info("email (log sender)", "to", msg.To, "subject", msg.Subject, "text", msg.Text, "html_bytes", len(msg.HTML))
	return nil
}
