import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getCategories, getShopPage } from '@/lib/api'
import { ShopHeader } from '@/components/ShopHeader'
import { TrackView } from '@/components/TrackView'
import { CategoryMenu } from '@/components/CategoryMenu'
import { ShopTabs } from '@/components/ShopTabs'
import { AlbumGrid } from '@/components/AlbumGrid'

// ISR: страница статическая, данные с тегом shop:{slug}.
// Вебхук Go -> /api/revalidate инвалидирует мгновенно, TTL 60с — фолбэк.
export const revalidate = 60

// Пустой список + dynamicParams: страницы магазинов генерируются
// на первый запрос и кешируются (ISR), а не рендерятся каждый раз.
export function generateStaticParams(): { slug: string }[] {
  return []
}

type Props = {
  params: { slug: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = params
  const data = await getShopPage(slug)
  if (!data) return { title: 'Магазин не найден' }
  const cover = data.albums.find((a) => a.cover_urls)?.cover_urls
  return {
    title: `${data.shop.name} — фотокаталог`,
    description: data.shop.description || `Каталог товаров магазина ${data.shop.name}`,
    openGraph: {
      title: data.shop.name,
      description: data.shop.description || undefined,
      type: 'website',
      images: cover ? [{ url: cover.medium }] : undefined,
    },
  }
}

export default async function ShopPage({ params }: Props) {
  const { slug } = params
  // Категории — второй запрос того же ISR-кеша: тег shop:{slug} общий,
  // вебхук инвалидирует обе выдачи разом.
  const [data, categories] = await Promise.all([getShopPage(slug), getCategories(slug)])
  if (!data) notFound()
  const { shop, albums } = data
  // Подальбомы показываются внутри родителя; на главной — только верхний уровень.
  const topLevel = albums.filter((a) => !a.parent_id)
  const children = (parentId: string) => albums.filter((a) => a.parent_id === parentId)

  return (
    <main className="page">
      <TrackView shopId={shop.id} />
      <ShopHeader shop={shop} />
      <ShopTabs
        shopSlug={slug}
        tabs={data.tabs}
        hasSections={data.sections.length > 0}
        activeSlug="home"
      />
      {categories && categories.length > 0 && (
        <CategoryMenu shopSlug={slug} categories={categories} layout="dropdown" />
      )}
      {/* Есть секции — показываем выкладку продавца; нет — все альбомы
          по дате, как и раньше (kit). */}
      {data.sections.length > 0 ? (
        data.sections.map((section) => (
          <section key={section.title} className="section">
            <h2 className="section__head">{section.title}</h2>
            <AlbumGrid shopSlug={slug} albums={section.albums} />
          </section>
        ))
      ) : topLevel.length === 0 ? (
        <p className="empty">Каталог пока пуст.</p>
      ) : (
        <ul className="album-grid">
          {topLevel.map((album) => (
            <li key={album.id} className="album-card">
              <a href={`/${encodeURIComponent(slug)}/a/${album.id}`}>
                {album.cover_urls ? (
                  <img
                    src={album.cover_urls.thumb}
                    srcSet={`${album.cover_urls.thumb} 300w, ${album.cover_urls.medium} 800w`}
                    sizes="(max-width: 640px) 50vw, 25vw"
                    loading="lazy"
                    decoding="async"
                    alt={album.title}
                  />
                ) : (
                  <span className="album-placeholder" aria-hidden="true" />
                )}
                <span className="album-title">{album.title}</span>
                <span className="album-count">{album.photo_count} фото</span>
              </a>
              {children(album.id).length > 0 && (
                <ul className="album-children">
                  {children(album.id).map((child) => (
                    <li key={child.id}>
                      <a href={`/${encodeURIComponent(slug)}/a/${child.id}`}>
                        {child.title} ({child.photo_count})
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
