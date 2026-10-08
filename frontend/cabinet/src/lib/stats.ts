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
