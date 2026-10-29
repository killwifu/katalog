'use client'

import { ChevronLeft, ChevronRight, Link2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AlbumPage, PhotoPublic, ShopPublic } from '@/lib/api'
import { messageText } from '@/lib/links'
import { ContactMenu } from './ContactMenu'
import { copyText, useToast } from './Toast'

// Сетка фото альбома (макет 15): все фото одной сеткой, следующие порции
// подгружаются при прокрутке; клик — просмотр. Покупателю уходят только
// WebP-деривативы (srcset), скачивания нет.
//
// Откуда брать следующие порции: открытый альбом — с витрины
// (/{shop}/{album}/photos, тот же data cache, что у страницы, Postgres на
// горячем пути не трогаем); закрытый паролем — из API с пропуском.
export type PhotoSource = { shopSlug: string; albumSlug: string; albumId: string; token?: string }

async function fetchPhotos(src: PhotoSource, page: number): Promise<PhotoPublic[] | null> {
  const url = src.token
    ? `/api/v1/public/shops/${encodeURIComponent(src.shopSlug)}/albums/${encodeURIComponent(src.albumId)}?page=${page}`
    : `/${encodeURIComponent(src.shopSlug)}/${encodeURIComponent(src.albumSlug)}/photos?page=${page}`
  try {
    const res = await fetch(url, src.token ? { headers: { 'X-Album-Token': src.token }, cache: 'no-store' } : undefined)
    if (!res.ok) return null
    const data = (await res.json()) as Pick<AlbumPage, 'photos'> & { album?: { locked?: boolean } }
    return data.album?.locked ? null : data.photos
  } catch {
    return null
  }
}

type Props = {
  photos: PhotoPublic[]
  total: number
  perPage: number
  shop: ShopPublic
  albumTitle: string
  source: PhotoSource
}

export function PhotoGrid({ photos: first, total, perPage, shop, albumTitle, source }: Props) {
  const [photos, setPhotos] = useState(first)
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const loading = useRef(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const hasMore = photos.length < total
  // Открытое фото живёт в адресе (?p=) и в истории: ссылку на товар можно
  // переслать, а «Назад» на Android закрывает просмотр, а не уводит из магазина.
  const pushed = useRef(false)

  // Актуальный список для обработчиков, подписанных один раз (popstate).
  const list = useRef(first)
  list.current = photos
  const loadMore = useCallback(async (): Promise<PhotoPublic[]> => {
    const have = list.current
    if (loading.current) return have
    loading.current = true
    const next = await fetchPhotos(source, Math.floor(have.length / perPage) + 1)
    loading.current = false
    if (!next || next.length === 0) return have
    const seen = new Set(have.map((p) => p.id))
    const merged = [...have, ...next.filter((p) => !seen.has(p.id))]
    list.current = merged
    setPhotos(merged)
    return merged
  }, [perPage, source])

  // Подгрузка при прокрутке: за экран до конца сетки.
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && void loadMore(), {
      rootMargin: '800px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadMore])

  // ?p= из адреса: фото может лежать дальше первой порции — догружаем.
  useEffect(() => {
    const sync = async () => {
      const id = new URLSearchParams(location.search).get('p')
      let have = list.current
      let i = id ? have.findIndex((p) => p.id === id) : -1
      while (id && i < 0 && have.length < total) {
        const more = await loadMore()
        if (more.length === have.length) break
        have = more
        i = have.findIndex((p) => p.id === id)
      }
      if (i < 0) pushed.current = false
      setOpenIndex(i >= 0 ? i : null)
    }
    void sync()
    addEventListener('popstate', sync)
    return () => removeEventListener('popstate', sync)
    // Только на вход и на «Назад»: дальнейшие порции просмотр не трогают.
  }, [])

  const putInUrl = (index: number, items: PhotoPublic[], mode: 'push' | 'replace') => {
    const params = new URLSearchParams(location.search)
    params.set('p', items[index].id)
    const url = `${location.pathname}?${params.toString()}`
    if (mode === 'push') history.pushState(null, '', url)
    else history.replaceState(null, '', url)
    setOpenIndex(index)
  }

  const open = (index: number) => {
    pushed.current = true
    putInUrl(index, photos, 'push')
  }

  const navigate = async (index: number) => {
    let items = photos
    if (index >= items.length && hasMore) items = await loadMore()
    putInUrl(((index % items.length) + items.length) % items.length, items, 'replace')
  }

  const close = () => {
    // Просмотр открыт по прямой ссылке — уходить назад некуда: чистим адрес.
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
                src={p.urls.small}
                srcSet={`${p.urls.small} 500w, ${p.urls.medium} 800w`}
                sizes="(max-width: 640px) 33vw, (max-width: 1199px) 20vw, 186px"
                width={p.width || undefined}
                height={p.height || undefined}
                loading={i < 12 ? 'eager' : 'lazy'}
                decoding="async"
                alt={p.caption || 'Фото товара'}
              />
            </button>
            {p.caption && <p className="caption">{p.caption}</p>}
          </li>
        ))}
      </ul>
      {hasMore && <div ref={sentinel} className="photo-more" aria-hidden="true" />}
      {openIndex !== null && photos[openIndex] && (
        <Lightbox
          photos={photos}
          index={openIndex}
          total={total}
          shop={shop}
          albumTitle={albumTitle}
          onNavigate={(i) => void navigate(i)}
          onClose={close}
        />
      )}
    </>
  )
}

