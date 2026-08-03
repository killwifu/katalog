-- +goose Up
-- Этап 3: тарифы и платежи (ЮKassa).

-- Новый тариф basic между free и pro.
ALTER TYPE shop_plan ADD VALUE IF NOT EXISTS 'basic' BEFORE 'pro';

-- Биллинговый жизненный цикл магазина:
-- ok -> grace (загрузка заблокирована, витрина работает) ->
-- suspended (витрина скрыта). Контент НЕ удаляется.
CREATE TYPE billing_state AS ENUM ('ok', 'grace', 'suspended');
CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'canceled');

ALTER TABLE shops
    ADD COLUMN billing_state billing_state NOT NULL DEFAULT 'ok',
    ADD COLUMN paid_until timestamptz;

-- Одна подписка на магазин (upsert по shop_id);
-- payment_method_id — сохранённый способ оплаты ЮKassa для рекуррентных списаний.
ALTER TABLE subscriptions
    ADD COLUMN payment_method_id text,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT subscriptions_shop_id_key UNIQUE (shop_id);
DROP INDEX subscriptions_shop_id_idx; -- дублируется unique-констрейнтом

-- Платежи ЮKassa. provider_payment_id уникален: повторная доставка
-- вебхука по тому же платежу идемпотентна.
CREATE TABLE payments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id             uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    plan                shop_plan NOT NULL,
    amount              bigint NOT NULL, -- копейки
    currency            text NOT NULL DEFAULT 'RUB',
    provider_payment_id text UNIQUE,
    status              payment_status NOT NULL DEFAULT 'pending',
    recurring           boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_shop_id_idx ON payments (shop_id);

-- +goose Down
DROP TABLE payments;
ALTER TABLE subscriptions
    DROP CONSTRAINT subscriptions_shop_id_key,
    DROP COLUMN payment_method_id,
    DROP COLUMN updated_at;
CREATE INDEX subscriptions_shop_id_idx ON subscriptions (shop_id);
ALTER TABLE shops
    DROP COLUMN billing_state,
    DROP COLUMN paid_until;
DROP TYPE payment_status;
DROP TYPE billing_state;
-- Значение 'basic' из enum shop_plan удалить нельзя (ограничение Postgres).
