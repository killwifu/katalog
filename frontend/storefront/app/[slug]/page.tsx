import type { Metadata } from 'next'
import { ShopUnavailableError, getShopPage } from '@/lib/api'
import { ShopHome } from '@/components/ShopHome'

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
  let data: Awaited<ReturnType<typeof getShopPage>>
  try {
    data = await getShopPage(slug)
  } catch (e) {
    // Скрытая витрина всё равно должна отдавать осмысленный заголовок.
    if (e instanceof ShopUnavailableError) {
      return { title: `${e.payload.shop.name} — каталог временно недоступен` }
    }
    throw e
  }
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

export default function ShopPage({ params }: Props) {
  return <ShopHome slug={params.slug} page={1} />
}
