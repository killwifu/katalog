'use client'

import { ChevronDown, MessageCircle } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { ShopPublic } from '@/lib/api'
import { CHANNEL_LABELS, NO_TEXT_CHANNELS, channelHandle, contactHref, shopChannels } from '@/lib/links'
import { ChannelIcon } from './ChannelIcon'
import { LeadLink } from './LeadLink'
import { Popup } from './Popup'

// «Написать продавцу» (макет 15): одна кнопка со списком каналов продавца.
// Канал один — кнопка сразу открывает чат; каналов нет — вместо списка
// «Продавец не оставил своих контактов». text — сообщение с подставленной
// ссылкой (на альбом или фото), about — о чём ссылка в подсказке.
export function ContactMenu({
  shop,
  text,
  photoId,
  about = 'альбом',
  variant = 'primary',
  label = 'Написать продавцу',
  className = '',
}: {
  shop: ShopPublic
  text: string
  photoId?: string
  about?: 'альбом' | 'фото' | ''
  variant?: 'primary' | 'ghost' | 'link'
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const channels = shopChannels(shop.contacts)
  const btnClass =
    variant === 'link' ? 'sflink' : `btn ${variant === 'primary' ? 'btn--primary' : 'btn--ghost'} sfcm__btn`
  const inner = (
    <>
      {variant !== 'link' && <MessageCircle size={17} strokeWidth={1.8} aria-hidden="true" />}
      {label}
      {variant === 'link' && ' →'}
    </>
  )

  if (channels.length === 1) {
    const { channel, value } = channels[0]
    return (
      <LeadLink
        shopId={shop.id}
        photoId={photoId}
        channel={channel}
        href={contactHref(channel, value, text)}
        className={`${btnClass} ${className}`}
        copyText={NO_TEXT_CHANNELS.includes(channel) ? text : undefined}
      >
        {inner}
      </LeadLink>
    )
  }

  const manual = channels.filter((c) => c.channel === 'vk' || c.channel === 'max').map((c) => CHANNEL_LABELS[c.channel])
  const hasAvito = channels.some((c) => c.channel === 'avito')
  return (
    <div ref={root} className={`sfcm ${className}`}>
      <button type="button" className={btnClass} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {inner}
        {variant !== 'link' && channels.length > 0 && (
          <ChevronDown size={16} strokeWidth={1.8} aria-hidden="true" className="sfcm__chev" />
        )}
      </button>
      {open && (
        <Popup title="Написать продавцу" onClose={close} root={root} className="sfpop--menu">
          {channels.length === 0 ? (
            <p className="sfcm__none">Продавец не оставил своих контактов</p>
          ) : (
            <>
              <ul className="sfcm__list">
                {channels.map(({ channel, value }) => (
                  <li key={channel}>
                    <LeadLink
                      shopId={shop.id}
                      photoId={photoId}
                      channel={channel}
                      href={contactHref(channel, value, text)}
                      copyText={NO_TEXT_CHANNELS.includes(channel) ? text : undefined}
                    >
                      <ChannelIcon channel={channel} size={32} />
                      <span>
                        <b>{CHANNEL_LABELS[channel]}</b>
                        <small>{channelHandle(channel, value)}</small>
                      </span>
                    </LeadLink>
                  </li>
                ))}
              </ul>
              {about && (
                <p className="sfcm__hint">
                  {[
                    `В чате уже будет текст со ссылкой на ${about}.`,
                    manual.length > 0 && `В ${manual.join(' и ')} его нужно вставить вручную${hasAvito ? ',' : '.'}`,
                    hasAvito && 'Авито откроет профиль продавца.',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </p>
              )}
            </>
          )}
        </Popup>
      )}
    </div>
  )
}
