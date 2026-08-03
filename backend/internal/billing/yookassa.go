// Package billing — клиент REST API ЮKassa (https://yookassa.ru/developers).
// Уведомления (вебхуки) ЮKassa не подписаны, поэтому каждое уведомление
// перепроверяется прямым запросом GET /payments/{id} к API ЮKassa —
// обработчик вебхука доверяет только этому ответу.
package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const (
	// Статусы платежа ЮKassa.
	StatusPending   = "pending"
	StatusSucceeded = "succeeded"
	StatusCanceled  = "canceled"
)

type Client struct {
	baseURL   string
	shopID    string
	secretKey string
	http      *http.Client
}

func New(baseURL, shopID, secretKey string) *Client {
	return &Client{
		baseURL:   baseURL,
		shopID:    shopID,
		secretKey: secretKey,
		http:      &http.Client{Timeout: 15 * time.Second},
	}
}

// Enabled — заданы ли учётные данные ЮKassa (иначе платежи выключены).
func (c *Client) Enabled() bool {
	return c.shopID != "" && c.secretKey != ""
}

type Amount struct {
	Value    string `json:"value"` // десятичная строка: "490.00"
	Currency string `json:"currency"`
}

type Confirmation struct {
	Type            string `json:"type"`
	ReturnURL       string `json:"return_url,omitempty"`
	ConfirmationURL string `json:"confirmation_url,omitempty"`
}

type PaymentMethod struct {
	ID    string `json:"id"`
	Saved bool   `json:"saved"`
}

type Payment struct {
	ID            string            `json:"id"`
	Status        string            `json:"status"`
	Amount        Amount            `json:"amount"`
	Confirmation  *Confirmation     `json:"confirmation,omitempty"`
	PaymentMethod *PaymentMethod    `json:"payment_method,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

type CreatePaymentRequest struct {
	Amount      Amount `json:"amount"`
	Capture     bool   `json:"capture"`
	Description string `json:"description,omitempty"`
	// Confirmation — redirect-подтверждение для первого платежа.
	Confirmation *Confirmation `json:"confirmation,omitempty"`
	// SavePaymentMethod — сохранить способ оплаты для рекуррентных списаний.
	SavePaymentMethod bool `json:"save_payment_method,omitempty"`
	// PaymentMethodID — сохранённый способ оплаты (рекуррентный платёж без 3DS).
	PaymentMethodID string            `json:"payment_method_id,omitempty"`
	Metadata        map[string]string `json:"metadata,omitempty"`
}

// CreatePayment создаёт платёж. idempotenceKey (у нас — UUID строки payments)
// гарантирует, что ретрай не создаст дубль платежа на стороне ЮKassa.
func (c *Client) CreatePayment(ctx context.Context, idempotenceKey string, req CreatePaymentRequest) (Payment, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return Payment{}, fmt.Errorf("marshal create payment: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/payments", bytes.NewReader(body))
	if err != nil {
		return Payment{}, fmt.Errorf("build create payment request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Idempotence-Key", idempotenceKey)
	return c.do(httpReq)
}

// GetPayment возвращает актуальное состояние платежа из ЮKassa.
func (c *Client) GetPayment(ctx context.Context, id string) (Payment, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/payments/"+url.PathEscape(id), nil)
	if err != nil {
		return Payment{}, fmt.Errorf("build get payment request: %w", err)
	}
	return c.do(httpReq)
}

func (c *Client) do(req *http.Request) (Payment, error) {
	req.SetBasicAuth(c.shopID, c.secretKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return Payment{}, fmt.Errorf("yookassa %s %s: %w", req.Method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Payment{}, fmt.Errorf("yookassa read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return Payment{}, fmt.Errorf("yookassa %s %s: status %d: %s", req.Method, req.URL.Path, resp.StatusCode, raw)
	}
	var p Payment
	if err := json.Unmarshal(raw, &p); err != nil {
		return Payment{}, fmt.Errorf("yookassa decode response: %w", err)
	}
	return p, nil
}

// FormatKopecks — сумма в копейках в десятичную строку ЮKassa ("490.00").
func FormatKopecks(k int64) string {
	return fmt.Sprintf("%d.%02d", k/100, k%100)
}
