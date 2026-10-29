import type { Metadata } from 'next'
import { ChevronLeft } from 'lucide-react'
import { notFound, redirect } from 'next/navigation'
import { getCategories, getCategoryAlbums, getShopPage, loadOrUnavailable, withAlbumCounts } from '@/lib/api'
import { listHref, parseSort, sortAlbums } from '@/lib/sort'
import { ShopUnavailable } from '@/components/ShopUnavailable'
import { AlbumGrid } from '@/components/AlbumGrid'
import { EmptyState } from '@/components/EmptyState'
import { Pager } from '@/components/Pager'
import { albumsWord, ShopHeader } from '@/components/ShopHeader'
import { ALBUMS_PER_PAGE } from '@/components/ShopHome'
import { SortMenu } from '@/components/SortMenu'

// Страница категории (макет 15): крошки «Главная / Категория», заголовок
// с числом альбомов, сортировка, чипы подкатегорий, 24 на странице.
// Страница и сортировка в query — рендер динамический, данные из data cache.
type Props = {
  params: { slug: string; categorySlug: string }
  searchParams: { page?: string; sort?: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, categorySlug } = params
  const meta = await loadOrUnavailable(() => Promise.all([getShopPage(slug), getCategories(slug)]))
  if (!meta.ok) return { title: `${meta.payload.shop.name} — каталог временно недоступен` }
  const [data, categories] = meta.data
  const category = categories?.find((c) => c.slug === categorySlug)
  if (!data || !category) return { title: 'Категория не найдена' }
  return {
    title: `${category.title} — ${data.shop.name}`,
    description: `${category.title}: альбомы в каталоге ${data.shop.name}`,
  }
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug, categorySlug } = params
  const res = await loadOrUnavailable(() =>
    Promise.all([getShopPage(slug), getCategories(slug), getCategoryAlbums(slug, categorySlug)]),
  )
  if (!res.ok) return <ShopUnavailable payload={res.payload} />
  const [data, categories, albums] = res.data
  if (!data || !categories || !albums) notFound()
  const category = categories.find((c) => c.slug === categorySlug)
  if (!category) notFound()
  // Выдача категории приходит без обложек и дат; они есть в сетке
  // магазина, которую страница всё равно загружает для шапки.
  const fromShop = new Map(data.albums.map((a) => [a.id, a]))
  const sort = parseSort(searchParams.sort)
  const list = sortAlbums(
    albums.filter((a) => !a.parent_id).map((a) => fromShop.get(a.id) ?? a),
    sort,
  )
  const counted = withAlbumCounts(categories, data.albums)
  const parent = category.parent_slug ? counted.find((c) => c.slug === category.parent_slug) : undefined
  const root = parent ?? counted.find((c) => c.slug === categorySlug)!
  const subs = counted.filter((c) => c.parent_slug === root.slug)

  const shopBase = `/${encodeURIComponent(slug)}`
  const base = `${shopBase}/c/${encodeURIComponent(categorySlug)}`
  const pages = Math.max(1, Math.ceil(list.length / ALBUMS_PER_PAGE))
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1)
  if (page > pages) redirect(listHref(base, sort))
  const catHref = (s: string) => listHref(`${shopBase}/c/${encodeURIComponent(s)}`, sort)
  const top = data.albums.filter((a) => !a.parent_id)

  return (
    <main className="page">
      <ShopHeader
        shop={data.shop}
        albumCount={top.length}
        nav={{ tabs: data.tabs, categories: counted, active: 'categories', empty: top.length === 0 }}
        from={listHref(base, sort, page)}
      />

      <nav className="breadcrumbs sfcrumbs" aria-label="Хлебные крошки">
        <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        <a href={shopBase}>Главная</a>
        {parent && (
          <>
            <span aria-hidden="true">/</span>
            <a href={catHref(parent.slug)}>{parent.title}</a>
          </>
        )}
        <span aria-hidden="true">/</span>
        <span>{category.title}</span>
      </nav>

      <div className="cathead cathead--all">
        <h2>{category.title}</h2>
        <span>
          {list.length} {albumsWord(list.length)}
        </span>
        {list.length > 0 && (
          <SortMenu sort={sort} hrefs={{ new: listHref(base, 'new'), photos: listHref(base, 'photos') }} />
        )}
      </div>

      {list.length === 0 ? (
        <EmptyState icon="inbox" title="Владелец витрины ещё не добавил альбомы в эту категорию" />
      ) : (
        <>
          {/* Чипы подкатегорий: «Все» — альбомы всей категории. У категории
              без подкатегорий чипов нет. */}
          {subs.length > 0 && (
            <nav className="sfchips" aria-label="Подкатегории">
              <a href={catHref(root.slug)} className={`chip${root.slug === categorySlug ? ' is-on' : ''}`}>
                Все <span>{root.album_count}</span>
              </a>
              {subs.map((s) => (
                <a key={s.slug} href={catHref(s.slug)} className={`chip${s.slug === categorySlug ? ' is-on' : ''}`}>
                  {s.title} <span>{s.album_count}</span>
                </a>
              ))}
            </nav>
          )}
          <AlbumGrid shopSlug={slug} albums={list.slice((page - 1) * ALBUMS_PER_PAGE, page * ALBUMS_PER_PAGE)} />
          <Pager page={page} pages={pages} href={(n) => listHref(base, sort, n)} label="Страницы категории" />
        </>
      )}
    </main>
  )
}
