import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getShopPage, loadOrUnavailable } from '@/lib/api'
import { ShopHome } from '@/components/ShopHome'

// Вторая и следующие страницы главной. Номер — в пути, а не в query:
// страница остаётся статической (ISR), как и первая.
export const revalidate = 60

export function generateStaticParams(): { slug: string; page: string }[] {
  return []
}

type Props = {
  params: { slug: string; page: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const res = await loadOrUnavailable(() => getShopPage(params.slug))
  if (!res.ok) return { title: `${res.payload.shop.name} — каталог временно недоступен` }
  if (!res.data) return { title: 'Магазин не найден' }
  return { title: `${res.data.shop.name} — фотокаталог, страница ${params.page}` }
}

export default function ShopHomePage({ params }: Props) {
  // Только целые от 2: первая страница живёт на /{slug}, дубль не нужен.
  if (!/^[1-9]\d{0,3}$/.test(params.page)) notFound()
  const page = Number(params.page)
  if (page < 2) redirect(`/${encodeURIComponent(params.slug)}`)
  return <ShopHome slug={params.slug} page={page} />
}
