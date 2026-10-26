// Package errreport — логгер сервиса: JSON в stdout, а при заданном
// SENTRY_DSN записи уровня Error ещё и уходят в Sentry как Issues.
//
// Отдельной обвязки вокруг ошибок нет: всё, что сервис логирует как Error
// (internalError в API, «task <тип> failed» в воркере), и есть то, о чём надо знать.
package errreport

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/getsentry/sentry-go"
)

// New возвращает логгер и flush — вызвать перед выходом, чтобы не потерять
// последние события. Окружение и релиз sentry-go берёт из SENTRY_ENVIRONMENT
// и SENTRY_RELEASE.
func New(component string) (*slog.Logger, func()) {
	stdout := slog.NewJSONHandler(os.Stdout, nil)
	dsn := os.Getenv("SENTRY_DSN")
	if dsn == "" {
		return slog.New(stdout), func() {}
	}
	logger := slog.New(stdout)
	if err := sentry.Init(sentry.ClientOptions{
		Dsn:        dsn,
		ServerName: component,
		// IP, cookies и заголовки авторизации наружу не уходят.
		SendDefaultPII: false,
	}); err != nil {
		logger.Error("sentry init failed, errors stay in logs only", "error", err)
		return logger, func() {}
	}
	return slog.New(slog.NewMultiHandler(stdout, &handler{})), func() { sentry.Flush(2 * time.Second) }
}

type handler struct{ attrs []slog.Attr }

func (h *handler) Enabled(_ context.Context, l slog.Level) bool { return l >= slog.LevelError }

func (h *handler) Handle(_ context.Context, r slog.Record) error {
	var err error
	extra := map[string]any{}
	add := func(a slog.Attr) {
		if e, ok := a.Value.Any().(error); ok && a.Key == "error" {
			err = e
			return
		}
		extra[a.Key] = a.Value.String()
	}
	for _, a := range h.attrs {
		add(a)
	}
	r.Attrs(func(a slog.Attr) bool { add(a); return true })

	hub := sentry.CurrentHub().Clone()
	hub.WithScope(func(s *sentry.Scope) {
		// Стек у всех событий одинаковый (этот обработчик), поэтому группируем
		// по сообщению: «upload confirm failed» — одна Issue, сколько бы раз
		// она ни повторилась.
		s.SetFingerprint([]string{r.Message})
		s.SetContext("log", extra)
		if err != nil {
			hub.CaptureException(fmt.Errorf("%s: %w", r.Message, err))
		} else {
			hub.CaptureMessage(r.Message)
		}
	})
	return nil
}

func (h *handler) WithAttrs(as []slog.Attr) slog.Handler {
	return &handler{attrs: append(append([]slog.Attr{}, h.attrs...), as...)}
}

// Группы в проекте не используются; атрибуты внутри группы уйдут без префикса.
func (h *handler) WithGroup(string) slog.Handler { return h }
