'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PhotoPublic, ShopPublic } from '@/lib/api'
import { CHANNEL_LABELS, contactHref, messageText, shopChannels } from '@/lib/links'
import { LeadLink } from './LeadLink'

// Сетка фото (srcset по деривативам, lazy-load) + лайтбокс с кнопками
// «написать по товару». Покупателю уходят только WebP-деривативы.

export function PhotoGrid({ photos, shop }: { photos: PhotoPublic[]; shop: ShopPublic }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  if (photos.length === 0) {
    return <p className="empty">В этом альбоме пока нет фото.</p>
  }
  return (
    <>
      <ul className="photo-grid">
        {photos.map((p, i) => (
          <li key={p.id} className="photo-card">
            <button type="button" className="photo-open" onClick={() => setOpenIndex(i)}>
              <img
                src={p.urls.thumb}
                srcSet={`${p.urls.thumb} 300w, ${p.urls.medium} 800w`}
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                width={p.width || undefined}
                height={p.height || undefined}
                loading={i < 4 ? 'eager' : 'lazy'}
                decoding="async"
                alt={p.caption || 'Фото товара'}
              />
            </button>
            {p.caption && <p className="caption">{p.caption}</p>}
          </li>
        ))}
      </ul>
      {openIndex !== null && (
        <Lightbox
          photos={photos}
          index={openIndex}
          shop={shop}
          onNavigate={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  )
}

function Lightbox({
  photos,
  index,
  shop,
  onNavigate,
  onClose,
}: {
  photos: PhotoPublic[]
  index: number
  shop: ShopPublic
  onNavigate: (i: number) => void
  onClose: () => void
}) {
  const photo = photos[index]
  const prev = useCallback(
    () => onNavigate((index - 1 + photos.length) % photos.length),
    [index, photos.length, onNavigate],
  )
  const next = useCallback(
    () => onNavigate((index + 1) % photos.length),
    [index, photos.length, onNavigate],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'ArrowRight') next()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose, prev, next])

  const text = messageText(shop.msg_template, photo.caption)
  const channels = shopChannels(shop.contacts)

  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="lb-close" onClick={onClose} aria-label="Закрыть">
          ×
        </button>
        {photos.length > 1 && (
          <>
            <button type="button" className="lb-nav lb-prev" onClick={prev} aria-label="Назад">
              ‹
            </button>
            <button type="button" className="lb-nav lb-next" onClick={next} aria-label="Вперёд">
              ›
            </button>
          </>
        )}
        <img
          src={photo.urls.large}
          srcSet={`${photo.urls.medium} 800w, ${photo.urls.large} 1600w`}
          sizes="100vw"
          alt={photo.caption || 'Фото товара'}
        />
        <div className="lb-info">
          {photo.caption && <p className="caption">{photo.caption}</p>}
          {channels.length > 0 && (
            <div className="lead-buttons">
              {channels.map(({ channel, value }) => (
                <LeadLink
                  key={channel}
                  shopId={shop.id}
                  photoId={photo.id}
                  channel={channel}
                  href={contactHref(channel, value, text)}
                  className={`btn btn-${channel}`}
                >
                  Написать в {CHANNEL_LABELS[channel]}
                </LeadLink>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
