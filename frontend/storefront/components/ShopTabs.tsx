import type { CategoryPublic, TabPublic } from '@/lib/api'
import { CategoryDropdown } from './CategoryDropdown'

// Меню витрины (макет 15): «Главная · Альбомы · Категории · Контакты» и
// вкладки, которые продавец завёл сам. «Категории» — не вкладка, а
// выпадающий список; если категорий нет совсем, пункта нет.
export function ShopTabs({
  shopSlug,
  tabs,
  categories,
  activeSlug,
  empty = false,
}: {
  shopSlug: string
  tabs: TabPublic[]
  categories: CategoryPublic[]
  activeSlug: string
  // В витрине нет альбомов (макет 15 · «Пустая витрина»): пункт
  // «Категории» остаётся, но без выпадающего списка.
  empty?: boolean
}) {
  const base = `/${encodeURIComponent(shopSlug)}`
  const href = (slug: string) => (slug === 'home' ? base : `${base}/t/${slug}`)
  // «Категории» стоят сразу за «Альбомами» (или за «Главной», если
  // вкладки «Альбомы» у магазина нет).
  const anchor = tabs.some((t) => t.slug === 'albums') ? 'albums' : 'home'
  const dropdown =
    categories.length > 0 && empty ? (
      <span key="categories" className="shop-tab">
        Категории
      </span>
    ) : categories.length > 0 ? (
      <CategoryDropdown
        key="categories"
        shopSlug={shopSlug}
        categories={categories}
        active={activeSlug === 'categories'}
      />
    ) : null

  return (
    <nav className="shop-nav" aria-label="Разделы магазина">
      {tabs.flatMap((tab) => {
        // Пустую вкладку покупателю не показываем: тап по ней вёл в «В этом
        // разделе пока ничего нет». Открытую по прямой ссылке — оставляем.
        if (tab.empty && tab.slug !== activeSlug) return []
        const link = (
          <a
            key={tab.slug}
            href={href(tab.slug)}
            className="shop-tab"
            aria-current={tab.slug === activeSlug ? 'page' : undefined}
          >
            {tab.title}
          </a>
        )
        return tab.slug === anchor ? [link, dropdown] : [link]
      })}
    </nav>
  )
}
