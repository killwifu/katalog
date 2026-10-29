import type { CategoryPublic, ShopPublic, TabPublic } from '@/lib/api'
import { SearchForm } from './SearchForm'
import { ShopAbout } from './ShopAbout'
import { ShopTabs } from './ShopTabs'

function initials(name: string): string {
  const words = name.split(/[\s\-_.]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)
  return letters.toUpperCase()
}

export function albumsWord(n: number): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return 'альбом'
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'альбома'
  return 'альбомов'
}

type Nav = {
  tabs: TabPublic[]
  categories: CategoryPublic[]
  // Слаг активной вкладки; 'categories' — страница категории, '' — ничего
  // не подсвечено (поиск).
  active: string
  // В витрине нет альбомов: «Категории» без выпадающего списка.
  empty?: boolean
}

// Шапка витрины (макет 15): полоса площадки, блок продавца (аватар, имя,
// число альбомов, описание в одну строку с «ещё») с поиском и меню витрины.
// Контактов в шапке нет — они во вкладке «Контакты».
export function ShopHeader({
  shop,
  albumCount,
  nav,
  search,
  from,
}: {
  shop: ShopPublic
  albumCount?: number
  nav: Nav
  // Текст в поле поиска (страница результатов).
  search?: string
  // Куда вернуть «Сбросить поиск»: текущая страница.
  from: string
}) {
  const base = `/${encodeURIComponent(shop.slug)}`
  return (
    <>
      <div className="shopbar">
        <a href="/" className="shopbar__brand">
          вуад
        </a>
        <a href="/" className="shopbar__cta">
          Создать <span>свою </span>витрину →
        </a>
      </div>
      <header className="shophead">
        <div className="shophead__row">
          <span className="shophead__ava" aria-hidden="true">
            {/* Логотип из «Настроек» (макет 17); без него — инициалы. */}
            {shop.logo_url ? <img src={shop.logo_url} alt="" /> : initials(shop.name)}
          </span>
          <div className="shophead__info">
            <h1>
              <a href={base}>{shop.name}</a>
              {albumCount ? (
                <span className="shophead__n">
                  {albumCount} {albumsWord(albumCount)}
                </span>
              ) : null}
            </h1>
            {shop.description && <ShopAbout text={shop.description} contactsHref={`${base}/t/contacts`} />}
          </div>
          <SearchForm slug={shop.slug} initial={search} from={from} />
        </div>
        <ShopTabs
          shopSlug={shop.slug}
          tabs={nav.tabs}
          categories={nav.categories}
          activeSlug={nav.active}
          empty={nav.empty}
        />
      </header>
    </>
  )
}
