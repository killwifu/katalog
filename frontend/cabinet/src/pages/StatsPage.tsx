import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Calendar, Info, Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type ShopStats } from '../api'
import { Icon } from '../lib/icons'
import { addDays, daysBetween, fillRange, isoDay } from '../lib/stats'
import { useSegThumb } from '../lib/useSegThumb'
import { plural } from '../lib/uploadRun'
import { useShop } from './AppLayout'
import { ShareDialog } from './ShareDialog'

// Аналитика по макету 19. Данные хранятся 30 дней: период — 7/14/30 дней
// или «Свой период» в пределах последних 30. Период до 15 дней
// сравнивается с таким же отрезком прямо перед ним (второй запрос).
const BLUE = '#2547CE'
const ORANGE = '#D0662A'
const PREV = '#9A9891'
const KEEP_DAYS = 30
const COMPARE_MAX = 15

const CHANNEL_NAMES: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  avito: 'Авито',
}

type Period = { days: number } | { from: string; to: string }

const num = (n: number) => n.toLocaleString('ru-RU')
const dm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`
const dmy = (iso: string) => `${dm(iso)}.${iso.slice(0, 4)}`
const utc = (iso: string) => new Date(iso + 'T00:00:00Z')

// Бесплатный тариф (макет 19 · «Бесплатный тариф»): содержимое размыто
// и неактивно, поверх — карточка с замком и «Выбрать тариф».
function StatsLock({ today }: { today: string }) {
  // Под замком — размытая витрина аналитики на выдуманных цифрах (как в
  // макете): продавец видит, что получит. Настоящие данные не запрашиваем.
  const from = addDays(today, -30)
  const daily = Array.from({ length: 30 }, (_, i) => ({
    date: addDays(from, i),
    views: 420 + ((i * 37) % 230),
    unique_visitors: 130 + ((i * 13) % 50),
    lead_clicks: 25 + ((i * 7) % 18),
  }))
  const demo: ShopStats = {
    days: 30,
    from,
    to: today,
    totals: { views: 14860, unique_visitors: 3920, lead_clicks: 1046 },
    daily,
    channels: [397, 370, 134, 93, 52].map((clicks, i) => ({ channel: ['whatsapp', 'telegram', 'vk', 'max', 'avito'][i], clicks })),
    top_albums: [2140, 1760, 1310, 1180, 940].map((views, i) => ({ album_id: `demo-${i}`, title: '—', views, clicks: Math.round(views / 13) })),
    top_photos: [48, 41, 37, 33, 29, 26, 24, 21, 19, 17].map((clicks, i) => ({ photo_id: `demo-${i}`, caption: '—', album_title: '', clicks })),
  }
  return (
    <div className="stlock">
      <div className="stlock__ghost" aria-hidden="true" inert>
        <StatsBody stats={demo} prev={null} from={from} chartTo={addDays(today, -1)} prevFrom="" prevTo="" len={30} covers={new Map()} shopSlug="" />
      </div>
      <div className="stlock__card">
        <span className="stlock__ico" aria-hidden="true">
          <Icon as={Lock} size={22} />
        </span>
        <h2>Аналитика доступна на платных тарифах</h2>
        <p>
          Чтобы получить доступ к аналитике, перейдите на платный тариф: просмотры витрины, клики «Написать» по
          каналам, популярные альбомы и фото.
        </p>
        <Link to="/billing" className="btn btn--primary btn--pill">
          Выбрать тариф
        </Link>
      </div>
    </div>
  )
}

export function StatsPage() {
  const shop = useShop()
  const free = shop.plan === 'free'
  const [period, setPeriod] = useState<Period>({ days: 30 })
  const [picking, setPicking] = useState(false)
  const [today] = useState(() => isoDay(new Date()))
  const yesterday = addDays(today, -1)

  // Готовые периоды — N полных дней по вчера (сегодняшние просмотры
  // считаются ночью) плюс сегодняшние клики: они учитываются сразу.
  const from = 'days' in period ? addDays(today, -period.days) : period.from
  const to = 'days' in period ? today : period.to
  const chartTo = to < today ? to : yesterday
  const len = Math.max(1, daysBetween(from, chartTo))
  const compare = len <= COMPARE_MAX
  const prevFrom = addDays(from, -len)
  const prevTo = addDays(from, -1)

  const stats = useQuery({
    queryKey: ['stats', shop.id, from, to],
    queryFn: () => api.getStatsRange(shop.id, from, to),
    enabled: !free,
  })
  const prev = useQuery({
    queryKey: ['stats', shop.id, prevFrom, prevTo],
    queryFn: () => api.getStatsRange(shop.id, prevFrom, prevTo),
    enabled: !free && compare,
  })
  // Обложки топ-5 — из списка альбомов, как на «Обзоре».
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id), enabled: !free })
  const covers = new Map((albums.data ?? []).map((a) => [a.id, a.cover_urls?.small]))

  const segRef = useSegThumb<HTMLDivElement>('days' in period ? period.days : 0)
  const custom = !('days' in period)

  return (
    <div className="st">
      <div className="st__head">
        <div className="st__title">
          <h1>Аналитика</h1>
          <p>
            Данные хранятся {KEEP_DAYS} дней. Просмотры обновляются раз в сутки, ночью — сегодняшние появятся завтра.
            Клики «Написать» учитываются сразу.
          </p>
        </div>
        <div className="st__period">
          <div className="seg seg--fit st__seg" ref={segRef}>
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                disabled={free}
                aria-pressed={'days' in period && period.days === d}
                onClick={() => setPeriod({ days: d })}
              >
                {d} дней
              </button>
            ))}
          </div>
          <button
            className={`st__custom ${custom ? 'is-on' : ''}`}
            disabled={free}
            aria-expanded={picking}
            onClick={() => setPicking((v) => !v)}
          >
            <Icon as={Calendar} size={16} />
            {custom ? `${dm(period.from)} – ${dm(period.to)}` : 'Свой период'}
          </button>
          {picking && (
            <RangePicker
              today={today}
              initial={custom ? period : null}
              onClose={() => setPicking(false)}
              onApply={(p) => {
                setPeriod(p ?? { days: 30 })
                setPicking(false)
              }}
            />
          )}
        </div>
      </div>

      {free && <StatsLock today={today} />}
      {!free && stats.isPending && <p className="text-ink-2">Загрузка…</p>}
      {stats.isError && (
        <p className="text-danger" role="alert">
          Не удалось загрузить статистику.
        </p>
      )}
      {stats.data && (
        <StatsBody
          stats={stats.data}
          prev={compare ? (prev.data ?? null) : null}
          from={from}
          chartTo={chartTo}
          prevFrom={prevFrom}
          prevTo={prevTo}
          len={len}
          covers={covers}
          shopSlug={shop.slug}
        />
      )}
    </div>
  )
}

function StatsBody({
  stats,
  prev,
  from,
  chartTo,
  prevFrom,
  prevTo,
  len,
  covers,
  shopSlug,
}: {
  stats: ShopStats
  prev: ShopStats | null
  from: string
  chartTo: string
  prevFrom: string
  prevTo: string
  len: number
  covers: Map<string, string | undefined>
  shopSlug: string
}) {
  const [sharing, setSharing] = useState(false)
  const daily = fillRange(stats.daily, from, chartTo)
  const prevDaily = prev ? fillRange(prev.daily, prevFrom, prevTo) : []
  const rows = daily.map((d, i) => ({ ...d, prev: prev ? (prevDaily[i]?.views ?? 0) : undefined }))
  const t = stats.totals
  const conv = t.unique_visitors > 0 ? (t.lead_clicks / t.unique_visitors) * 100 : null
  const pt = prev?.totals
  const prevConv = pt && pt.unique_visitors > 0 ? (pt.lead_clicks / pt.unique_visitors) * 100 : null
  const vs = `к прошлым ${len} ${plural(len, 'дню', 'дням', 'дням')}`
  const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
  const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null)
  const noData = t.views === 0 && t.unique_visitors === 0 && stats.daily.length === 0
  const shopUrl = `${location.origin}/${shopSlug}`
  const totalClicks = stats.channels.reduce((n, c) => n + c.clicks, 0)

  const sub = (text: string, delta: { v: number | null; unit: string } | null) =>
    delta && delta.v !== null ? (
      <span className="stk__delta">
        <i className={delta.v >= 0 ? 'is-up' : 'is-down'}>
          {delta.v >= 0 ? '↑' : '↓'} {fmt1(Math.abs(delta.v))}
          {delta.unit}
        </i>
        {vs}
      </span>
    ) : (
      <span className="stk__sub">{text}</span>
    )

  return (
    <div className="st__body">
      <div className="stk">
        <Kpi label="Просмотры" value={num(t.views)} spark={daily.map((d) => d.views)} color={BLUE}>
          {sub(noData ? 'за выбранный период' : `≈ ${num(Math.round(t.views / len))} в день`, pt ? { v: pct(t.views, pt.views), unit: '%' } : null)}
        </Kpi>
        <Kpi
          label="Уникальные посетители"
          value={num(t.unique_visitors)}
          spark={daily.map((d) => d.unique_visitors)}
          color={ORANGE}
        >
          {sub(
            noData || t.unique_visitors === 0
              ? 'за выбранный период'
              : `≈ ${fmt1(t.views / t.unique_visitors)} ${plural(Math.round(t.views / t.unique_visitors), 'просмотр', 'просмотра', 'просмотра')} на посетителя`,
            pt ? { v: pct(t.unique_visitors, pt.unique_visitors), unit: '%' } : null,
          )}
        </Kpi>
        <Kpi label="Клики «Написать»" value={num(t.lead_clicks)} spark={daily.map((d) => d.lead_clicks)} color={BLUE}>
          {sub(noData ? 'за выбранный период' : `≈ ${num(Math.round(t.lead_clicks / len))} в день`, pt ? { v: pct(t.lead_clicks, pt.lead_clicks), unit: '%' } : null)}
        </Kpi>
        <Kpi label="Конверсия в обращение" value={conv === null ? '—' : `${Math.round(conv)}%`} ring={conv}>
          {sub(
            conv === null
              ? 'появится после первых визитов'
              : `${num(t.lead_clicks)} ${plural(t.lead_clicks, 'клик', 'клика', 'кликов')} на ${num(t.unique_visitors)} ${plural(t.unique_visitors, 'посетителя', 'посетителей', 'посетителей')}`,
            conv !== null && prevConv !== null ? { v: conv - prevConv, unit: ' п.п.' } : null,
          )}
        </Kpi>
      </div>

      {len > COMPARE_MAX && (
        <p className="st__hint">
          <Icon as={Info} size={14} />
          Сравнение с прошлым периодом доступно для периодов до {COMPARE_MAX} дней — более ранние данные не хранятся.
        </p>
      )}

      <section className="stc">
        <div className="stc__head">
          <div>
            <h2>Посещаемость по дням</h2>
            <p>
              {dm(from)} – {dmy(chartTo)}
              {prev && ` · сравнение с ${dm(prevFrom)} – ${dm(prevTo)}`}
            </p>
          </div>
          {!noData && (
            <ul className="stc__legend">
              <li>
                <i style={{ background: BLUE }} />
                Просмотры
              </li>
              {prev && (
                <li>
                  <i className="is-dash" />
                  Просмотры, прошлые {len} {plural(len, 'день', 'дня', 'дней')}
                </li>
              )}
              <li>
                <i style={{ background: ORANGE }} />
                Уникальные посетители
              </li>
            </ul>
          )}
        </div>
        {noData ? (
          <div className="stc__empty">
            <b>Данные появятся, когда покупатели откроют витрину</b>
            <p>
              Поделитесь ссылкой {location.host}/{shopSlug} — в чатах, соцсетях, в шапке профиля
            </p>
            <button className="st__btn" onClick={() => setSharing(true)}>
              Поделиться ссылкой
            </button>
          </div>
        ) : (
          <div className="stc__chart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="stViews" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BLUE} stopOpacity={0.12} />
                    <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#EBE9E4" strokeDasharray="4 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11.5, fill: '#6E6D67' }}
                  tickFormatter={(d: string) =>
                    len <= 7 ? `${utc(d).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' }).replace(/^./, (c) => c.toUpperCase())}, ${dm(d)}` : dm(d)
                  }
                  interval="preserveStartEnd"
                  minTickGap={28}
                  tickLine={false}
                  axisLine={{ stroke: '#CFCCC4' }}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11.5, fill: '#6E6D67' }} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={<ChartTip len={len} />} cursor={{ stroke: '#CFCCC4' }} />
                {prev && (
                  <Line dataKey="prev" stroke={PREV} strokeWidth={1.6} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                )}
                <Area
                  dataKey="views"
                  stroke={BLUE}
                  strokeWidth={2}
                  fill="url(#stViews)"
                  dot={false}
                  activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="unique_visitors"
                  stroke={ORANGE}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <div className="st__pair">
        <section className="stc">
          <div className="stc__head">
            <div>
              <h2>Клики «Написать» по каналам</h2>
              <p>Куда покупатели пишут чаще всего</p>
            </div>
          </div>
          {stats.channels.length === 0 ? (
            <p className="stc__none">Кликов «Написать» за период не было.</p>
          ) : (
            <ul className="stch">
              {stats.channels.map((c) => (
                <li key={c.channel}>
                  <span className="stch__top">
                    <ChannelLogo channel={c.channel} />
                    <span className="stch__name">{CHANNEL_NAMES[c.channel] ?? c.channel}</span>
                    <b>{num(c.clicks)}</b>
                    <em>{Math.round((c.clicks / Math.max(totalClicks, 1)) * 100)}%</em>
                  </span>
                  <Bar value={c.clicks} max={stats.channels[0].clicks} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="stc">
          <div className="stc__head">
            <div>
              <h2>Топ-5 альбомов по просмотрам</h2>
              <p>Просмотры и клики «Написать» за период</p>
            </div>
          </div>
          {stats.top_albums.length === 0 ? (
            <p className="stc__none">Просмотров альбомов за период не было.</p>
          ) : (
            <div className="sta">
              <div className="sta__cols">
                <span />
                <span>
                  <span className="sta__long">Просмотры</span>
                  <span className="sta__short">Просм.</span>
                </span>
                <span>Клики</span>
              </div>
              {stats.top_albums.map((a) => {
                const cover = covers.get(a.album_id)
                return (
                  <Link key={a.album_id} to="/albums/$albumId" params={{ albumId: a.album_id }} className="sta__row">
                    <i className="sta__cover">{cover && <img src={cover} alt="" loading="lazy" />}</i>
                    <span className="sta__info">
                      <span className="sta__name">{a.title}</span>
                      <Bar value={a.views} max={stats.top_albums[0].views} />
                    </span>
                    <b>{num(a.views)}</b>
                    <b>{num(a.clicks)}</b>
                  </Link>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <section className="stc">
        <div className="stc__head">
          <div>
            <h2>Топ-10 фото по кликам «Написать»</h2>
            <p>С каких фото покупатели чаще всего переходят в чат</p>
          </div>
        </div>
        {stats.top_photos.length === 0 ? (
          <p className="stc__none">Кликов по фото за период не было.</p>
        ) : (
          <ol className="stp">
            {stats.top_photos.map((p, i) => (
              <li key={p.photo_id}>
                <span className="stp__img">
                  {p.thumb_url && <img src={p.thumb_url} alt="" loading="lazy" />}
                  <i className="stp__rank">{i + 1}</i>
                  <i className="stp__clicks">
                    {num(p.clicks)} {plural(p.clicks, 'клик', 'клика', 'кликов')}
                  </i>
                </span>
                <span className="stp__cap">{p.caption || p.album_title}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {sharing && (
        <ShareDialog
          title="Поделиться витриной"
          lead="Отправьте ссылку покупателю или покажите QR-код"
          label="Ссылка на витрину"
          url={shopUrl}
          qr={`qr-${shopSlug}`}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  )
}

function Kpi({
  label,
  value,
  spark,
  color,
  ring,
  children,
}: {
  label: string
  value: string
  spark?: number[]
  color?: string
  ring?: number | null
  children: React.ReactNode
}) {
  return (
    <div className="stk__card">
      <span className="stk__label">{label}</span>
      <span className="stk__row">
        <b>{value}</b>
        {spark && spark.some((v) => v > 0) && <Spark values={spark} color={color!} />}
        {ring !== undefined && ring !== null && <Ring pct={ring} />}
      </span>
      {children}
    </div>
  )
}

// Мини-график в карточке (96×32): одна линия без осей — только форма.
function Spark({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? 96 / (values.length - 1) : 0
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(30 - (v / max) * 28).toFixed(1)}`).join(' ')
  return (
    <svg className="stk__spark" viewBox="0 0 96 32" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

function Ring({ pct }: { pct: number }) {
  const c = 2 * Math.PI * 16
  return (
    <svg className="stk__ring" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="16" fill="none" stroke="#F1F0EC" strokeWidth="5" />
      <circle
        cx="20"
        cy="20"
        r="16"
        fill="none"
        stroke={BLUE}
        strokeWidth="5"
        strokeDasharray={`${(Math.min(pct, 100) / 100) * c} ${c}`}
        transform="rotate(-90 20 20)"
      />
    </svg>
  )
}

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <span className="st__bar">
      <span style={{ width: `${(value / Math.max(max, 1)) * 100}%` }} />
    </span>
  )
}

// Логотипы каналов — упрощённые значки 22×22 в цветах сервисов.
function ChannelLogo({ channel }: { channel: string }) {
  const tile = (bg: string, glyph: React.ReactNode, round = false) => (
    <svg className="stch__logo" viewBox="0 0 22 22" aria-hidden="true">
      {round ? <circle cx="11" cy="11" r="11" fill={bg} /> : <rect width="22" height="22" rx="5" fill={bg} />}
      {glyph}
    </svg>
  )
  switch (channel) {
    case 'whatsapp':
      return tile(
        '#25D366',
        <path d="M11 5a6 6 0 0 0-5.2 9l-.8 3 3.1-.8A6 6 0 1 0 11 5Z" fill="none" stroke="#fff" strokeWidth="1.5" />,
      )
    case 'telegram':
      return tile('#2AABEE', <path d="M5.5 10.7 15.6 6.8c.5-.2.9.1.7.8l-1.7 8c-.1.6-.5.7-1 .4l-2.6-1.9-1.3 1.2c-.1.1-.3.3-.6.3l.2-2.7 4.9-4.4c.2-.2 0-.3-.3-.1L7.9 12.2l-2.6-.8c-.6-.2-.6-.5.2-.7Z" fill="#fff" />, true)
    case 'vk':
      return tile(
        '#0077FF',
        <text x="11" y="14.6" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">
          VK
        </text>,
        true,
      )
    case 'max':
      return tile('#7B4DFF', <circle cx="11" cy="11" r="4.6" fill="none" stroke="#fff" strokeWidth="2" />)
    case 'avito':
      return (
        <svg className="stch__logo" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="14.5" cy="7" r="4" fill="#00AAFF" />
          <circle cx="7" cy="9.5" r="3" fill="#FF4053" />
          <circle cx="15" cy="15.5" r="3.4" fill="#965EEB" />
          <circle cx="7.5" cy="16" r="2.4" fill="#04E061" />
        </svg>
      )
    default:
      return tile('#CFCCC4', null)
  }
}

type TipProps = {
  active?: boolean
  label?: string
  payload?: { dataKey?: string | number; value?: number }[]
  len: number
}

function ChartTip({ active, label, payload, len }: TipProps) {
  if (!active || !payload?.length || !label) return null
  const get = (k: string) => payload.find((p) => p.dataKey === k)?.value
  const day = utc(label).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' })
  const rows: [string, string, number | undefined][] = [
    [BLUE, 'Просмотры', get('views')],
    [PREV, len === 7 ? 'Неделей ранее' : 'Периодом ранее', get('prev')],
    [ORANGE, 'Уникальные', get('unique_visitors')],
  ]
  return (
    <div className="stc__tip">
      <b>{day.replace(/^./, (c) => c.toUpperCase())}</b>
      {rows
        .filter((r) => r[2] !== undefined)
        .map(([c, name, v]) => (
          <span key={name}>
            <i style={{ background: c }} />
            {name}
            <b>{num(v ?? 0)}</b>
          </span>
        ))}
    </div>
  )
}

// «Свой период»: два месяца (на телефоне — один, нижней шторкой),
// доступны только последние 30 дней. Первый клик — начало, второй — конец.
function RangePicker({
  today,
  initial,
  onApply,
  onClose,
}: {
  today: string
  initial: { from: string; to: string } | null
  onApply: (p: { from: string; to: string } | null) => void
  onClose: () => void
}) {
  const min = addDays(today, -KEEP_DAYS)
  const [phone] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const [a, setA] = useState<string | null>(initial?.from ?? null)
  const [b, setB] = useState<string | null>(initial?.to ?? null)
  // Показываемый месяц — последний (правый) из видимых.
  const [month, setMonth] = useState(() => today.slice(0, 7))
  const months = phone ? [month] : [shiftMonth(month, -1), month]
  const lo = a && b ? (a < b ? a : b) : a
  const hi = a && b ? (a < b ? b : a) : a

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = (d: string) => {
    if (!a || b) {
      setA(d)
      setB(null)
    } else setB(d)
  }
  const n = lo && hi ? daysBetween(lo, hi) : 0

  return (
    <>
      <div className="strp__shade" onMouseDown={onClose} />
      <div className="strp" role="dialog" aria-label="Свой период">
        {phone && <span className="strp__grip" aria-hidden="true" />}
        {phone && <h2 className="strp__title">Свой период</h2>}
        <div className="strp__months">
          <button
            className="strp__nav"
            aria-label="Предыдущий месяц"
            disabled={months[0] <= min.slice(0, 7)}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ‹
          </button>
          {months.map((m) => (
            <Month key={m} month={m} min={min} max={today} today={today} lo={lo} hi={hi} onPick={pick} />
          ))}
          <button
            className="strp__nav"
            aria-label="Следующий месяц"
            disabled={month >= today.slice(0, 7)}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
        <div className="strp__foot">
          <div>
            <b>{lo && hi ? `${dm(lo)} – ${dm(hi)} · ${n} ${plural(n, 'день', 'дня', 'дней')}` : 'Выберите начало и конец'}</b>
            <span>
              Доступны последние {KEEP_DAYS} дней: {dm(min)} – {dm(today)}
            </span>
          </div>
          <button className="st__btn" onClick={() => onApply(null)}>
            Сбросить
          </button>
          <button className="st__btn st__btn--primary" disabled={!lo || !hi} onClick={() => lo && hi && onApply({ from: lo, to: hi })}>
            Применить
          </button>
        </div>
      </div>
    </>
  )
}

function shiftMonth(ym: string, n: number): string {
  const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}

const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

function Month({
  month,
  min,
  max,
  today,
  lo,
  hi,
  onPick,
}: {
  month: string
  min: string
  max: string
  today: string
  lo: string | null
  hi: string | null
  onPick: (d: string) => void
}) {
  const first = utc(month + '-01')
  const lead = (first.getUTCDay() + 6) % 7
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  const title = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(' г.', '')
  const cells: (string | null)[] = [...Array(lead).fill(null)]
  for (let i = 1; i <= count; i++) cells.push(`${month}-${String(i).padStart(2, '0')}`)
  return (
    <div className="strp__month">
      <b>{title.replace(/^./, (c) => c.toUpperCase())}</b>
      <div className="strp__grid">
        {WEEK.map((w) => (
          <span key={w} className="strp__wd">
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />
          const off = d < min || d > max
          const edge = d === lo || d === hi
          const inside = lo && hi && d > lo && d < hi
          return (
            <button
              key={d}
              disabled={off}
              className={`strp__day${edge ? ' is-edge' : ''}${inside ? ' is-in' : ''}${d === today ? ' is-today' : ''}`}
              onClick={() => onPick(d)}
            >
              {+d.slice(8)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
