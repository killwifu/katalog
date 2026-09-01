import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getAlbumPage, loadOrUnavailable } from '@/lib/api'
import { ShopUnavailable } from '@/components/ShopUnavailable'
import { AlbumGrid } from '@/components/AlbumGrid'
import { PhotoGrid } from '@/components/PhotoGrid'
import { SearchForm } from '@/components/SearchForm'
import { TrackView } from '@/components/TrackView'

// Страница альбома: чтение searchParams делает рендер динамическим,
// но данные идут через data cache Next (тег shop:{slug}, TTL 60с) —
// Postgres на горячем пути не трогаем.

type Props = {
  params: { slug: string; albumId: string }
  searchParams: { page?: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, albumId } = params
  const res = await loadOrUnavailable(() => getAlbumPage(slug, albumId, 1))
  if (!res.ok) return { title: `${res.payload.shop.name} — каталог временно недоступен` }
  const data = res.data
  if (!data) return { title: 'Альбом не найден' }
  const cover = data.photos[0]?.urls
  return {
    title: `${data.album.title} — ${data.shop.name}`,
    description:
      data.album.description?.slice(0, 160) ||
      `${data.album.title}: ${data.album.photo_count} фото в каталоге ${data.shop.name}`,
    openGraph: {
      title: `${data.album.title} — ${data.shop.name}`,
      type: 'website',
      images: cover ? [{ url: cover.medium }] : undefined,
    },
  }
}

export default async function AlbumPage({ params, searchParams }: Props) {
  const { slug, albumId } = params
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1)

  // Прямая ссылка на альбом — обычный вход покупателя из мессенджера,
  // и неоплаченная витрина должна встретить его контактами продавца.
  const res = await loadOrUnavailable(() => getAlbumPage(slug, albumId, page))
  if (!res.ok) return <ShopUnavailable payload={res.payload} />
  const data = res.data
  if (!data) notFound()
  const { shop, album, photos, children, per_page: perPage, total } = data
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const base = `/${encodeURIComponent(slug)}/a/${album.id}`
  // Ссылка на страницу за пределами альбома — не редкость: продавец удалил
  // часть фото, а покупатель вернулся по старой ссылке или из выдачи.
  // Пустая сетка без навигации читается как «в магазине ничего нет».
  if (page > totalPages) redirect(base)

  return (
    <main className="page">
      <TrackView shopId={shop.id} albumId={album.id} />
      <header className="album-header">
        <nav className="breadcrumbs">
          <a href={`/${encodeURIComponent(slug)}`}>{shop.name}</a> / <span>{album.title}</span>
        </nav>
        <h1>{album.title}</h1>
        <p className="album-count">{album.photo_count} фото</p>
        {/* Условия отправки и оплаты — здесь, до фотографий: покупатель
            должен прочитать их прежде, чем писать продавцу.
            whiteSpace сохраняет переносы, которые продавец расставил сам. */}
        {album.description && <p className="albumdesc">{album.description}</p>}
        <SearchForm slug={slug} />
      </header>
      {/* Вложенные альбомы: по ссылке на родительскую категорию покупатель
          раньше попадал на пустую страницу — подальбомы были видны только
          на главной магазина. */}
      {children.length > 0 && (
        <section className="section">
          <h2 className="section__head">Внутри</h2>
          <AlbumGrid shopSlug={slug} albums={children} />
        </section>
      )}
      <PhotoGrid photos={photos} shop={shop} />
      {totalPages > 1 && (
        <nav className="pagination" aria-label="Страницы альбома">
          {page > 1 && (
            <a href={page === 2 ? base : `${base}?page=${page - 1}`} rel="prev">
              ← Назад
            </a>
          )}
          <span>
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <a href={`${base}?page=${page + 1}`} rel="next">
              Вперёд →
            </a>
          )}
        </nav>
      )}
    </main>
  )
}
