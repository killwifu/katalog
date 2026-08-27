import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Plan, type PlanInfo } from '../api'
import { useShop } from './AppLayout'

const PLAN_NAMES: Record<Plan, string> = {
  free: 'Бесплатный',
  basic: 'Базовый',
  pro: 'Про',
}

const STATE_LABELS = {
  ok: null,
  grace: 'Подписка не оплачена: загрузка фото заблокирована. Витрина пока работает.',
  suspended: 'Подписка не оплачена: витрина скрыта. Фото сохранены и вернутся после оплаты.',
} as const

function formatGB(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  return gb >= 1 ? `${Math.round(gb)} ГБ` : `${Math.round(bytes / 1024 / 1024)} МБ`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU')
}

export function BillingPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const billing = useQuery({
    queryKey: ['billing', shop.id],
    queryFn: () => api.getBilling(shop.id),
  })

  // После оплаты ЮKassa возвращает сюда; активация приходит вебхуком,
  // поэтому просто перечитываем статус чаще, пока платёж «в пути».
  const subscribe = useMutation({
    mutationFn: (plan: Plan) => api.subscribe(shop.id, plan),
    onSuccess: ({ confirmation_url }) => {
      window.location.href = confirmation_url
    },
  })
  const cancel = useMutation({
    mutationFn: () => api.cancelSubscription(shop.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
      void queryClient.invalidateQueries({ queryKey: ['shops'] })
    },
  })

  if (billing.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (billing.isError) return <p className="text-danger">Не удалось загрузить тариф.</p>

  const b = billing.data
  const stateMessage = STATE_LABELS[b.billing_state]
  const photoPct = Math.min(100, Math.round((b.usage.photos / b.limits.max_photos) * 100))
  const storagePct = Math.min(
    100,
    Math.round((b.usage.storage_used / b.limits.max_storage) * 100),
  )

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold text-ink">Тариф и оплата</h1>

      {stateMessage && (
        <div className="alert alert--danger">
          {stateMessage}
        </div>
      )}

      <section className="mb-6 rounded-lg border border-line bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <span className="font-medium text-ink">
              Текущий тариф: {PLAN_NAMES[b.plan]}
            </span>
            {b.paid_until && (
              <span className="ml-2 text-sm text-ink-2">
                оплачен до {formatDate(b.paid_until)}
              </span>
            )}
          </div>
          {b.subscription?.status === 'active' && b.subscription.auto_renew && (
            <button
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
              className="text-sm text-ink-2 hover:text-danger disabled:opacity-50"
            >
              Отключить автопродление
            </button>
          )}
        </div>
        {b.subscription?.status === 'canceled' && b.paid_until && (
          <p className="mb-3 text-sm text-ink-2">
            Автопродление отключено — тариф действует до {formatDate(b.paid_until)}.
          </p>
        )}
        <UsageBar
          label={`Фото: ${b.usage.photos} из ${b.limits.max_photos}`}
          pct={photoPct}
        />
        <UsageBar
          label={`Хранилище: ${formatGB(b.usage.storage_used)} из ${formatGB(b.limits.max_storage)}`}
          pct={storagePct}
        />
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        {b.plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            current={plan.id === b.plan}
            onSubscribe={() => subscribe.mutate(plan.id)}
            busy={subscribe.isPending}
          />
        ))}
      </div>
      {subscribe.isError && (
        <p className="mt-4 text-sm text-danger">
          Не удалось начать оплату. Попробуйте ещё раз.
        </p>
      )}
      <p className="mt-4 text-sm text-ink-2">
        Оплата проходит через ЮKassa. Тариф активируется автоматически после
        подтверждения платежа (обычно в течение минуты).
      </p>
    </div>
  )
}

function UsageBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex justify-between text-sm text-ink-2">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-surface-alt">
        <div
          className={`h-full rounded ${pct >= 90 ? 'bg-danger' : 'bg-brand'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function PlanCard({
  plan,
  current,
  onSubscribe,
  busy,
}: {
  plan: PlanInfo
  current: boolean
  onSubscribe: () => void
  busy: boolean
}) {
  return (
    <div
      className={`box ${current ? 'border-brand' : 'border-line'}`}
    >
      <div className="mb-1 font-semibold text-ink">{PLAN_NAMES[plan.id]}</div>
      <div className="mb-3 text-2xl font-bold text-ink">
        {plan.price_rub > 0 ? `${plan.price_rub} ₽/мес` : '0 ₽'}
      </div>
      <ul className="mb-4 space-y-1 text-sm text-ink-2">
        <li>{plan.max_photos.toLocaleString('ru-RU')} фото</li>
        <li>{formatGB(plan.max_storage)} хранилища</li>
      </ul>
      {current ? (
        <span className="text-sm font-medium text-brand">Ваш тариф</span>
      ) : plan.price_rub > 0 ? (
        <button
          onClick={onSubscribe}
          disabled={busy}
          className="btn btn--primary w-full"
        >
          Подключить
        </button>
      ) : null}
    </div>
  )
}
