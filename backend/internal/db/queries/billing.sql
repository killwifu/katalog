-- Подписки, платежи ЮKassa и биллинговый жизненный цикл магазинов.

-- name: GetSubscriptionByShop :one
SELECT * FROM subscriptions
WHERE shop_id = $1;

-- Успешная оплата: создать подписку или продлить существующую.
-- Период продлевается от текущего конца, если он в будущем, иначе от now().
-- name: UpsertSubscriptionPaid :one
INSERT INTO subscriptions (shop_id, plan, status, period_start, period_end, payment_method_id)
VALUES ($1, $2, 'active', now(), now() + make_interval(days => $3), $4)
ON CONFLICT (shop_id) DO UPDATE SET
    plan              = EXCLUDED.plan,
    status            = 'active',
    period_end        = greatest(subscriptions.period_end, now()) + make_interval(days => $3),
    payment_method_id = coalesce(EXCLUDED.payment_method_id, subscriptions.payment_method_id),
    updated_at        = now()
RETURNING *;

-- Отмена автопродления: подписка живёт до конца оплаченного периода.
-- name: CancelSubscription :execrows
UPDATE subscriptions
SET status = 'canceled', updated_at = now()
WHERE shop_id = $1 AND status = 'active';

-- name: CreatePayment :one
INSERT INTO payments (shop_id, plan, amount, currency, recurring)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: SetPaymentProvider :exec
UPDATE payments
SET provider_payment_id = $2, updated_at = now()
WHERE id = $1;

-- name: SetPaymentStatus :exec
UPDATE payments
SET status = $2, updated_at = now()
WHERE id = $1;

-- name: GetPaymentByProviderID :one
SELECT * FROM payments
WHERE provider_payment_id = $1;

-- Идемпотентность вебхука: перевод из pending срабатывает ровно один раз,
-- повторная доставка события не находит строку и становится no-op.
-- name: SettlePayment :one
UPDATE payments
SET status = $2, updated_at = now()
WHERE provider_payment_id = $1 AND status = 'pending'
RETURNING *;

-- name: SetShopPaid :exec
UPDATE shops
SET plan = $2, billing_state = 'ok', paid_until = $3, updated_at = now()
WHERE id = $1;

-- Лимит фото тарифа: слот занимают все фото, кроме failed.
-- name: CountShopPhotos :one
SELECT count(*) FROM photos
WHERE shop_id = $1 AND status != 'failed';

-- Жизненный цикл: оплата истекла -> grace (загрузка заблокирована).
-- name: ShopsEnterGrace :many
UPDATE shops
SET billing_state = 'grace', updated_at = now()
WHERE plan != 'free' AND billing_state = 'ok'
  AND paid_until IS NOT NULL AND paid_until < now()
RETURNING id, slug, name, owner_id;

-- Grace истёк -> suspended (витрина скрыта, контент не удаляется).
-- name: ShopsEnterSuspended :many
UPDATE shops
SET billing_state = 'suspended', updated_at = now()
WHERE plan != 'free' AND billing_state = 'grace'
  AND paid_until < now() - make_interval(days => $1)
RETURNING id, slug, name, owner_id;

-- name: MarkSubscriptionsPastDue :exec
UPDATE subscriptions s
SET status = 'past_due', updated_at = now()
FROM shops sh
WHERE s.shop_id = sh.id AND sh.billing_state = 'grace' AND s.status = 'active';

-- name: MarkSubscriptionsExpired :exec
UPDATE subscriptions s
SET status = 'expired', updated_at = now()
FROM shops sh
WHERE s.shop_id = sh.id AND sh.billing_state = 'suspended'
  AND s.status IN ('active', 'past_due', 'canceled');

-- Рекуррентные списания: активные подписки с сохранённым способом оплаты,
-- истекающие в ближайшие сутки, без незавершённого рекуррентного платежа.
-- name: ListSubscriptionsToRenew :many
SELECT s.* FROM subscriptions s
WHERE s.status = 'active'
  AND s.payment_method_id IS NOT NULL
  AND s.period_end < now() + interval '1 day'
  AND NOT EXISTS (
      -- Незакрытый платёж блокирует повторное списание, но только пока он
      -- действительно может завершиться. Без срока одно недоставленное
      -- уведомление замораживало продления магазина навсегда: подписка
      -- тихо уходила в grace и дальше в suspended при рабочей карте.
      SELECT 1 FROM payments p
      WHERE p.shop_id = s.shop_id AND p.recurring AND p.status = 'pending'
        AND p.created_at > now() - make_interval(hours => sqlc.arg(pending_hours)::int)
  );

-- Платежи, застрявшие в pending: уведомление о финальном статусе не дошло.
-- Сверяются с ЮKassa отдельной задачей — см. HandleBillingReconcile.
-- name: ListStuckPayments :many
SELECT id, shop_id, provider_payment_id, created_at FROM payments
WHERE status = 'pending'
  AND created_at < now() - make_interval(mins => sqlc.arg(older_than_minutes)::int)
ORDER BY created_at
LIMIT 100;

-- Приближение к лимиту хранилища: письмо шлём один раз при переходе через
-- порог, поэтому отбираем только тех, кто ещё не предупреждён сегодня.
-- name: ShopsNearStorageLimit :many
SELECT s.id, s.name, s.slug, s.storage_used, u.email
FROM shops s
JOIN users u ON u.id = s.owner_id
WHERE s.status = 'active'
  AND s.billing_state = 'ok'
  AND u.email IS NOT NULL
  AND s.storage_used >= ($1::bigint * 9 / 10)
  AND s.storage_used < $1::bigint;
