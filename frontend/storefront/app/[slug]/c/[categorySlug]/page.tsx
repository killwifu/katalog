import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getCategories, getCategoryAlbums, getShopPage, loadOrUnavailable } from '@/lib/api'
import { ShopUnavailable } from '@/components/ShopUnavailable'
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

  return (
    <main className="page">
      <ShopHeader shop={data.shop} />

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
          categories={categories}
          layout="tree"
          activeSlug={categorySlug}
        />

        <div className="catlayout__main">
          <h1 className="album-header">{category.title}</h1>
          {albums.length === 0 ? (
            <p className="empty">В этой категории пока нет альбомов.</p>
          ) : (
            <ul className="album-grid">
              {albums.map((album) => (
                <li key={album.id} className="album-card">
                  <a href={`/${slug}/a/${album.id}`}>
                    {album.cover_urls ? (
                      <img
                        src={album.cover_urls.thumb}
                        srcSet={`${album.cover_urls.thumb} 300w, ${album.cover_urls.medium} 800w`}
                        sizes="(max-width: 860px) 50vw, 25vw"
                        alt=""
                        loading="lazy"
                        width={300}
                        height={375}
                      />
                    ) : (
                      <span className="album-placeholder" aria-hidden="true" />
                    )}
                    <span className="album-title">{album.title}</span>
                    <span className="album-count">{album.photo_count}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  )
}
