import type { BillingPeriod, Plan, SignupIntent } from '../api'

// Тариф, с которым продавец пришёл на регистрацию (макет 04, заметки 04 и 08):
//   /app/register?trial=1                     — «Пробный период» «Про» (7 дней)
//   /app/register?plan=standard&period=year   — «Выбрать «Стандарт»» / «Бизнес»
// Параметры едут в ссылку из письма и в OAuth-вход, а здесь запоминаются до
// создания витрины: после неё пробный включается сам, платный ведёт на оплату.
const KEY = 'signup-intent'

function parse(search: string): SignupIntent | null {
  const q = new URLSearchParams(search)
  if (q.get('trial') === '1') return { trial: true }
  const plan = q.get('plan')
  if (plan === 'standard' || plan === 'pro' || plan === 'business') {
    return { plan: plan as Plan, period: (q.get('period') === 'year' ? 'year' : 'month') as BillingPeriod }
  }
  return null
}

// captureIntent — из адреса текущей страницы, если там есть тариф.
export function captureIntent(): void {
  const intent = parse(location.search)
  if (!intent) return
  try {
    localStorage.setItem(KEY, JSON.stringify(intent))
  } catch {
    // Приватный режим: тариф потеряется, продавец выберет его в «Подписке».
  }
}

export function readIntent(): SignupIntent {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? 'null') as SignupIntent | null) ?? {}
  } catch {
    return {}
  }
}

export function clearIntent(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // нечего чистить
  }
}

// intentQuery — те же параметры для ссылки входа через провайдера.
export function intentQuery(i: SignupIntent): string {
  if (i.trial) return '?trial=1'
  if (i.plan) return `?plan=${i.plan}${i.period === 'year' ? '&period=year' : ''}`
  return ''
}
