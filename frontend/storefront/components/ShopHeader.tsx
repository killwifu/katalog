import type { ShopPublic } from '@/lib/api'
import { CHANNEL_LABELS, contactHref, shopChannels } from '@/lib/links'
import { LeadLink } from './LeadLink'
import { SearchForm } from './SearchForm'

// Шапка магазина: имя, описание, контактные кнопки, поиск.
export function ShopHeader({ shop, showSearch = true }: { shop: ShopPublic; showSearch?: boolean }) {
  const channels = shopChannels(shop.contacts)
  // Кнопки шапки — обращение без товара; шаблон с {caption} тут неуместен.
  const text = 'Здравствуйте!'
  return (
    <header className="shop-header">
      <h1>
        <a href={`/${encodeURIComponent(shop.slug)}`}>{shop.name}</a>
      </h1>
      {shop.description && <p className="shop-description">{shop.description}</p>}
      {channels.length > 0 && (
        <div className="lead-buttons">
          {channels.map(({ channel, value }) => (
            <LeadLink
              key={channel}
              shopId={shop.id}
              channel={channel}
              href={contactHref(channel, value, text)}
              className={`btn btn-${channel}`}
            >
              {CHANNEL_LABELS[channel]}
            </LeadLink>
          ))}
        </div>
      )}
      {showSearch && <SearchForm slug={shop.slug} />}
    </header>
  )
}
