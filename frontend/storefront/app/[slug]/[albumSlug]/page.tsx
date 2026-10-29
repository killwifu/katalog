import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { albumHref, getAlbumPage, getCategories, getShopPage, loadOrUnavailable } from '@/lib/api'
import { AlbumView } from '@/components/AlbumView'
import { ShopUnavailable } from '@/components/ShopUnavailable'

// Страница альбома: /{shop}/{album_slug} (макет 15). Пути витрины (a, c, p,
// t, search) — статические сегменты и имеют приоритет; бэкенд такие слаги
// альбомам не выдаёт. Чтение searchParams (?p=) делает рендер динамическим,
// данные — из data cache Next (тег shop:{slug}): Postgres не трогаем.

type Props = {
  params: { slug: string; albumSlug: string }
  searchParams: { p?: string }
}

async function load(slug: string, albumSlug: string) {
  return loadOrUnavailable(() =>
    Promise.all([getShopPage(slug), getAlbumPage(slug, albumSlug, 1), getCategories(slug)]),
  )
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const res = await load(params.slug, params.albumSlug)
  if (!res.ok) return { title: `${res.payload.shop.name} — каталог временно недоступен` }
  const [shopData, data] = res.data
  if (!shopData) return { title: 'Витрина не найдена' }
  // Недоступный альбом отдаётся страницей витрины — поисковику она не нужна.
  if (!data) return { title: `Альбом недоступен — ${shopData.shop.name}`, robots: { index: false } }
  // Покупатель пересылает ссылку на конкретный товар (?p=) — в превью
  // мессенджера должен быть он, а не обложка альбома.
  const shared = searchParams.p ? data.photos.find((ph) => ph.id === searchParams.p) : undefined
  const cover = (shared ?? data.photos[0])?.urls
  const ogTitle = shared?.caption
    ? `${shared.caption.slice(0, 100)} — ${data.shop.name}`
    : `${data.album.title} — ${data.shop.name}`
  return {
    // «По ссылке» и закрытый паролем альбом в выдаче поисковика ни к чему.
    robots: data.album.unlisted || data.album.has_password ? { index: false, follow: true } : undefined,
    title: `${data.album.title} — ${data.shop.name}`,
    description:
      data.album.description?.slice(0, 160) ||
      `${data.album.title}: ${data.album.photo_count} фото в каталоге ${data.shop.name}`,
    alternates: { canonical: albumHref(data.shop.slug, data.album) },
    openGraph: { title: ogTitle, type: 'website', images: cover ? [{ url: cover.medium }] : undefined },
  }
}

export default async function AlbumPage({ params }: Props) {
  const { slug, albumSlug } = params
  // Прямая ссылка на альбом — обычный вход покупателя из мессенджера,
  // и неоплаченная витрина должна встретить его контактами продавца.
  const res = await load(slug, albumSlug)
  if (!res.ok) return <ShopUnavailable payload={res.payload} />
  const [shopData, data, categories] = res.data
  if (!shopData) notFound()
  return <AlbumView shopData={shopData} data={data} categories={categories ?? []} />
}
