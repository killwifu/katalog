import { CHANNEL_LABELS, contactHref, shopChannels } from '@/lib/links'
import type { ShopUnavailable as Payload } from '@/lib/api'

// Витрина скрыта за неоплату. Страница намеренно не объясняет покупателю
// причину: его задача — связаться с продавцом, а с оплатой разберётся
// продавец. Обрывать связь именно в этот момент — терять его выручку.
export function ShopUnavailable({ payload }: { payload: Payload }) {
  const channels = shopChannels(payload.shop.contacts ?? {})

  return (
    <main className="page center">
      <h1 className="album-header">{payload.shop.name}</h1>
      <p className="empty">
        Каталог временно недоступен. Напишите продавцу — он ответит и подскажет,
        что есть в наличии.
      </p>
      {channels.length > 0 && (
        <div className="lead-buttons">
          {channels.map(({ channel, value }) => (
            <a
              key={channel}
              href={contactHref(channel, value, '')}
              target="_blank"
              rel="noopener noreferrer"
              className={`btn btn-${channel}`}
            >
              {CHANNEL_LABELS[channel]}
            </a>
          ))}
        </div>
      )}
    </main>
  )
}
