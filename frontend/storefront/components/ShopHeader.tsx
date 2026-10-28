import type { CategoryPublic, ShopPublic, TabPublic } from '@/lib/api'
import { CHANNEL_LABELS, contactHref, shopChannels, type Channel } from '@/lib/links'
import { LeadLink } from './LeadLink'
import { SearchForm } from './SearchForm'
import { ShopTabs } from './ShopTabs'

// Как контакт выглядит в строке под названием магазина (макет 15):
// «Telegram @seoulwear · WhatsApp +7 999 123-45-67». Полную ссылку
// (VK, MAX) не печатаем — хватит названия канала.
function contactLabel(channel: Channel, value: string): string {
  const v = value.trim()
  if (/^https?:\/\//i.test(v) || channel === 'avito') return CHANNEL_LABELS[channel]
  // Ссылку t.me/ник без https:// печатаем ником, а не «@t.me/ник».
  if (channel === 'telegram') return `Telegram @${v.replace(/^(?:www\.)?(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/\/$/, '')}`
  // Российский номер хранится цифрами (79991234567) — печатаем как в макете.
  const ru = v.replace(/[^\d]/g, '').match(/^[78](\d{3})(\d{3})(\d{2})(\d{2})$/)
  if (channel === 'whatsapp' && ru) return `${CHANNEL_LABELS[channel]} +7 ${ru[1]} ${ru[2]}-${ru[3]}-${ru[4]}`
  return `${CHANNEL_LABELS[channel]} ${v}`
}

function initials(name: string): string {
  const words = name.split(/[\s\-_.]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)
  return letters.toUpperCase()
}

function albumsWord(n: number): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return 'альбом'
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'альбома'
  return 'альбомов'
}

type Nav = {
  tabs: TabPublic[]
  categories: CategoryPublic[]
  // Слаг активной вкладки; 'categories' — открыта страница категории.
  active: string
}

// Шапка витрины (макет 15): полоса площадки, блок продавца с поиском и
// меню витрины. Меню передаётся там, где оно есть (главная, вкладки,
// категория); у страниц альбома и поиска своя навигация — хлебные крошки.
export function ShopHeader({
  shop,
  albumCount,
  nav,
  showSearch = true,
}: {
  shop: ShopPublic
  albumCount?: number
  nav?: Nav
  showSearch?: boolean
}) {
  const channels = shopChannels(shop.contacts)
  // Обращение без товара; шаблон с {caption} тут неуместен.
  const text = 'Здравствуйте!'
  const about = [
    shop.description,
    albumCount ? `${albumCount} ${albumsWord(albumCount)}` : '',
  ].filter(Boolean)
  return (
    <>
      <div className="shopbar">
        <a href="/" className="shopbar__brand">
          Katalog
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
              <a href={`/${encodeURIComponent(shop.slug)}`}>{shop.name}</a>
            </h1>
            {about.length > 0 && <p className="shophead__about">{about.join(' · ')}</p>}
            {channels.length > 0 && (
              <p className="shophead__contacts">
                {channels.map(({ channel, value }, i) => (
                  <span key={channel}>
                    {i > 0 && ' · '}
                    <LeadLink
                      shopId={shop.id}
                      channel={channel}
                      href={contactHref(channel, value, text)}
                    >
                      {contactLabel(channel, value)}
                    </LeadLink>
                  </span>
                ))}
                {/* Время ответа рядом с контактами: покупатель не ждёт ответа
                    ночью и не считает, что продавец его игнорирует. */}
                {shop.reply_time && <span> · {shop.reply_time}</span>}
              </p>
            )}
          </div>
          {showSearch && <SearchForm slug={shop.slug} />}
        </div>
        {nav && (
          <ShopTabs
            shopSlug={shop.slug}
            tabs={nav.tabs}
            categories={nav.categories}
            activeSlug={nav.active}
          />
        )}
      </header>
    </>
  )
}
