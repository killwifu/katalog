'use client'

import { Check, ChevronDown } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { AlbumSort } from '@/lib/sort'
import { Popup } from './Popup'

const LABELS: Record<AlbumSort, string> = { new: 'Сначала новые', photos: 'Больше фото' }

// Сортировка альбомов (макет 15 · «Альбомы · сортировка»): список под
// кнопкой, на телефоне — шторка. Выбор — ссылкой: ?sort=photos в адресе,
// переключатель страниц сбрасывается на 1.
export function SortMenu({ sort, hrefs }: { sort: AlbumSort; hrefs: Record<AlbumSort, string> }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  return (
    <div ref={root} className="sfsort">
      <button type="button" className="sfsort__btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {LABELS[sort]}
        <ChevronDown size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open && (
        <Popup title="Сортировка" onClose={close} root={root} className="sfpop--sort">
          <ul className="sfsort__list">
            {(Object.keys(LABELS) as AlbumSort[]).map((s) => (
              <li key={s}>
                <a href={hrefs[s]} aria-current={s === sort ? 'true' : undefined}>
                  {LABELS[s]}
                  {s === sort && <Check size={16} strokeWidth={2} aria-hidden="true" />}
                </a>
              </li>
            ))}
          </ul>
        </Popup>
      )}
    </div>
  )
}
