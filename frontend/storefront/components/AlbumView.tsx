import { ChevronLeft } from 'lucide-react'
import {
  albumHref,
  SITE_URL,
  withAlbumCounts,
  type AlbumPage as AlbumData,
  type CategoryPublic,
  type ShopPage,
} from '@/lib/api'
import { messageText } from '@/lib/links'
import { AlbumGrid } from './AlbumGrid'
import { AlbumHead, type AlbumHeadProps } from './AlbumHead'
import { ContactMenu } from './ContactMenu'
import { EmptyState } from './EmptyState'
import { LockedAlbum } from './LockedAlbum'
import { PhotoGrid } from './PhotoGrid'
import { ShopHeader } from './ShopHeader'
import { TrackView } from './TrackView'

// Общая разметка страницы альбома: шапка витрины, крошки и содержимое —
// открытое, под паролем или «Альбом недоступен».
export function AlbumView({
  shopData,
  data,
  categories,
}: {
  shopData: ShopPage
  data: AlbumData | null
  categories: CategoryPublic[]
}) {
  const { shop } = shopData
  const base = `/${encodeURIComponent(shop.slug)}`
  const top = shopData.albums.filter((a) => !a.parent_id)
  const here = data ? albumHref(shop.slug, data.album) : base
  const crumbs = (title: string) => (
    <nav className="breadcrumbs sfcrumbs" aria-label="Хлебные крошки">
      <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
      <a href={`${base}/t/albums`}>Альбомы</a>
      <span aria-hidden="true">/</span>
      <span>{title}</span>
    </nav>
  )
  const header = (
    <ShopHeader
      shop={shop}
      albumCount={top.length}
      nav={{
        tabs: shopData.tabs,
        categories: withAlbumCounts(categories, shopData.albums),
        active: 'albums',
        empty: top.length === 0,
      }}
      from={here}
    />
  )

  if (!data) {
    // Удалён, в черновике или не существует (макет 15 · «Альбом недоступен»):
    // витрина работает — шапка и вкладки на месте.
    return (
      <main className="page">
        <TrackView shopId={shop.id} />
        {header}
        {crumbs('Альбом недоступен')}
        <EmptyState
          icon="image"
          title="Альбом недоступен"
          text="Продавец удалил или скрыл этот альбом, либо в ссылке ошибка. Посмотрите другие альбомы витрины."
        >
          <a className="btn btn--primary" href={`${base}/t/albums`}>
            Все альбомы
          </a>
          <ContactMenu shop={shop} text={messageText(shop.msg_template, '')} about="" variant="ghost" />
        </EmptyState>
      </main>
    )
  }

  const { album, photos, children, per_page: perPage, total } = data
  const url = SITE_URL + here
  // Категории альбома знает сетка магазина (у «По ссылке» их там нет).
  const slugs = shopData.albums.find((a) => a.id === album.id)?.category_slugs ?? []
  const head: AlbumHeadProps = {
    shop,
    title: album.title,
    photoCount: album.photo_count,
    url,
    categories: categories
      .filter((c) => slugs.includes(c.slug))
      .map((c) => ({ title: c.title, href: `${base}/c/${encodeURIComponent(c.slug)}` })),
    updatedAt: album.updated_at,
    description: album.description,
  }

  return (
    <main className="page">
      <TrackView shopId={shop.id} albumId={album.id} />
      {header}
      {crumbs(album.title)}
      {album.locked ? (
        <LockedAlbum
          slug={shop.slug}
          albumId={album.id}
          albumSlug={album.slug}
          parentId={album.parent_id}
          head={head}
        />
      ) : (
        <>
          <AlbumHead {...head} />
          {/* Подальбомы: по ссылке на родителя покупатель видит и их. */}
          {children.length > 0 && (
            <section className="section">
              <h2 className="section__head">Внутри</h2>
              <AlbumGrid shopSlug={shop.slug} albums={children} />
            </section>
          )}
          <PhotoGrid
            photos={photos}
            total={total}
            perPage={perPage}
            shop={shop}
            albumTitle={album.title}
            source={{ shopSlug: shop.slug, albumSlug: album.slug, albumId: album.id }}
          />
        </>
      )}
    </main>
  )
}
