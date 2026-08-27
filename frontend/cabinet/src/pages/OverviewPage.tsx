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
      {/* Ссылка — первое, что видит продавец: он отправляет её по десять раз
          в день. Акцентная рамка здесь не украшение, а расстановка приоритета. */}
      <section className="box box--accent">
        <h2 className="!mb-2 text-sm font-medium text-ink-2">Ссылка на каталог</h2>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={shopUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 truncate text-brand hover:underline"
          >
            {shopUrl}
          </a>
          <button
            onClick={() => void copy()}
            className="btn btn--primary btn--sm"
          >
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>
      </section>

      <section className="stats mb-6">
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
        <section className="box">
          <h2>Стоит доделать</h2>
          <ul className="space-y-1 text-sm text-ink-2">
            {empty > 0 && (
              <li>
                Пустых альбомов: {empty} —{' '}
                <Link to="/albums" className="text-brand hover:underline">
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
    <div className={`stat ${accent ? 'stat--accent' : ''}`}>
      <span>{label}</span>
      <b>{value ?? '—'}</b>
      <em>{hint}</em>
    </div>
  )
}
