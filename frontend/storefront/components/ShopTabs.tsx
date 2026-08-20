import type { TabPublic } from '@/lib/api'

// Вкладку «Главная» скрываем, пока у магазина нет секций: до этого она
// показывает то же самое, что «Альбомы» (kit).
export function ShopTabs({
  shopSlug,
  tabs,
  hasSections,
  activeSlug,
}: {
  shopSlug: string
  tabs: TabPublic[]
  hasSections: boolean
  activeSlug: string
}) {
  const visible = tabs.filter((t) => t.slug !== 'home' || hasSections)
  if (visible.length <= 1) return null

  const href = (slug: string) =>
    slug === 'home' ? `/${shopSlug}` : `/${shopSlug}/t/${slug}`

  return (
    <nav className="shop-nav" aria-label="Разделы магазина">
      {visible.map((tab) => (
        <a
          key={tab.slug}
          href={href(tab.slug)}
          className="shop-tab"
          aria-current={tab.slug === activeSlug ? 'page' : undefined}
        >
          {tab.title}
        </a>
      ))}
    </nav>
  )
}