function Lightbox({
  photos,
  index,
  total,
  shop,
  albumTitle,
  onNavigate,
  onClose,
}: {
  photos: PhotoPublic[]
  index: number
  total: number
  shop: ShopPublic
  albumTitle: string
  onNavigate: (i: number) => void
  onClose: () => void
}) {
  const photo = photos[index]
  const body = useRef<HTMLDivElement>(null)
  const thumbs = useRef<HTMLDivElement>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  // Увеличение по клику (на телефоне — щипком, его даёт браузер).
  const [zoom, setZoom] = useState<string | null>(null)
  const [toast, show] = useToast()
  const prev = useCallback(() => onNavigate(index - 1), [index, onNavigate])
  const next = useCallback(() => onNavigate(index + 1), [index, onNavigate])

  useEffect(() => setZoom(null), [index])

  // Возврат фокуса и блокировка прокрутки — ровно на монтирование.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    body.current?.querySelector<HTMLElement>('.lb-close')?.focus()
    return () => {
      document.body.style.overflow = ''
      returnTo?.focus()
    }
  }, [])

  // Текущее превью — в видимой части ленты.
  useEffect(() => {
    thumbs.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [index])

  // Клавиатура: Esc, стрелки и запирание таба внутри окна.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc в открытом списке каналов закрывает только список.
      if (e.key === 'Escape' && !body.current?.querySelector('.sfpop')) onClose()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'ArrowRight') next()
      if (e.key !== 'Tab' || !body.current) return
      const items = body.current.querySelectorAll<HTMLElement>('a[href], button')
      if (items.length === 0) return
      const firstEl = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, prev, next])

  const link = photoLink(photo.id)
  // В сообщение — ссылка на это фото (макет 15), подпись — если есть.
  const caption = photo.caption.trim()
  const text = messageText(shop.msg_template, caption ? `${caption}\n${link}` : link)
  const contact = (cls: string) => (
    <ContactMenu shop={shop} text={text} photoId={photo.id} about="фото" className={cls} />
  )

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={photo.caption || 'Фото товара'} ref={body}>
      <div className="lb-top">
        <div className="lb-title">
          <b>{albumTitle}</b>
          <span>
            {index + 1} из {total}
          </span>
        </div>
        <div className="lb-actions">
          {contact('lb-write')}
          <button
            type="button"
            className="lb-icon"
            aria-label="Скопировать ссылку на фото"
            onClick={() => void copyText(link).then((ok) => show(ok ? 'Ссылка на фото скопирована' : 'Не удалось скопировать ссылку'))}
          >
            <Link2 size={18} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button type="button" className="lb-icon lb-close" onClick={onClose} aria-label="Закрыть">
            <X size={18} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </div>
      {toast && <div className="lb-toast">{toast}</div>}
      <div
        className="lb-stage"
        onClick={(e) => e.target === e.currentTarget && onClose()}
        onTouchStart={(e) => {
          touch.current = e.touches.length === 1 && !zoom ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null
        }}
        onTouchEnd={(e) => {
          const t = touch.current
          touch.current = null
          // Щипок или увеличенное фото — не листаем.
          if (!t || zoom || (window.visualViewport && window.visualViewport.scale > 1.01)) return
          const dx = e.changedTouches[0].clientX - t.x
          const dy = e.changedTouches[0].clientY - t.y
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
            if (dx < 0) next()
            else prev()
          } else if (dy > 90 && dy > Math.abs(dx)) onClose()
        }}
      >
        {total > 1 && (
          <button type="button" className="lb-nav lb-prev" onClick={prev} aria-label="Назад">
            <ChevronLeft size={22} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        <img
          key={photo.id}
          src={photo.urls.large}
          srcSet={`${photo.urls.medium} 800w, ${photo.urls.large} 1600w`}
          sizes="(max-width: 640px) 100vw, 70vw"
          alt={photo.caption || 'Фото товара'}
          className={zoom ? 'is-zoomed' : undefined}
          style={zoom ? { transformOrigin: zoom } : undefined}
          onClick={(e) => {
            if (zoom) return setZoom(null)
            const r = e.currentTarget.getBoundingClientRect()
            setZoom(`${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`)
          }}
        />
        {total > 1 && (
          <button type="button" className="lb-nav lb-next" onClick={next} aria-label="Вперёд">
            <ChevronRight size={22} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </div>
      {photo.caption && <p className="lb-caption">{photo.caption}</p>}
      {photos.length > 1 && (
        <div className="lb-thumbs" ref={thumbs}>
          {photos.map((p, i) => (
            <button
              key={p.id}
              type="button"
              aria-current={i === index ? 'true' : undefined}
              aria-label={`Фото ${i + 1}`}
              onClick={() => onNavigate(i)}
            >
              <img src={p.urls.small} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
      <div className="lb-bottom">{contact('lb-write lb-write--block')}</div>
    </div>
  )
}

function photoLink(id: string): string {
  if (typeof window === 'undefined') return ''
  return `${location.origin}${location.pathname}?p=${encodeURIComponent(id)}`
}
