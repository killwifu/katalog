-- +goose Up
-- Тарифы v2 (макет 18 · «Подписка»): Бесплатный / Стандарт / Про / Бизнес,
-- оплата за месяц или год, пробный «Про» на 7 дней, переход выше с доплатой
-- разницы и переход ниже с конца оплаченного периода.

-- basic переименовывается в standard, а не заводится заново: значение enum
-- удалить нельзя, а переименование переносит все строки (shops, subscriptions,
-- payments) вместе с оплаченным сроком — ничего пересчитывать не нужно.
ALTER TYPE shop_plan RENAME VALUE 'basic' TO 'standard';
ALTER TYPE shop_plan ADD VALUE IF NOT EXISTS 'business' AFTER 'pro';

CREATE TYPE billing_period AS ENUM ('month', 'year');

-- next_plan/next_period — переход ниже, запланированный на конец оплаченного
-- периода: применяется при очередном автосписании.
ALTER TABLE subscriptions
    ADD COLUMN period      billing_period NOT NULL DEFAULT 'month',
    ADD COLUMN next_plan   shop_plan,
    ADD COLUMN next_period billing_period;

-- kind: period — оплата периода (новый, продление, после окончания);
-- upgrade — доплата разницы до конца текущего периода (дата списания та же);
-- switch — переход на год: период начинается сразу, остаток месяца засчитан.
-- from_plan и period_start/period_end — для истории платежей.
ALTER TABLE payments
    ADD COLUMN period       billing_period NOT NULL DEFAULT 'month',
    ADD COLUMN kind         text NOT NULL DEFAULT 'period'
        CHECK (kind IN ('period', 'upgrade', 'switch')),
    ADD COLUMN from_plan    shop_plan,
    ADD COLUMN period_start timestamptz,
    ADD COLUMN period_end   timestamptz;

-- Пробный «Про»: когда закончится (или закончился). NULL — не брали.
ALTER TABLE shops ADD COLUMN trial_ends_at timestamptz;

-- Новая модель окончания оплаты: аккаунт переходит на Бесплатный, витрина
-- работает (вместо grace -> suspended). Магазины, уже ушедшие в grace или
-- скрытые за неоплату, переводятся на Бесплатный сразу.
UPDATE subscriptions s SET status = 'expired', updated_at = now()
FROM shops sh
WHERE s.shop_id = sh.id AND sh.billing_state <> 'ok' AND s.status <> 'expired';
UPDATE shops SET plan = 'free', paid_until = NULL, billing_state = 'ok', updated_at = now()
WHERE billing_state <> 'ok';

-- Сверх лимита на Бесплатном загруженное остаётся на витрине (макет 18 ·
-- «Пробный период закончился»): скрытие альбомов тарифом больше не применяется.
UPDATE albums SET hidden_by_plan = false, updated_at = now() WHERE hidden_by_plan;

-- +goose Down
ALTER TABLE shops DROP COLUMN trial_ends_at;
ALTER TABLE payments
    DROP COLUMN period, DROP COLUMN kind, DROP COLUMN from_plan,
    DROP COLUMN period_start, DROP COLUMN period_end;
ALTER TABLE subscriptions DROP COLUMN period, DROP COLUMN next_plan, DROP COLUMN next_period;
DROP TYPE billing_period;
-- 'business' из enum удалить нельзя (ограничение Postgres).
ALTER TYPE shop_plan RENAME VALUE 'standard' TO 'basic';
