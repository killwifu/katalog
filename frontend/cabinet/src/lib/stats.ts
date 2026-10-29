import type { ShopStats } from '../api'

// Дни без просмотров в ответе отсутствуют — без них линия шла напрямую
// от 31 к 194 через пропущенный день, будто трафик рос. Дополняем период
// нулями: от конца (вчера — сегодняшние просмотры считаются ночью — или
// последний день с данными) на days дней назад.
export function fillDays(daily: ShopStats['daily'], days: number, now = new Date()): ShopStats['daily'] {
  const byDate = new Map(daily.map((d) => [d.date, d]))
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  const last = daily.reduce((m, d) => (d.date > m ? d.date : m), yesterday.toISOString().slice(0, 10))
  const end = new Date(last + 'T00:00:00Z')
  const out: ShopStats['daily'] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10)
    out.push(byDate.get(date) ?? { date, views: 0, unique_visitors: 0, lead_clicks: 0 })
  }
  return out
}

// Даты аналитики — строки YYYY-MM-DD в UTC, как их считает сервер.
export const isoDay = (d: Date) => d.toISOString().slice(0, 10)
export const addDays = (iso: string, n: number) => isoDay(new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000))
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1

// fillRange — то же, что fillDays, но по явным границам (включительно):
// для «Своего периода» и прошлого отрезка сравнения.
export function fillRange(daily: ShopStats['daily'], from: string, to: string): ShopStats['daily'] {
  const byDate = new Map(daily.map((d) => [d.date, d]))
  const out: ShopStats['daily'] = []
  for (let date = from; date <= to; date = addDays(date, 1)) {
    out.push(byDate.get(date) ?? { date, views: 0, unique_visitors: 0, lead_clicks: 0 })
  }
  return out
}
