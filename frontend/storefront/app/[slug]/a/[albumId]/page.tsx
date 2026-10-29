import { notFound, permanentRedirect } from 'next/navigation'
import { albumHref, getAlbumPage, getCategories, getShopPage, loadOrUnavailable } from '@/lib/api'
import { ShopUnavailable } from '@/components/ShopUnavailable'
import { AlbumView } from '@/components/AlbumView'

// Старый адрес альбома /{shop}/a/{uuid}: ссылки на него уже разосланы
// покупателям. 308 на адрес по слагу (/{shop}/{album_slug}) с теми же
// параметрами (?p= — открытое фото). Альбома нет — «Альбом недоступен».
type Props = {
  params: { slug: string; albumId: string }
  searchParams: Record<string, string | string[] | undefined>
}

export const metadata = { robots: { index: false } }

export default async function OldAlbumUrl({ params, searchParams }: Props) {
  const { slug, albumId } = params
  const res = await loadOrUnavailable(() =>
    Promise.all([getShopPage(slug), getAlbumPage(slug, albumId, 1), getCategories(slug)]),
  )
  if (!res.ok) return <ShopUnavailable payload={res.payload} />
  const [shopData, data, categories] = res.data
  if (!shopData) notFound()
  if (data) {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(searchParams)) if (typeof v === 'string' && k !== 'page') q.set(k, v)
    const qs = q.toString()
    permanentRedirect(albumHref(slug, data.album) + (qs ? `?${qs}` : ''))
  }
  return <AlbumView shopData={shopData} data={null} categories={categories ?? []} />
}
