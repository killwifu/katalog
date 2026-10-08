package api

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"katalog/backend/internal/db"
)

// inOrderLock выполняет fn в транзакции под advisory-замком «порядок в магазине».
//
// Новые категории, вкладки и разделы получают номер max(sort_order)+1 прямо в
// INSERT. Без замка параллельные создания читают один и тот же максимум и
// получают одинаковые номера (на стенде из десяти вкладок пять встали на 3 и
// пять на 4) — порядок на витрине становится случайным. Один запрос это не
// лечит: снимок данных берётся раньше, чем захватывается замок.
func (a *API) inOrderLock(ctx context.Context, shopID uuid.UUID, fn func(q *db.Queries) error) error {
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := a.Q.WithTx(tx)
	if err := q.LockShopForUpload(ctx, "order:"+shopID.String()); err != nil {
		return fmt.Errorf("lock order: %w", err)
	}
	if err := fn(q); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
