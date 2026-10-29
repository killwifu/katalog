import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  api,
  errorText,
  type Billing,
  type BillingPeriod,
  type BillingQuote,
  type Payment,
  type Plan,
  type PlanInfo,
} from '../api'
import { Icon } from '../lib/icons'
import { Portal } from '../lib/Portal'
import { PLAN_FEATURES, PLAN_NAMES, PLAN_ORDER, PLAN_TAGLINES, PlanBars } from '../lib/plans'
import { useDialogClose } from '../lib/useDialogClose'
import { plural } from '../lib/uploadRun'
import { useShop } from './AppLayout'
import { Toast } from './Toast'

// Раздел «Подписка» по макету 18: текущий тариф и заполненность, свитч
// «Помесячно / За год», 4 тарифа карточками и таблица сравнения. Суммы
// доплат и даты считает сервер (GET /billing/quote) — те же, что уйдут
// в ЮKassa.

const num = (n: number) => n.toLocaleString('ru-RU')
const rub = (n: number) => `${num(n)} ₽`
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU')
const DAY = 86_400_000

function size(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${(Math.round(gb * 10) / 10).toString().replace('.', ',')} ГБ`
  return `${Math.round(bytes / 1024 ** 2)} МБ`
}

// «Разница между «Про» и «Бизнесом»» — название тарифа в творительном падеже.
const PLAN_WITH: Record<Plan, string> = {
  free: 'Бесплатным',
  standard: 'Стандартом',
  pro: 'Про',
  business: 'Бизнесом',
}

type Ask =
  | { type: 'pay'; quote: BillingQuote }
  | { type: 'down'; quote: BillingQuote }
  | { type: 'cancel' }
  | { type: 'history' }

export function BillingPage() {
  const shop = useShop()
  const queryClient = useQueryClient()
  const billing = useQuery({ queryKey: ['billing', shop.id], queryFn: () => api.getBilling(shop.id) })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  // Тариф с лендинга для вошедшего продавца (заметка макета 02):
  // /app/billing?plan=…&period=year — свитч на этом периоде и сразу окно
  // перехода на тариф. «Про» с доступным пробным периодом окна не открывает:
  // в карточке и так кнопка «Пробный период».
  const [wanted] = useState(() => {
    const q = new URLSearchParams(location.search)
    const plan = q.get('plan') as Plan | null
    return { plan: plan && PLAN_ORDER.includes(plan) ? plan : null, year: q.get('period') === 'year' }
  })
  const [year, setYear] = useState(wanted.year)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  // Вернулись из ЮKassa: return_url несёт ?payment=<id>. Ждём, пока вебхук
  // доведёт платёж до финала, и показываем тост или плашку «не прошла».
  const [returned] = useState(() => new URLSearchParams(location.search).get('payment'))
  // «Сейчас» фиксируется при открытии страницы: счёт идёт на дни.
  const [now] = useState(() => Date.now())
  const waitUntil = now + 60_000
  const payments = useQuery({
    queryKey: ['payments', shop.id],
    queryFn: () => api.listPayments(shop.id),
    enabled: Boolean(returned) || ask?.type === 'history',
    refetchInterval: (q) =>
      returned && !q.state.data?.payments.some((p) => p.id === returned) && Date.now() < waitUntil ? 2000 : false,
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['billing', shop.id] })
    void queryClient.invalidateQueries({ queryKey: ['shops'] })
  }

  const settled = returned ? payments.data?.payments.find((x) => x.id === returned) : undefined
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (!settled) return
    history.replaceState(null, '', location.pathname)
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled?.id])
  const wantedDone = useRef(false)
  const shownToast = toast || (settled?.status === 'succeeded' && !seen ? `Тариф «${PLAN_NAMES[settled.plan]}» подключён` : '')

  const pay = useMutation({
    mutationFn: ({ plan, period }: { plan: Plan; period: BillingPeriod }) => api.subscribe(shop.id, plan, period),
    onSuccess: (res) => {
      if (res.confirmation_url) {
        window.location.href = res.confirmation_url
        return
      }
      setAsk(null)
      refresh()
    },
    onError: (e) => {
      setAsk(null)
      setError(errorText(e))
    },
  })
  const choose = useMutation({
    mutationFn: ({ plan, period }: { plan: Plan; period: BillingPeriod }) => api.quote(shop.id, plan, period),
    onSuccess: (quote) => {
      if (quote.action === 'pay') setAsk({ type: 'pay', quote })
      else if (quote.action === 'schedule') setAsk({ type: 'down', quote })
    },
    onError: (e) => setError(errorText(e)),
  })
  useEffect(() => {
    const b = billing.data
    if (!b || !wanted.plan || wantedDone.current) return
    wantedDone.current = true
    history.replaceState(null, '', location.pathname)
    if (!(wanted.plan === 'pro' && b.trial_available)) {
      choose.mutate({ plan: wanted.plan, period: wanted.year ? 'year' : 'month' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billing.data])
  const simple = (fn: () => Promise<void>, done?: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      setAsk(null)
      refresh()
      if (done) setToast(done)
    },
    onError: (e: Error) => {
      setAsk(null)
      setError(errorText(e))
    },
  })
  const cancel = useMutation(simple(() => api.cancelSubscription(shop.id)))
  const resume = useMutation(simple(() => api.resumeSubscription(shop.id), 'Автопродление включено'))
  const trial = useMutation(simple(() => api.startTrial(shop.id), 'Пробный период «Про» включён на 7 дней'))

  if (billing.isPending) return <p className="text-ink-2">Загрузка…</p>
  if (billing.isError) return <p className="text-danger" role="alert">Не удалось загрузить тариф.</p>

  const b = billing.data
  const period: BillingPeriod = year ? 'year' : 'month'
  const sub = b.subscription
  // Идёт оплаченный период подписки (а не пробный и не Бесплатный).
  const paid = sub !== null && sub.status !== 'expired' && sub.plan === b.plan && new Date(sub.period_end).getTime() > now
  const trialActive = !paid && b.plan !== 'free' && b.trial_ends_at !== null && new Date(b.trial_ends_at).getTime() > now
  const busy = choose.isPending || pay.isPending
  const pick = (plan: Plan, p: BillingPeriod = period) => {
    setError('')
    choose.mutate({ plan, period: p })
  }
  const planInfo = (id: Plan) => b.plans.find((p) => p.id === id)!

  return (
    <div className="bill">
      <div className="page__head">
        <h1>Подписка</h1>
      </div>
      <p className="bill__lead">Ваш тариф, сколько места уже занято и чем отличаются тарифы.</p>

      {b.failed_payment && (
        <div className="bill__fail" role="alert">
          <span className="bill__failico" aria-hidden="true" />
          <p>
            Оплата тарифа «{PLAN_NAMES[b.failed_payment.plan]}» не прошла — остаётся «{PLAN_NAMES[b.plan]}»
            <br />
            Попробуйте ещё раз или оплатите другой картой.
          </p>
          <button
            className="btn btn--ghost btn--pill"
            disabled={pay.isPending}
            onClick={() => pay.mutate({ plan: b.failed_payment!.plan, period: b.failed_payment!.period })}
          >
            Попробовать ещё раз
          </button>
        </div>
      )}
      {error && (
        <p className="alert alert--danger" role="alert">
          {error}
        </p>
      )}

      <section className="bill__top">
        <div className="bill__cur">
          <span className="bill__k">Ваш тариф</span>
          <h2>
            {PLAN_NAMES[b.plan]} <PlanBars plan={b.plan} size={24} />
          </h2>
          <CurrentState
            b={b}
            paid={paid}
            trialActive={trialActive}
            now={now}
            busy={busy}
            onPick={pick}
            onCancel={() => setAsk({ type: 'cancel' })}
            onResume={() => resume.mutate()}
            onHistory={() => setAsk({ type: 'history' })}
          />
        </div>
        <div className="bill__usage">
          <div className="bill__rings">
            <Ring
              pct={b.usage.photos / Math.max(1, b.limits.max_photos)}
              label="Фото"
              value={num(b.usage.photos)}
              of={`из ${num(b.limits.max_photos)}`}
              trash={`В «Удаленном»: ${num(b.usage.trash_photos)} фото`}
            />
            <Ring
              pct={b.usage.storage_used / Math.max(1, b.limits.max_storage)}
              label="Хранилище"
              value={size(b.usage.storage_used)}
              of={`из ${size(b.limits.max_storage)}`}
              trash={`В «Удаленном»: ${size(b.usage.trash_bytes)}`}
            />
          </div>
          <p className="bill__note">Лимит срабатывает по тому, что закончится раньше — фото или объём.</p>
        </div>
      </section>

      <label className="bill__period">
        <span className={year ? '' : 'is-on'}>Помесячно</span>
        <span className="switch">
          <input
            type="checkbox"
            checked={year}
            onChange={(e) => setYear(e.target.checked)}
            aria-label="Оплата за год"
          />
        </span>
        <span className={year ? 'is-on' : ''}>За год</span>
        <span className="bill__save">−25%</span>
      </label>

      <div className="bill__plans">
        {PLAN_ORDER.map((id) => (
          <PlanCard
            key={id}
            plan={planInfo(id)}
            b={b}
            paid={paid}
            year={year}
            busy={busy}
            onPick={() => pick(id)}
            onTrial={() => trial.mutate()}
          />
        ))}
      </div>

      <h2 className="bill__h">Сравнение тарифов</h2>
      <p className="bill__sub">Что входит в каждый тариф. Список будет пополняться.</p>
      <Compare b={b} year={year} />

      <p className="bill__foot">
        Оплата через ЮKassa. Тариф включается сразу после подтверждения платежа — обычно в течение минуты. При
        переходе на бесплатный тариф пароли на альбомах сохранятся, но изменить или снять их не получится.
      </p>

      {ask?.type === 'pay' && (
        <PayDialog
          b={b}
          quote={ask.quote}
          email={me.data?.email ?? null}
          pending={pay.isPending}
          onPay={() => pay.mutate({ plan: ask.quote.plan, period: ask.quote.period })}
          onClose={() => setAsk(null)}
        />
      )}
      {ask?.type === 'down' && (
        <ChangeDialog
          b={b}
          title={`Перейти на «${PLAN_NAMES[ask.quote.plan]}»?`}
          target={ask.quote.plan}
          text={downText(b, ask.quote)}
          stay={`Остаться на «${PLAN_NAMES[b.plan]}»`}
          confirm={`Перейти на «${PLAN_NAMES[ask.quote.plan]}»`}
          pending={pay.isPending}
          onConfirm={() => pay.mutate({ plan: ask.quote.plan, period: ask.quote.period })}
          onClose={() => setAsk(null)}
        />
      )}
      {ask?.type === 'cancel' && sub && (
        <ChangeDialog
          b={b}
          title="Отключить автопродление?"
          target="free"
          text={`«${PLAN_NAMES[b.plan]}» продолжит работать до ${date(sub.period_end)} — оплаченные дни не пропадут. Потом тариф не продлится и аккаунт перейдёт на «Бесплатный», списаний больше не будет.`}
          stay="Оставить автопродление"
          confirm="Отключить"
          pending={cancel.isPending}
          onConfirm={() => cancel.mutate()}
          onClose={() => setAsk(null)}
        />
      )}
      {ask?.type === 'history' && <HistoryDialog payments={payments.data?.payments} onClose={() => setAsk(null)} />}

      {shownToast && (
        <div className="bill__toast">
          <Toast
            text={shownToast}
            onClose={() => {
              setToast('')
              setSeen(true)
            }}
          />
        </div>
      )}
    </div>
  )
}

function downText(b: Billing, q: BillingQuote): string {
  const until = date(q.period_end)
  const cur = PLAN_NAMES[b.plan]
  if (q.plan === 'free') {
    return `«${cur}» продолжит работать до ${until} — оплаченные дни не пропадут. С ${until} включится «Бесплатный», списаний больше не будет.`
  }
  const price = b.plans.find((p) => p.id === q.plan)!
  const amount = q.period === 'year' ? `${rub(price.price_year_rub)} в год` : `${rub(price.price_rub)} в месяц`
  return `«${cur}» продолжит работать до ${until} — оплаченные дни не пропадут. С ${until} включится «${PLAN_NAMES[q.plan]}» — ${amount}.`
}

// Строки под названием тарифа и кнопки верхней карточки — по состоянию:
// оплаченный период, пробный, пробный закончился, платный закончился, Бесплатный.
function CurrentState({
  b,
  paid,
  trialActive,
  now,
  busy,
  onPick,
  onCancel,
  onResume,
  onHistory,
}: {
  b: Billing
  paid: boolean
  trialActive: boolean
  now: number
  busy: boolean
  onPick: (plan: Plan) => void
  onCancel: () => void
  onResume: () => void
  onHistory: () => void
}) {
  const sub = b.subscription
  const history = (
    <button type="button" className="bill__link" onClick={onHistory}>
      История платежей
    </button>
  )
  if (paid && sub) {
    const info = b.plans.find((p) => p.id === sub.plan)!
    const price = sub.period === 'year' ? `${rub(info.price_year_rub)} в год` : `${rub(info.price_rub)} в месяц`
    return (
      <>
        <p className="bill__line">
          {price} · {sub.auto_renew ? 'следующее списание' : 'действует до'} {date(sub.period_end)}
        </p>
        <p className={`bill__dot ${sub.auto_renew ? 'bill__dot--ok' : ''}`}>
          {sub.auto_renew ? 'Автопродление включено' : 'Автопродление отключено'}
        </p>
        {sub.next_plan && sub.auto_renew && (
          <p className="bill__line">
            С {date(sub.period_end)} — «{PLAN_NAMES[sub.next_plan]}»
          </p>
        )}
        <div className="bill__acts">
          {sub.auto_renew ? (
            <button className="btn btn--ghost btn--pill" onClick={onCancel}>
              Отключить автопродление
            </button>
          ) : (
            <button className="btn btn--ghost btn--pill" onClick={onResume}>
              Включить автопродление
            </button>
          )}
          {history}
        </div>
      </>
    )
  }
  if (trialActive && b.trial_ends_at) {
    const left = Math.max(1, Math.ceil((new Date(b.trial_ends_at).getTime() - now) / DAY))
    return (
      <>
        <p className="bill__line">Пробный период — бесплатно до {date(b.trial_ends_at)}</p>
        <p className="bill__dot bill__dot--brand">
          Осталось {left} {plural(left, 'день', 'дня', 'дней')}, карта не нужна
        </p>
        <div className="bill__acts">
          <button className="btn btn--primary btn--pill" disabled={busy} onClick={() => onPick(b.plan)}>
            Оплатить «{PLAN_NAMES[b.plan]}»
          </button>
          {history}
        </div>
      </>
    )
  }
  // Бесплатный. Что закончилось последним — платный тариф или пробный.
  const subEnd = sub && sub.status === 'expired' ? new Date(sub.period_end).getTime() : 0
  const trialEnd = b.trial_ends_at ? new Date(b.trial_ends_at).getTime() : 0
  return (
    <>
      <p className="bill__line">0 ₽ · без срока действия</p>
      {subEnd > 0 && subEnd >= trialEnd ? (
        <>
          <p className="bill__dot">Платный тариф закончился {date(sub!.period_end)}</p>
          <div className="bill__acts">
            <button className="btn btn--primary btn--pill" disabled={busy} onClick={() => onPick(sub!.plan)}>
              Продлить «{PLAN_NAMES[sub!.plan]}»
            </button>
          </div>
        </>
      ) : trialEnd > 0 ? (
        <>
          <p className="bill__dot">Пробный период закончился {date(b.trial_ends_at!)}</p>
          <div className="bill__acts">
            <button className="btn btn--primary btn--pill" disabled={busy} onClick={() => onPick('pro')}>
              Оплатить «Про»
            </button>
          </div>
        </>
      ) : (
        <div className="bill__acts">
          <button
            className="btn btn--primary btn--pill"
            onClick={() => document.querySelector('.bill__plans')?.scrollIntoView({ behavior: 'smooth' })}
          >
            Выбрать тариф
          </button>
        </div>
      )}
    </>
  )
}

// Кольцевой индикатор заполненности (макет 18).
function Ring({ pct, label, value, of, trash }: { pct: number; label: string; value: string; of: string; trash: string }) {
  const p = Math.min(1, Math.max(0, pct))
  const r = 40
  const c = 2 * Math.PI * r
  const shown = Math.round(p * 100)
  return (
    <div className="bring">
      <svg viewBox="0 0 96 96" width="96" height="96" aria-hidden="true">
        <circle cx="48" cy="48" r={r} fill="none" stroke="var(--color-surface-alt)" strokeWidth="8" />
        <circle
          cx="48"
          cy="48"
          r={r}
          fill="none"
          stroke={p >= 0.9 ? '#C77700' : 'var(--color-brand)'}
          strokeWidth="8"
          strokeDasharray={`${c * p} ${c}`}
          transform="rotate(-90 48 48)"
        />
        <text x="48" y="54" textAnchor="middle" className="bring__pct">
          {shown === 0 && p > 0 ? '<1' : shown}%
        </text>
      </svg>
      <div>
        <span className="bring__label">{label}</span>
        <p className="bring__val">
          <b>{value}</b> {of}
        </p>
        <span className="bring__trash">{trash}</span>
      </div>
    </div>
  )
}

function PlanCard({
  plan,
  b,
  paid,
  year,
  busy,
  onPick,
  onTrial,
}: {
  plan: PlanInfo
  b: Billing
  paid: boolean
  year: boolean
  busy: boolean
  onPick: () => void
  onTrial: () => void
}) {
  const current = plan.id === b.plan
  const higher = PLAN_ORDER.indexOf(plan.id) > PLAN_ORDER.indexOf(b.plan)
  const sub = b.subscription
  const trialOffer = plan.id === 'pro' && b.trial_available
  const price = plan.price_rub === 0 ? 0 : year ? plan.price_year_rub : plan.price_rub
  const saving = plan.price_rub * 12 - plan.price_year_rub
  const scheduled = paid && sub?.auto_renew && sub.next_plan === plan.id

  let action
  if (current && paid && year && sub?.period === 'month') {
    action = (
      <button className="btn btn--ghost btn--pill btn--block" disabled={busy} onClick={onPick}>
        Перейти на оплату за год
      </button>
    )
  } else if (current) {
    action = (
      <button className="btn btn--pill btn--block bill__mine" disabled>
        Ваш тариф
      </button>
    )
  } else if (scheduled) {
    action = (
      <button className="btn btn--pill btn--block bill__mine" disabled>
        С {date(sub!.period_end)}
      </button>
    )
  } else if (trialOffer) {
    action = (
      <button className="btn btn--primary btn--pill btn--block" disabled={busy} onClick={onTrial}>
        Пробный период
      </button>
    )
  } else {
    action = (
      <button
        className={`btn btn--pill btn--block ${higher ? 'btn--primary' : 'btn--ghost'}`}
        disabled={busy}
        onClick={onPick}
      >
        Перейти на «{PLAN_NAMES[plan.id]}»
      </button>
    )
  }

  return (
    <div className={`bcard ${current ? 'bcard--cur' : ''}`}>
      <div className="bcard__head">
        <b>{PLAN_NAMES[plan.id]}</b>
        <PlanBars plan={plan.id} />
        {current ? (
          <span className="bcard__tag">Ваш тариф</span>
        ) : trialOffer ? (
          <span className="bcard__tag bcard__tag--trial">7 дней бесплатно</span>
        ) : null}
      </div>
      <p className="bcard__price">
        <b>{rub(price)}</b> <span>{plan.price_rub === 0 ? 'навсегда' : year ? '/год' : '/мес'}</span>
      </p>
      {year && plan.price_rub > 0 && <p className="bcard__save">Экономия {rub(saving)}</p>}
      <p className="bcard__tagline">{PLAN_TAGLINES[plan.id]}</p>
      <div className="bcard__lims">
        <span>
          <b>{num(plan.max_photos)}</b>фото
        </span>
        <span>
          <b>{size(plan.max_storage)}</b>хранилище
        </span>
      </div>
      {action}
    </div>
  )
}

// Таблица сравнения: на телефоне — название строки сверху, под ним 4
// значения (макет 18 · Mobile); колонка текущего тарифа подсвечена.
function Compare({ b, year }: { b: Billing; year: boolean }) {
  const cur = (id: Plan) => (id === b.plan ? ' is-cur' : '')
  const cell = (v: string | boolean) =>
    v === true ? (
      <span className="cmp__yes" aria-label="Есть">
        <Icon as={Check} size={12} />
      </span>
    ) : v === false ? (
      <span className="cmp__no" aria-label="Нет">
        —
      </span>
    ) : (
      v
    )
  const rows: { label: string; values: (p: PlanInfo) => string | boolean }[] = [
    { label: 'Фото', values: (p) => num(p.max_photos) },
    { label: 'Объём хранилища', values: (p) => size(p.max_storage) },
    { label: 'Размер одного фото', values: () => 'до 10 МБ' },
  ]
  const section = (title: string) => (
    <div className="cmp__sec" role="row">
      <span role="rowheader">{title}</span>
      {PLAN_ORDER.map((id) => (
        <span key={id} className={`cmp__secfill${cur(id)}`} aria-hidden="true" />
      ))}
    </div>
  )
  const row = (label: string, value: (p: PlanInfo) => string | boolean) => (
    <div className="cmp__row" role="row" key={label}>
      <span className="cmp__label" role="rowheader">
        {label}
      </span>
      {b.plans.map((p) => (
        <span key={p.id} className={`cmp__v${cur(p.id)}`} role="cell">
          {cell(value(p))}
        </span>
      ))}
    </div>
  )
  return (
    <div className="cmp" role="table" aria-label="Сравнение тарифов">
      <div className="cmp__hrow" role="row">
        <span className="cmp__corner" role="columnheader">
          Тариф
        </span>
        {b.plans.map((p) => (
          <span key={p.id} className={`cmp__h${cur(p.id)}`} role="columnheader">
            {p.id === b.plan && <span className="bcard__tag">Ваш тариф</span>}
            <b>{PLAN_NAMES[p.id]}</b>
            <small>
              {p.price_rub === 0 ? '0 ₽' : `${num(year ? p.price_year_rub : p.price_rub)} ₽`}
              {p.price_rub > 0 && <span className="cmp__per">{year ? '/год' : '/мес'}</span>}
            </small>
          </span>
        ))}
      </div>
      {section('Лимиты')}
      {rows.map((r) => row(r.label, r.values))}
      {section('Возможности')}
      {PLAN_FEATURES.map((f) => row(f.label, (p) => (p.id === 'free' ? f.free : f.paid)))}
    </div>
  )
}

function Dialog({ label, wide, onClose, children }: { label: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  const back = useDialogClose(onClose)
  return (
    <Portal>
      <div className="modal__back modal__back--top" role="dialog" aria-modal="true" aria-label={label} {...back}>
        <div className={`modal bmodal ${wide ? 'bmodal--wide' : ''}`}>
          {children}
        </div>
      </div>
    </Portal>
  )
}

// «Перейти на «Бизнес»?» — сумма к оплате сейчас, со следующего списания
// и что прибавится (макет 18 · «Переход на тариф выше»).
function PayDialog({
  b,
  quote,
  email,
  pending,
  onPay,
  onClose,
}: {
  b: Billing
  quote: BillingQuote
  email: string | null
  pending: boolean
  onPay: () => void
  onClose: () => void
}) {
  const target = b.plans.find((p) => p.id === quote.plan)!
  const same = quote.plan === b.plan
  const title =
    quote.kind === 'switch' && same
      ? 'Перейти на оплату за год?'
      : same
        ? `Оплатить «${PLAN_NAMES[quote.plan]}»?`
        : `Перейти на «${PLAN_NAMES[quote.plan]}»?`
  const lead =
    quote.kind === 'upgrade'
      ? 'Тариф сменится сразу после оплаты. Дата следующего списания не изменится.'
      : quote.kind === 'switch'
        ? 'Годовой период начнётся сразу после оплаты, оставшиеся дни месяца засчитаются.'
        : `Тариф будет оплачен до ${date(quote.period_end)}.`
  const yearPrice = target.price_year_rub
  const detail =
    quote.kind === 'upgrade'
      ? `Разница между «${PLAN_NAMES[quote.from_plan ?? b.plan]}» и «${PLAN_WITH[quote.plan]}» за ${quote.days} ${plural(quote.days, 'оставшийся день', 'оставшихся дня', 'оставшихся дней')} — до ${date(quote.period_end)}`
      : quote.kind === 'switch'
        ? `Год «${PLAN_NAMES[quote.plan]}» — ${rub(yearPrice)}, минус ${rub(yearPrice - quote.amount_rub)} за ${quote.days} ${plural(quote.days, 'оставшийся день', 'оставшихся дня', 'оставшихся дней')} месяца`
        : `«${PLAN_NAMES[quote.plan]}» за ${quote.period === 'year' ? 'год' : 'месяц'} — до ${date(quote.period_end)}`
  const next = quote.period === 'year' ? `${num(target.price_year_rub)} ₽/год` : `${num(target.price_rub)} ₽/мес`
  const gains =
    target.max_photos > b.limits.max_photos
      ? [
          [`${num(target.max_photos)} фото`, `вместо ${num(b.limits.max_photos)}`],
          [`${size(target.max_storage)} хранилища`, `вместо ${size(b.limits.max_storage)}`],
        ]
      : []
  return (
    <Dialog label={title} onClose={onClose}>
      <div className="bmodal__body">
        <h2>{title}</h2>
        <p className="bmodal__lead">{lead}</p>
        <div className="bmodal__sum">
          <div className="bmodal__now">
            <span>Сейчас к оплате</span>
            <b>{rub(quote.amount_rub)}</b>
          </div>
          <p>{detail}</p>
          <div className="bmodal__next">
            <span>С {date(quote.period_end)}</span>
            <span>{next}</span>
          </div>
        </div>
        {gains.length > 0 && (
          <ul className="bmodal__gains">
            {gains.map(([a, c]) => (
              <li key={a}>
                <span className="cmp__yes" aria-hidden="true">
                  <Icon as={Check} size={12} />
                </span>
                <b>{a}</b> <span>{c}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="bmodal__acts">
          <button className="btn btn--ghost btn--pill" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn--primary btn--pill" disabled={pending} onClick={onPay}>
            Перейти к оплате · {rub(quote.amount_rub)}
          </button>
        </div>
        <p className="bmodal__foot">Оплата через ЮKassa.{email ? ` Чек придёт на ${email}.` : ''}</p>
      </div>
    </Dialog>
  )
}

// Переход ниже и отключение автопродления: что продавец потеряет. Пункт про
// лимит — только если загружено больше лимита нового тарифа (заметка макета).
function ChangeDialog({
  b,
  title,
  target,
  text,
  stay,
  confirm,
  pending,
  onConfirm,
  onClose,
}: {
  b: Billing
  title: string
  target: Plan
  text: string
  stay: string
  confirm: string
  pending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const lim = b.plans.find((p) => p.id === target)!
  const items: { warn?: boolean; text: string }[] = []
  if (b.usage.photos > lim.max_photos || b.usage.storage_used > lim.max_storage) {
    items.push({
      warn: true,
      text: `У вас ${num(b.usage.photos)} фото и ${size(b.usage.storage_used)} — больше лимита «${PLAN_NAMES[target]}» (${num(lim.max_photos)} фото и ${size(lim.max_storage)}). Загруженное останется, но новые фото загрузить не получится, пока не удалите лишние.`,
    })
  }
  if (target === 'free') {
    items.push({ text: 'Пароли на альбомах сохранятся, но изменить или снять их не получится.' })
    items.push({ text: 'Аналитика станет недоступна.' })
  }
  return (
    <Dialog label={title} onClose={onClose}>
      <div className="bmodal__body">
        <span className="confirm__ico bmodal__ico" aria-hidden="true">
          <Icon as={TriangleAlert} size={22} />
        </span>
        <h2>{title}</h2>
        <p className="bmodal__lead">{text}</p>
        {items.length > 0 && (
          <div className="bmodal__sum">
            <b className="bmodal__what">Что изменится</b>
            <ul className="bmodal__list">
              {items.map((i) => (
                <li key={i.text} className={i.warn ? 'is-warn' : ''}>
                  {i.text}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="bmodal__acts">
          <button className="btn btn--ghost btn--pill" onClick={onClose} autoFocus>
            {stay}
          </button>
          <button className="btn btn--primary btn--pill" disabled={pending} onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

function paymentWhat(p: Payment): { title: string; note: string } {
  const title = p.from_plan && p.from_plan !== p.plan ? `«${PLAN_NAMES[p.from_plan]}» → «${PLAN_NAMES[p.plan]}»` : `«${PLAN_NAMES[p.plan]}»`
  if (p.status === 'canceled') {
    return { title, note: p.recurring ? 'Автопродление не прошло — платный тариф закончился' : 'Оплата не прошла' }
  }
  const range = (a: string, z: string) =>
    `${new Date(a).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} – ${date(z)}`
  if (p.kind === 'upgrade' && p.period_end) {
    const days = Math.max(1, Math.ceil((new Date(p.period_end).getTime() - new Date(p.created_at).getTime()) / DAY))
    return { title, note: `Доплата за ${days} ${plural(days, 'день', 'дня', 'дней')} до ${date(p.period_end)}` }
  }
  if (p.period_start && p.period_end) return { title, note: range(p.period_start, p.period_end) }
  return { title, note: '' }
}

// История платежей — таблица, на телефоне списком (макет 18).
function HistoryDialog({ payments, onClose }: { payments: Payment[] | undefined; onClose: () => void }) {
  return (
    <Dialog label="История платежей" wide onClose={onClose}>
      <div className="bmodal__body">
        <div className="bmodal__headrow">
          <div>
            <h2>История платежей</h2>
            <p className="bmodal__lead">Все списания по подписке — новые сверху.</p>
          </div>
          <button className="bmodal__x" onClick={onClose} aria-label="Закрыть">
            <Icon as={X} />
          </button>
        </div>
        {payments === undefined ? (
          <p className="text-ink-2">Загрузка…</p>
        ) : payments.length === 0 ? (
          <p className="text-ink-2">Платежей пока не было.</p>
        ) : (
          <div className="phist" role="table" aria-label="Платежи">
            <div className="phist__head" role="row">
              <span role="columnheader">Дата</span>
              <span role="columnheader">Что оплачено</span>
              <span role="columnheader">Сумма</span>
              <span role="columnheader">Статус</span>
            </div>
            {payments.map((p) => {
              const w = paymentWhat(p)
              return (
                <div className="phist__row" role="row" key={p.id}>
                  <span className="phist__date" role="cell">
                    {date(p.created_at)}
                  </span>
                  <span className="phist__what" role="cell">
                    {w.title}
                    {w.note && <small>{w.note}</small>}
                  </span>
                  <span className="phist__sum" role="cell">
                    {rub(p.amount_rub)}
                  </span>
                  <span role="cell">
                    <span className={`phist__st ${p.status === 'succeeded' ? '' : 'phist__st--fail'}`}>
                      {p.status === 'succeeded' ? 'Оплачен' : 'Не прошёл'}
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Dialog>
  )
}
