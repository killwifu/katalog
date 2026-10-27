-- Подписки, платежи ЮKassa и биллинговый жизненный цикл магазинов.

-- name: GetSubscriptionByShop :one
SELECT * FROM subscriptions
WHERE shop_id = $1;

-- Успешная оплата: подписка создаётся или переписывается целиком — сроки
-- и тариф считает settlePaymentSucceeded (в транзакции, под блокировкой
-- платежа), запрос только сохраняет. Запланированный переход ниже
-- снимается: оплата и есть выбор тарифа.
-- name: UpsertSubscriptionPaid :one
INSERT INTO subscriptions (shop_id, plan, period, status, period_start, period_end, payment_method_id)
VALUES ($1, $2, $3, 'active', $4, $5, $6)
ON CONFLICT (shop_id) DO UPDATE SET
    plan              = EXCLUDED.plan,
    period            = EXCLUDED.period,
    status            = 'active',
    period_start      = EXCLUDED.period_start,
    period_end        = EXCLUDED.period_end,
    payment_method_id = coalesce(EXCLUDED.payment_method_id, subscriptions.payment_method_id),
    next_plan         = NULL,
    next_period       = NULL,
    updated_at        = now()
RETURNING *;

-- Отмена автопродления: подписка живёт до конца оплаченного периода,
-- запланированный переход ниже тоже отменяется — дальше будет Бесплатный.
-- name: CancelSubscription :execrows
UPDATE subscriptions
SET status = 'canceled', next_plan = NULL, next_period = NULL, updated_at = now()
WHERE shop_id = $1 AND status = 'active';

-- Включить автопродление обратно — без оплаты, пока период не кончился
-- и есть сохранённый способ оплаты.
-- name: ResumeSubscription :execrows
UPDATE subscriptions
SET status = 'active', updated_at = now()
WHERE shop_id = $1 AND status = 'canceled' AND period_end > now()
  AND payment_method_id IS NOT NULL;

-- Переход ниже — с конца оплаченного периода: применяется при очередном
-- автосписании. Автопродление включается, если есть чем платить.
-- name: ScheduleSubscriptionChange :execrows
UPDATE subscriptions
SET next_plan   = sqlc.arg(next_plan)::shop_plan,
    next_period = sqlc.arg(next_period)::billing_period,
    status      = CASE WHEN payment_method_id IS NOT NULL THEN 'active'::subscription_status ELSE status END,
    updated_at  = now()
WHERE shop_id = $1 AND status IN ('active', 'canceled') AND period_end > now();

-- name: CreatePayment :one
INSERT INTO payments (shop_id, plan, amount, currency, recurring, period, kind, from_plan, period_end)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- Срок, за который заплачено, — для истории платежей.
-- name: SetPaymentPeriod :exec
UPDATE payments
SET period_start = $2, period_end = $3, updated_at = now()
WHERE id = $1;

-- История платежей: новые сверху, незавершённые не показываются.
-- name: ListPayments :many
SELECT * FROM payments
WHERE shop_id = $1 AND status <> 'pending'
ORDER BY created_at DESC
LIMIT 100;

-- Последняя оплата, начатая продавцом (не автосписание), — для плашки
-- «Оплата не прошла».
-- name: LastManualPayment :one
SELECT * FROM payments
WHERE shop_id = $1 AND NOT recurring AND status <> 'pending'
ORDER BY created_at DESC
LIMIT 1;

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
WHERE shop_id = $1 AND status != 'failed' AND deleted_at IS NULL;

-- Пробный «Про» на 7 дней: один раз на аккаунт и только тому, кто ещё
-- не платил (после платного тарифа пробный не предлагается).
-- name: StartTrial :execrows
UPDATE shops
SET plan = 'pro', paid_until = now() + interval '7 days',
    trial_ends_at = now() + interval '7 days', updated_at = now()
WHERE shops.id = $1 AND shops.plan = 'free' AND shops.trial_ends_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.shop_id = shops.id)
  AND NOT EXISTS (SELECT 1 FROM shops o WHERE o.owner_id = shops.owner_id AND o.trial_ends_at IS NOT NULL);

-- Окончание оплаты или пробного периода: аккаунт переходит на Бесплатный,
-- витрина работает, контент остаётся.
-- name: ExpirePaidShops :many
UPDATE shops
SET plan = 'free', paid_until = NULL, updated_at = now()
WHERE plan <> 'free' AND paid_until IS NOT NULL AND paid_until < now()
RETURNING id, slug, name, owner_id;

-- name: ExpireSubscriptions :exec
UPDATE subscriptions
SET status = 'expired', next_plan = NULL, next_period = NULL, updated_at = now()
WHERE period_end < now() AND status IN ('active', 'past_due', 'canceled');

-- Рекуррентные списания: активные подписки с сохранённым способом оплаты,
-- истекающие в ближайшие сутки. Одна попытка на период: если автосписание
-- не прошло, повторов нет — тариф заканчивается (макет 18 · «История
-- платежей»). Прошедшее списание сдвигает period_end, и окно уезжает вперёд.
-- name: ListSubscriptionsToRenew :many
SELECT s.* FROM subscriptions s
WHERE s.status = 'active'
  AND s.payment_method_id IS NOT NULL
  AND s.period_end < now() + interval '1 day'
  AND s.period_end > now()
  AND NOT EXISTS (
      SELECT 1 FROM payments p
      WHERE p.shop_id = s.shop_id AND p.recurring
        AND p.created_at > s.period_end - interval '1 day'
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
  AND u.email IS NOT NULL
  AND s.storage_used >= ($1::bigint * 9 / 10)
  AND s.storage_used < $1::bigint;

-- Что лежит в «Удаленном»: фото и их объём — для блока заполненности.
-- name: TrashUsage :one
SELECT count(*)::bigint AS photos,
       coalesce(sum(orig_size + drv_size), 0)::bigint AS bytes
FROM photos
WHERE shop_id = $1 AND deleted_at IS NOT NULL;
