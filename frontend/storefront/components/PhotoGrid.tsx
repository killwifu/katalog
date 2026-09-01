'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoPublic, ShopPublic } from '@/lib/api'
import { CHANNEL_LABELS, contactHref, messageText, shopChannels } from '@/lib/links'
import { LeadLink } from './LeadLink'

// Сетка фото (srcset по деривативам, lazy-load) + лайтбокс с кнопками
// «написать по товару». Покупателю уходят только WebP-деривативы.

type Props = {
  photos: PhotoPublic[]
  shop: ShopPublic
  // Выдача поиска: показываем, в каком альбоме лежит найденное фото —
  // иначе покупатель нашёл товар и не знает, где смотреть остальное.
  albumTitles?: Record<string, string>
}

export function PhotoGrid({ photos, shop, albumTitles }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  // Открытое фото живёт в адресе и в истории. Без этого ссылку на конкретный
  // товар переслать было нельзя, а «Назад» на Android с открытым лайтбоксом
  // уносил покупателя из магазина вместо закрытия окна.
  const pushed = useRef(false)

  useEffect(() => {
    const sync = () => {
      const id = new URLSearchParams(location.search).get('p')
      const i = id ? photos.findIndex((p) => p.id === id) : -1
      if (i < 0) pushed.current = false
      setOpenIndex(i >= 0 ? i : null)
    }
    sync()
    addEventListener('popstate', sync)
    return () => removeEventListener('popstate', sync)
  }, [photos])

  const putInUrl = (index: number, mode: 'push' | 'replace') => {
    const params = new URLSearchParams(location.search)
    params.set('p', photos[index].id)
    const url = `${location.pathname}?${params.toString()}`
    if (mode === 'push') history.pushState(null, '', url)
    else history.replaceState(null, '', url)
    setOpenIndex(index)
  }

  const open = (index: number) => {
    pushed.current = true
    putInUrl(index, 'push')
  }

  const close = () => {
    // Лайтбокс открыт по прямой ссылке — уходить назад некуда: чистим адрес.
    if (!pushed.current) {
      const params = new URLSearchParams(location.search)
      params.delete('p')
      const q = params.toString()
      history.replaceState(null, '', location.pathname + (q ? `?${q}` : ''))
      setOpenIndex(null)
      return
    }
    history.back()
  }

  if (photos.length === 0) {
    return <p className="empty">В этом альбоме пока нет фото.</p>
  }
  return (
    <>
      <ul className="photo-grid">
        {photos.map((p, i) => (
          <li key={p.id} className="photo-card">
            <button type="button" className="photo-open" onClick={() => open(i)}>
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
            {albumTitles?.[p.album_id] && (
              <a className="photo-album" href={`/${encodeURIComponent(shop.slug)}/a/${p.album_id}`}>
                {albumTitles[p.album_id]}
              </a>
            )}
          </li>
        ))}
      </ul>
      {openIndex !== null && (
        <Lightbox
          photos={photos}
          index={openIndex}
          shop={shop}
          onNavigate={(i) => putInUrl(i, 'replace')}
          onClose={close}
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
  const body = useRef<HTMLDivElement>(null)
  const prev = useCallback(
    () => onNavigate((index - 1 + photos.length) % photos.length),
    [index, photos.length, onNavigate],
  )
  const next = useCallback(
    () => onNavigate((index + 1) % photos.length),
    [index, photos.length, onNavigate],
  )

  // Возврат фокуса на плитку и блокировка прокрутки — ровно на монтирование.
  // В одном эффекте с клавиатурой это ломалось: стрелки меняют prev/next,
  // эффект переподписывался, и «плиткой, откуда пришли» становилась кнопка
  // закрытия — на выходе фокус улетал в никуда.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    body.current?.querySelector<HTMLElement>('button')?.focus()
    return () => {
      document.body.style.overflow = ''
      returnTo?.focus()
    }
  }, [])

  // Клавиатура: Esc, стрелки и запирание таба внутри окна — без этого
  // табом уходишь за оверлей, в невидимую страницу под ним.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'ArrowRight') next()
      if (e.key !== 'Tab' || !body.current) return
      const items = body.current.querySelectorAll<HTMLElement>('a[href], button')
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, prev, next])

  const text = messageText(shop.msg_template, photo.caption)
  const channels = shopChannels(shop.contacts)

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={photo.caption || 'Фото товара'}
      onClick={onClose}
    >
      <div className="lightbox-body" ref={body} onClick={(e) => e.stopPropagation()}>
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
