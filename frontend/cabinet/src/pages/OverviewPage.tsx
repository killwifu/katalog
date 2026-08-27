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
  // Берём 14 дней и делим пополам: так дельта к прошлой неделе считается
  // из одного ответа, без второго запроса и без правок бэкенда.
  const stats = useQuery({
    queryKey: ['stats', shop.id, 14],
    queryFn: () => api.getStats(shop.id, 14),
  })
  const albums = useQuery({ queryKey: ['albums', shop.id], queryFn: () => api.listAlbums(shop.id) })
  const downgrade = useQuery({ queryKey: ['downgrade', shop.id], queryFn: () => api.getDowngrade(shop.id) })
  const [copied, setCopied] = useState(false)

  const shopUrl = `${location.origin}/${shop.slug}`
  const copy = async () => {
    await navigator.clipboard.writeText(shopUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const daily = stats.data?.daily ?? []
  const week = daily.slice(-7)
  const prevWeek = daily.slice(-14, -7)
  const sum = (rows: typeof daily, key: 'views' | 'unique_visitors' | 'lead_clicks') =>
    rows.reduce((n, d) => n + d[key], 0)
  const drafts = albums.data?.filter((a) => a.status === 'draft').length ?? 0
  const empty = albums.data?.filter((a) => a.photo_count === 0).length ?? 0

  return (
    <div>
      {/* Предложение выбрать видимое висит в кабинете, пока фотографий больше
          лимита: если продавец не выберет, мы всё равно ничего не удаляем. */}
      {downgrade.data?.over_limit && (
        <div className="alert alert--warn">
          <span className="flex-1">
            Фотографий больше, чем помещается в тариф: {downgrade.data.total_photos} из{' '}
            {downgrade.data.max_photos}. Выберите, что останется видимым покупателям.
          </span>
          <Link to="/downgrade" className="shrink-0 font-medium underline">
            Выбрать
          </Link>
        </div>
      )}

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
          value={sum(week, 'lead_clicks')}
          prev={sum(prevWeek, 'lead_clicks')}
          accent
        />
        <Metric label="Просмотры" value={sum(week, 'views')} prev={sum(prevWeek, 'views')} />
        <Metric
          label="Уникальные посетители"
          value={sum(week, 'unique_visitors')}
          prev={sum(prevWeek, 'unique_visitors')}
        />
      </section>

      {(stats.data?.top_albums.length ?? 0) > 0 && (
        <section className="box">
          <h2>Что смотрят чаще всего</h2>
          <ul className="rows !border-0">
            {stats.data!.top_albums.slice(0, 5).map((a) => (
              <li key={a.album_id} className="rows__row !px-0">
                <span className="rows__main">
                  <b>{a.title}</b>
                </span>
                <span className="text-sm text-ink-2">{a.views}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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

// Дельта к прошлой неделе отвечает на вопрос «стало лучше или хуже» —
// само по себе число просмотров на него не отвечает.
function delta(value: number, prev: number): string {
  if (prev === 0) return value > 0 ? 'новые за неделю' : 'пока пусто'
  const pct = Math.round(((value - prev) / prev) * 100)
  if (pct === 0) return 'столько же'
  return `${pct > 0 ? '+' : ''}${pct}% к прошлой неделе`
}

function Metric({
  label,
  value,
  prev,
  accent,
}: {
  label: string
  value: number
  prev: number
  accent?: boolean
}) {
  return (
    <div className={`stat ${accent ? 'stat--accent' : ''}`}>
      <span>{label}</span>
      <b>{value.toLocaleString('ru-RU')}</b>
      <em>{delta(value, prev)}</em>
    </div>
  )
}
