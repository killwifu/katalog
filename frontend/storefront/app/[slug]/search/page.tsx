import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getShopPage, loadOrUnavailable, searchPhotos } from '@/lib/api'
import { ShopUnavailable } from '@/components/ShopUnavailable'
import { PhotoGrid } from '@/components/PhotoGrid'
import { SearchForm } from '@/components/SearchForm'
import { TrackView } from '@/components/TrackView'
import { CHANNEL_LABELS, contactHref, shopChannels } from '@/lib/links'

// Поиск по подписям в рамках магазина (FTS + trgm-фолбэк на бэкенде).
// Результаты кешируются data cache по полному URL (включая q).

type Props = {
  params: { slug: string }
  searchParams: { q?: string }
}

export function generateMetadata({ searchParams }: Props): Metadata {
  const { q } = searchParams
  return {
    title: q ? `Поиск «${q}»` : 'Поиск',
    robots: { index: false },
  }
}

// Контакты в тупике поиска: без них покупателю остаётся только уйти.
function NotFoundContacts({ shop }: { shop: Awaited<ReturnType<typeof getShopPage>> extends null ? never : NonNullable<Awaited<ReturnType<typeof getShopPage>>>['shop'] }) {
  const channels = shopChannels(shop.contacts)
  if (channels.length === 0) return null
  return (
    <div className="center">
      <p className="empty">Спросите продавца — возможно, товар есть, но подписан иначе.</p>
      <div className="lead-buttons">
        {channels.map(({ channel, value }) => (
          <a
            key={channel}
            href={contactHref(channel, value, 'Здравствуйте!')}
            target="_blank"
            rel="noopener noreferrer"
            className={`btn btn-${channel}`}
          >
            {CHANNEL_LABELS[channel]}
          </a>
        ))}
      </div>
      {shop.reply_time && <p className="reply-time">{shop.reply_time}</p>}
    </div>
  )
}

export default async function SearchPage({ params, searchParams }: Props) {
  const { slug } = params
  const q = (searchParams.q ?? '').trim().slice(0, 100)

  const res = await loadOrUnavailable(() => getShopPage(slug))
  if (!res.ok) return <ShopUnavailable payload={res.payload} />
  const shopData = res.data
  if (!shopData) notFound()
  const { shop } = shopData

  const result = q ? await searchPhotos(slug, q) : { photos: [] }
  const photos = result?.photos ?? []

  return (
    <main className="page">
      <TrackView shopId={shop.id} />
      <header className="album-header">
        <nav className="breadcrumbs">
          <a href={`/${encodeURIComponent(slug)}`}>{shop.name}</a> / <span>Поиск</span>
        </nav>
        <h1>{q ? `Поиск: ${q}` : 'Поиск по каталогу'}</h1>
        <SearchForm slug={slug} initial={q} />
      </header>
      {q === '' ? (
        <p className="empty">Введите запрос — например, название товара или артикул.</p>
      ) : photos.length === 0 ? (
        <>
          <p className="empty">По запросу «{q}» ничего не найдено.</p>
          {/* Покупатель, который искал и не нашёл, — ровно тот, кому стоит
              написать продавцу: возможно, товар есть, но подписан иначе. */}
          <NotFoundContacts shop={shop} />
        </>
      ) : (
        <PhotoGrid photos={photos} shop={shop} />
      )}
    </main>
  )
}
