// Package revalidate — best-effort уведомление витрины (Next.js) об
// изменении данных магазина: POST {storefront}/api/revalidate с shared
// secret. Ошибки только логируются — на витрине есть TTL-фолбэк 60 сек.
package revalidate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

const (
	// SecretHeader — заголовок с shared secret вебхука Go -> Next.
	SecretHeader = "X-Revalidate-Secret"
	timeout      = 5 * time.Second
)

type Notifier struct {
	endpoint string
	secret   string
	client   *http.Client
	log      *slog.Logger
}

// New создаёт нотификатор. При пустых storefrontURL или secret все вызовы
// становятся no-op (локальная разработка без витрины).
func New(storefrontURL, secret string, log *slog.Logger) *Notifier {
	n := &Notifier{
		secret: secret,
		client: &http.Client{Timeout: timeout},
		log:    log,
	}
	if storefrontURL != "" && secret != "" {
		n.endpoint = strings.TrimRight(storefrontURL, "/") + "/api/revalidate"
	}
	return n
}

// Shop асинхронно инвалидирует ISR-кеш страниц магазина (тег shop:{slug}).
func (n *Notifier) Shop(slug string) {
	if n == nil || n.endpoint == "" {
		return
	}
	go func() {
		if err := n.send(slug); err != nil {
			n.log.Warn("revalidate webhook failed", "slug", slug, "error", err)
		}
	}()
}

func (n *Notifier) send(slug string) error {
	body, err := json.Marshal(map[string]string{"slug": slug})
	if err != nil {
		return fmt.Errorf("marshal body: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SecretHeader, n.secret)
	resp, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("post %s: %w", n.endpoint, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("post %s: status %d", n.endpoint, resp.StatusCode)
	}
	return nil
}
