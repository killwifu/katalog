'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Popup } from './Popup'

// Описание в шапке витрины (макет 15 · «Шапка · длинное описание»): одна
// строка, переносы — пробелами, лишнее — многоточием и «ещё». «ещё» нет,
// если описание помещается и переносов в нём нет. «ещё» открывает «О
// магазине»: полный текст абзацами (пустые строки подряд — одна),
// внизу ссылка на «Контакты».
export function ShopAbout({ text, contactsHref }: { text: string; contactsHref: string }) {
  const line = useRef<HTMLSpanElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState(text.includes('\n'))
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const el = line.current
    if (!el) return
    const check = () => setCut(text.includes('\n') || el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  const paragraphs = text.replace(/\r/g, '').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)
  return (
    <div ref={root} className="shabout">
      <p className="shophead__about">
        <span ref={line} className="shabout__line">
          {text.replace(/\s*\n\s*/g, ' ')}
        </span>
        {cut && (
          <button type="button" className="shabout__more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            ещё
          </button>
        )}
      </p>
      {open && (
        <Popup title="О магазине" onClose={close} root={root} className="sfpop--about">
          <div className="shabout__text">
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
          <a className="sflink" href={contactsHref}>
            Контакты продавца →
          </a>
        </Popup>
      )}
    </div>
  )
}
