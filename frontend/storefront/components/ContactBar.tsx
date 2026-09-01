import type { ShopPublic } from '@/lib/api'
import { CHANNEL_LABELS, contactHref, shopChannels } from '@/lib/links'
import { LeadLink } from './LeadLink'

// Кнопки связи вне лайтбокса. Покупатель приходит из мессенджера сразу
// в альбом, и до этого написать продавцу можно было только открыв фото —
// три действия там, где должно быть ноль. На телефоне полоса липнет
// к нижнему краю (см. .contactbar в globals.css).
export function ContactBar({ shop }: { shop: ShopPublic }) {
  const channels = shopChannels(shop.contacts)
  if (channels.length === 0) return null
  return (
    <div className="contactbar">
      <div className="lead-buttons">
        {channels.map(({ channel, value }) => (
          <LeadLink
            key={channel}
            shopId={shop.id}
            channel={channel}
            href={contactHref(channel, value, 'Здравствуйте!')}
            className={`btn btn-${channel}`}
          >
            {CHANNEL_LABELS[channel]}
          </LeadLink>
        ))}
      </div>
      {shop.reply_time && <p className="reply-time">{shop.reply_time}</p>}
    </div>
  )
}
