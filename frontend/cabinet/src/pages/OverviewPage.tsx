import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../api'
import { useShop } from './AppLayout'

// Обзор кабинета. Ссылка на витрину — в самом верху: продавец отправляет
// её по десять раз в день, это главное действие в кабинете.
//
// «Переходы в мессенджер» стоят перед просмотрами намеренно: именно они
// отвечают на вопрос «работает ли витрина» и оправдывают подписку.
export function OverviewPage() {
  const shop = useShop()
  const stats = useQuery({
    queryKey: ['stats', shop.id, 30],
    queryFn: () => api.getStats(shop.id, 30),
  })
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const [copied, setCopied] = useState(false)

  const shopUrl = `${location.origin}/${shop.slug}`
  const copy = async () => {
    await navigator.clipboard.writeText(shopUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const totals = stats.data?.totals
  const drafts = albums.data?.filter((a) => a.status === 'draft').length ?? 0
  const empty = albums.data?.filter((a) => a.photo_count === 0).length ?? 0

  return (
    <div>
      <section className="mb-6 rounded border border-gray-200 bg-white p-4">
        <h1 className="mb-2 text-sm font-medium text-gray-500">Ссылка на каталог</h1>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={shopUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 truncate text-base text-blue-600 hover:underline"
          >
            {shopUrl}
          </a>
          <button
            onClick={() => void copy()}
            className="rounded bg-gray-900 px-3 py-2 text-sm text-white hover:bg-gray-700"
          >
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>
      </section>

      <section className="mb-6 grid gap-3 sm:grid-cols-3">
        <Metric
          label="Переходы в мессенджер"
          value={totals?.lead_clicks}
          hint="за 30 дней"
          accent
        />
        <Metric label="Просмотры" value={totals?.views} hint="за 30 дней" />
        <Metric label="Уникальные посетители" value={totals?.unique_visitors} hint="за 30 дней" />
      </section>

      {(drafts > 0 || empty > 0) && (
        <section className="rounded border border-gray-200 p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-900">Стоит доделать</h2>
          <ul className="space-y-1 text-sm text-gray-600">
            {empty > 0 && (
              <li>
                Пустых альбомов: {empty} —{' '}
                <Link to="/albums" className="text-blue-600 hover:underline">
                  загрузить фото
                </Link>
              </li>
            )}
            {drafts > 0 && (
              <li>
                Черновиков: {drafts} — покупатель их не видит, опубликуйте, когда будут готовы
              </li>
            )}
          </ul>
        </section>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: number | undefined
  hint: string
  accent?: boolean
}) {
  return (
    <div className={`rounded border p-4 ${accent ? 'border-gray-900' : 'border-gray-200'}`}>
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-gray-900">{value ?? '—'}</div>
      <div className="text-xs text-gray-400">{hint}</div>
    </div>
  )
}
