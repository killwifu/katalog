'use client'

import type { ReactNode } from 'react'

type Props = {
  shopId: string
  photoId?: string
  channel: string
  href: string
  className?: string
  // VK и MAX не принимают текст в ссылке: покупатель попадал в пустой чат,
  // и продавец не знал, о каком товаре речь. Кладём текст в буфер обмена.
  copyText?: string
  children: ReactNode
}

// Кнопка «написать продавцу»: deep-link в мессенджер + фиксация лида
// беконом (не задерживает переход, ошибки не ломают UX).
export function LeadLink({ shopId, photoId, channel, href, className, copyText, children }: Props) {
  const track = () => {
    // Вызов в обработчике клика — жест пользователя, буфер разрешён.
    if (copyText) navigator.clipboard?.writeText(copyText).catch(() => {})
    try {
      const body = JSON.stringify({ shop_id: shopId, photo_id: photoId, channel })
      navigator.sendBeacon('/api/v1/public/lead-click', new Blob([body], { type: 'application/json' }))
    } catch {
      // beacon недоступен — лид теряем молча, переход важнее.
    }
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={track}>
      {children}
    </a>
  )
}
