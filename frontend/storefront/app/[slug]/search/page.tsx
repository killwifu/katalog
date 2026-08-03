import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getShopPage, searchPhotos } from '@/lib/api'
import { PhotoGrid } from '@/components/PhotoGrid'
import { SearchForm } from '@/components/SearchForm'
import { TrackView } from '@/components/TrackView'

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

export default async function SearchPage({ params, searchParams }: Props) {
  const { slug } = params
  const q = (searchParams.q ?? '').trim().slice(0, 100)

  const shopData = await getShopPage(slug)
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
        <p className="empty">По запросу «{q}» ничего не найдено.</p>
      ) : (
        <PhotoGrid photos={photos} shop={shop} />
      )}
    </main>
  )
}
