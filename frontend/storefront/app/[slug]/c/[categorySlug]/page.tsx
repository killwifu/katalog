import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getCategories, getCategoryAlbums, getShopPage, loadOrUnavailable, withAlbumCounts } from '@/lib/api'
import { ShopUnavailable } from '@/components/ShopUnavailable'
import { AlbumGrid } from '@/components/AlbumGrid'
import { ShopHeader } from '@/components/ShopHeader'
import { CategoryMenu } from '@/components/CategoryMenu'

export const revalidate = 60

export function generateStaticParams(): { slug: string; categorySlug: string }[] {
  return []
}

type Props = {
  params: { slug: string; categorySlug: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, categorySlug } = params
  const meta = await loadOrUnavailable(() =>
    Promise.all([getShopPage(slug), getCategories(slug)]),
  )
  if (!meta.ok) return { title: `${meta.payload.shop.name} — каталог временно недоступен` }
  const [data, categories] = meta.data
  const category = categories?.find((c) => c.slug === categorySlug)
  if (!data || !category) return { title: 'Категория не найдена' }
  return {
    title: `${category.title} — ${data.shop.name}`,
    description: `${category.title}: ${category.album_count} альбомов в каталоге ${data.shop.name}`,
  }
}

export default async function CategoryPage({ params }: Props) {
  const { slug, categorySlug } = params
  const res = await loadOrUnavailable(() =>
    Promise.all([getShopPage(slug), getCategories(slug), getCategoryAlbums(slug, categorySlug)]),
  )
  if (!res.ok) return <ShopUnavailable payload={res.payload} />
  const [data, categories, albums] = res.data
  if (!data || !categories || !albums) notFound()
  const category = categories.find((c) => c.slug === categorySlug)
  if (!category) notFound()
  // Выдача категории приходит без обложек; они есть в сетке магазина,
  // которую страница всё равно загружает для шапки. Без этого плитки
  // категории стояли пустыми серыми квадратами — а с главной сюда теперь
  // ведёт ссылка «Все N →».
  const fromShop = new Map(data.albums.map((a) => [a.id, a]))
  const withCovers = albums.map((a) => fromShop.get(a.id) ?? a)
  const counted = withAlbumCounts(categories, data.albums)

  return (
    <main className="page">
      <ShopHeader
        shop={data.shop}
        albumCount={data.albums.filter((a) => !a.parent_id).length}
        nav={{ tabs: data.tabs, categories: counted, active: 'categories' }}
      />

      <nav className="breadcrumbs" aria-label="Хлебные крошки">
        <a href={`/${slug}`}>{data.shop.name}</a>
        <span aria-hidden="true"> / </span>
        <span>{category.title}</span>
      </nav>

      {/* min-width:0 у рабочей области — иначе grid не даёт содержимому
          сжиматься и сетка наезжает на дерево категорий (kit, «Правила вёрстки»). */}
      <div className="catlayout">
        <CategoryMenu
          shopSlug={slug}
          categories={counted}
          layout="tree"
          activeSlug={categorySlug}
        />

        <div className="catlayout__main">
          <h1 className="album-header">{category.title}</h1>
          {albums.length === 0 ? (
            <p className="empty">В этой категории пока нет альбомов.</p>
          ) : (
            <AlbumGrid shopSlug={slug} albums={withCovers} />
          )}
        </div>
      </div>
    </main>
  )
}
