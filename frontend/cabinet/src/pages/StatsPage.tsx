import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, type ShopStats } from '../api'
import { useShop } from './AppLayout'

// Дашборд продавца. Палитра — категорийные слоты 1–2 (blue/orange),
// валидированы на светлой поверхности (CVD ΔE и контраст — pass).
const COLOR_VIEWS = '#2a78d6'
const COLOR_UV = '#eb6834'

const CHANNEL_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  max: 'MAX',
  vk: 'VK',
}

const PERIODS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
]

export function StatsPage() {
  const shop = useShop()
  const [days, setDays] = useState(30)
  const stats = useQuery({
    queryKey: ['stats', shop.id, days],
    queryFn: () => api.getStats(shop.id, days),
  })

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-gray-900">Статистика</h1>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              onClick={() => setDays(p.days)}
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                days === p.days
                  ? 'bg-blue-600 text-white'
                  : 'border border-gray-300 bg-white text-gray-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {stats.isPending && <p className="text-gray-500">Загрузка…</p>}
      {stats.isError && <p className="text-red-600">Не удалось загрузить статистику.</p>}
      {stats.data && <StatsBody stats={stats.data} />}
    </div>
  )
}

function StatsBody({ stats }: { stats: ShopStats }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <KpiTile label="Просмотры" value={stats.totals.views} />
        <KpiTile label="Уникальные посетители" value={stats.totals.unique_visitors} />
        <KpiTile label="Клики «написать»" value={stats.totals.lead_clicks} />
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-900">Посещаемость по дням</h2>
        {stats.daily.length === 0 ? (
          <Empty text="Пока нет данных — просмотры появляются после первого дня работы витрины." />
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats.daily} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#6b7280' }}
                  tickFormatter={shortDate}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e7eb' }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: '#6b7280' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  labelFormatter={(label) => (typeof label === 'string' ? longDate(label) : label)}
                />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="views"
                  name="Просмотры"
                  stroke={COLOR_VIEWS}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  type="monotone"
                  dataKey="unique_visitors"
                  name="Уникальные"
                  stroke={COLOR_UV}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-medium text-gray-900">
            Клики «написать» по каналам
          </h2>
          {stats.channels.length === 0 ? (
            <Empty text="Кликов за период не было." />
          ) : (
            <BarList
              rows={stats.channels.map((c) => ({
                key: c.channel,
                label: CHANNEL_NAMES[c.channel] ?? c.channel,
                value: c.clicks,
              }))}
            />
          )}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-medium text-gray-900">Топ-5 альбомов по просмотрам</h2>
          {stats.top_albums.length === 0 ? (
            <Empty text="Просмотров альбомов за период не было." />
          ) : (
            <BarList
              rows={stats.top_albums.map((a) => ({
                key: a.album_id,
                label: a.title,
                value: a.views,
              }))}
            />
          )}
        </section>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-900">Топ-10 фото по кликам</h2>
        {stats.top_photos.length === 0 ? (
          <Empty text="Кликов по фото за период не было." />
        ) : (
          <ul className="divide-y divide-gray-100">
            {stats.top_photos.map((p) => (
              <li key={p.photo_id} className="flex items-center gap-3 py-2">
                {p.thumb_url ? (
                  <img
                    src={p.thumb_url}
                    alt=""
                    loading="lazy"
                    className="h-12 w-12 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded bg-gray-100" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                  {p.caption || 'Без подписи'}
                </span>
                <span className="shrink-0 text-sm font-medium text-gray-900">
                  {p.clicks}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function KpiTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-2xl font-bold text-gray-900">
        {value.toLocaleString('ru-RU')}
      </div>
      <div className="mt-1 text-xs text-gray-500">{label}</div>
    </div>
  )
}

// BarList — горизонтальные полосы одной величины: один цвет (magnitude),
// значение — видимой текстовой подписью (relief-правило палитры).
function BarList({ rows }: { rows: { key: string; label: string; value: number }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-0.5 flex justify-between gap-2 text-sm">
            <span className="truncate text-gray-800">{r.label}</span>
            <span className="shrink-0 font-medium text-gray-900">
              {r.value.toLocaleString('ru-RU')}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-gray-100">
            <div
              className="h-full rounded"
              style={{ width: `${(r.value / max) * 100}%`, background: COLOR_VIEWS }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-gray-500">{text}</p>
}

function shortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  return `${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function longDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU')
}
