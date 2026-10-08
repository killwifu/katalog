import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Plan, type PlanInfo, errorText } from '../api'
import { PLAN_NAMES } from '../lib/plans'
import { useShop } from './AppLayout'

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
  if (billing.isError) return <p className="text-danger" role="alert">Не удалось загрузить тариф.</p>

  const b = billing.data
  const photoPct = Math.min(100, Math.round((b.usage.photos / b.limits.max_photos) * 100))
  const storagePct = Math.min(
    100,
    Math.round((b.usage.storage_used / b.limits.max_storage) * 100),
  )

  return (
    <div>
      <div className="page__head">
        <h1>Тариф и оплата</h1>
      </div>

      {/* Статус неоплаты здесь не повторяем: его показывает баннер
          AppLayout на всех экранах, и на этой странице было два почти
          одинаковых предупреждения подряд. */}
      <section className="box">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
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
            <CancelRenew
              paidUntil={b.paid_until}
              pending={cancel.isPending}
              onConfirm={() => cancel.mutate()}
            />
          )}
        </div>
        {b.subscription?.status === 'canceled' && b.paid_until && (
          <p className="mb-3 text-sm text-ink-2">
            Автопродление отключено — тариф действует до {formatDate(b.paid_until)}.
          </p>
        )}
        <UsageBar
          label={`Фото: ${b.usage.photos.toLocaleString('ru-RU')} из ${b.limits.max_photos.toLocaleString('ru-RU')}`}
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
            currentPrice={b.limits.price_rub}
            paidUntil={b.paid_until}
            onSubscribe={() => subscribe.mutate(plan.id)}
            busy={subscribe.isPending}
          />
        ))}
      </div>
      {/* Причину называем словами: «попробуйте ещё раз» при отключённых
          платежах отправляет продавца в бесконечный цикл — повтор
          не поможет никогда. */}
      {subscribe.isError && (
        <p className="mt-4 text-sm text-danger" role="alert">{errorText(subscribe.error)}</p>
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
      <div className={`prog ${pct >= 90 ? 'prog--warn' : ''}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// Отключение автопродления в два шага и с датой: одиночный текстовый
// клик снимал подписку молча, а до какого числа тариф ещё действует,
// продавец узнавал уже после.
function CancelRenew({
  paidUntil,
  pending,
  onConfirm,
}: {
  paidUntil: string | null
  pending: boolean
  onConfirm: () => void
}) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button onClick={() => setAsking(true)} className="btn btn--quiet text-sm">
        Отключить автопродление
      </button>
    )
  }
  return (
    // На телефоне подтверждение сжималось в узкую колонку рядом с названием
    // тарифа — переносим его на свою строку во всю ширину.
    <div className="w-full sm:w-auto sm:text-right">
      <p className="text-sm text-ink-2">
        Тариф продолжит действовать{paidUntil ? ` до ${formatDate(paidUntil)}` : ''}, дальше
        витрина перейдёт на бесплатный.
      </p>
      <div className="mt-2 flex gap-2 sm:justify-end">
        <button onClick={() => setAsking(false)} className="btn btn--ghost btn--sm">
          Оставить
        </button>
        <button onClick={onConfirm} disabled={pending} className="btn btn--danger btn--sm">
          Отключить
        </button>
      </div>
    </div>
  )
}

function PlanCard({
  plan,
  current,
  currentPrice,
  paidUntil,
  onSubscribe,
  busy,
}: {
  plan: PlanInfo
  current: boolean
  currentPrice: number
  paidUntil: string | null
  onSubscribe: () => void
  busy: boolean
}) {
  return (
    <div
      className={`box !mb-0 ${current ? 'border-brand' : 'border-line'}`}
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
      ) : plan.price_rub > currentPrice ? (
        <button
          onClick={onSubscribe}
          disabled={busy}
          className="btn btn--primary w-full"
        >
          Подключить
        </button>
      ) : (
        /* Карточка тарифа ниже текущего рисовалась пустой: продавец видел
           колонку без единого действия и не понимал, как понизиться. */
        <p className="text-sm text-ink-2">
          Ниже текущего. Витрина перейдёт сюда сама
          {paidUntil ? ` после ${formatDate(paidUntil)}` : ''}, если отключить автопродление.
        </p>
      )}
    </div>
  )
}
