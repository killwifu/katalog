import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getCategories, getShopPage, loadOrUnavailable, withAlbumCounts } from '@/lib/api'
import { messageText } from '@/lib/links'
import { sortAlbums } from '@/lib/sort'
import { AlbumGrid } from '@/components/AlbumGrid'
import { ContactMenu } from '@/components/ContactMenu'
import { EmptyState } from '@/components/EmptyState'
import { albumsWord, ShopHeader } from '@/components/ShopHeader'
import { EmptyShop } from '@/components/ShopHome'
import { ShopUnavailable } from '@/components/ShopUnavailable'
import { TrackView } from '@/components/TrackView'

// Поиск по названиям опубликованных альбомов витрины, без учёта регистра
// (макет 15 · «Поиск»). Альбомы уже есть в ответе магазина (data cache,
// тег shop:{slug}) — отдельного запроса к API и к Postgres не нужно.
// Результаты — той же сеткой, от новых к старым; вкладки не подсвечены.

type Props = {
  params: { slug: string }
  searchParams: { q?: string; from?: string }
}

export function generateMetadata({ searchParams }: Props): Metadata {
  const { q } = searchParams
  return { title: q ? `Поиск «${q}»` : 'Поиск', robots: { index: false } }
}

export default async function SearchPage({ params, searchParams }: Props) {
  const { slug } = params
  const q = (searchParams.q ?? '').trim().slice(0, 100)
  const base = `/${encodeURIComponent(slug)}`
  // «Сбросить поиск» возвращает на прежнюю вкладку — только внутри витрины.
  const from =
    searchParams.from && searchParams.from.startsWith(`${base}`) && !searchParams.from.startsWith('//')
      ? searchParams.from
      : base
  if (!q) redirect(from)

  const res = await loadOrUnavailable(() => Promise.all([getShopPage(slug), getCategories(slug)]))
  if (!res.ok) return <ShopUnavailable payload={res.payload} />
  const [data, categories] = res.data
  if (!data) notFound()
  const { shop } = data
  const top = data.albums.filter((a) => !a.parent_id)
  const needle = q.toLocaleLowerCase('ru')
  const found = sortAlbums(
    data.albums.filter((a) => a.title.toLocaleLowerCase('ru').includes(needle)),
    'new',
  )

  return (
    <main className="page">
      <TrackView shopId={shop.id} />
      <ShopHeader
        shop={shop}
        albumCount={top.length}
        nav={{
          tabs: data.tabs,
          categories: withAlbumCounts(categories ?? [], data.albums),
          active: '',
          empty: top.length === 0,
        }}
        search={q}
        from={from}
      />
      {top.length === 0 ? (
        <EmptyShop shop={shop} />
      ) : found.length === 0 ? (
        <EmptyState
          icon="search"
          title={`Ничего не нашлось по «${q}»`}
          text="Проверьте написание или посмотрите все альбомы продавца. Если нужной вещи нет — спросите продавца, возможно, она есть в наличии."
        >
          <a className="btn btn--primary" href={`${base}/t/albums`}>
            Все альбомы
          </a>
          <ContactMenu shop={shop} text={messageText(shop.msg_template, '')} about="" variant="ghost" />
        </EmptyState>
      ) : (
        <>
          <div className="cathead cathead--all">
            <h2>Результаты по «{q}»</h2>
            <span>
              {found.length} {albumsWord(found.length)}
            </span>
            <a href={from}>Сбросить поиск</a>
          </div>
          <AlbumGrid shopSlug={slug} albums={found} />
        </>
      )}
    </main>
  )
}
