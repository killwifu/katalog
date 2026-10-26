package errreport

import (
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/getsentry/sentry-go"
)

func TestErrorLogsBecomeSentryIssues(t *testing.T) {
	var got []*sentry.Event
	if err := sentry.Init(sentry.ClientOptions{
		Dsn: "https://public@example.invalid/1",
		BeforeSend: func(e *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			got = append(got, e)
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	log := slog.New(&handler{}).With("shop_id", "s1")

	log.Info("not an error")
	log.Warn("still not")
	log.Error("upload confirm failed", "error", errors.New("boom"), "photo_id", "p1")
	log.Error("plain message")

	if len(got) != 2 {
		t.Fatalf("events: %d, want 2 (только Error)", len(got))
	}
	e := got[0]
	if len(e.Exception) == 0 || !strings.Contains(e.Exception[len(e.Exception)-1].Value, "upload confirm failed: boom") {
		t.Errorf("exception: %+v", e.Exception)
	}
	if len(e.Fingerprint) != 1 || e.Fingerprint[0] != "upload confirm failed" {
		t.Errorf("fingerprint %v, want сообщение лога", e.Fingerprint)
	}
	if e.Contexts["log"]["shop_id"] != "s1" || e.Contexts["log"]["photo_id"] != "p1" {
		t.Errorf("context %v", e.Contexts["log"])
	}
	if got[1].Message != "plain message" {
		t.Errorf("message %q", got[1].Message)
	}
}
