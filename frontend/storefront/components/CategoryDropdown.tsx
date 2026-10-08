'use client'

import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CategoryPublic } from '@/lib/api'

// «Категории» в меню витрины (макет 15). Одна разметка — три поведения:
//   десктоп — список по наведению, подкатегории вторым уровнем справа;
//   планшет — по нажатию, подкатегории раскрываются стрелкой в списке;
//   телефон — нижняя шторка, подкатегории так же стрелкой.
// Различия — в CSS (hover и ширина), здесь только «открыто/закрыто».
// Клиентский компонент: закрытие по Esc и по нажатию мимо на <details>
// не сделать, а шторка без этого запирает покупателя.
export function CategoryDropdown({
  shopSlug,
  categories,
  active,
}: {
  shopSlug: string
  categories: CategoryPublic[]
  active: boolean
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Фокус — обратно на «Категории», иначе он пропадает вместе со списком.
      if (root.current?.contains(document.activeElement)) root.current.querySelector<HTMLElement>('.catdd__btn')?.focus()
      setOpen(false)
    }
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  const base = `/${encodeURIComponent(shopSlug)}/c/`
  const roots = categories.filter((c) => !c.parent_slug)
  // Наведение открывает список только там, где оно есть: на тач-экране
  // браузер шлёт mouseenter перед click, и список открывался бы и тут же
  // закрывался нажатием.
  const hoverable = () => window.matchMedia('(hover: hover) and (min-width: 1025px)').matches

  return (
    <div
      ref={root}
      className={`catdd${open ? ' is-open' : ''}`}
      onMouseEnter={() => hoverable() && setOpen(true)}
      onMouseLeave={() => hoverable() && setOpen(false)}
    >
      <button
        type="button"
        className="shop-tab catdd__btn"
        aria-expanded={open}
        aria-haspopup="true"
        data-active={active || undefined}
        // С мышью список уже открыт наведением — нажатие не должно его гасить.
        onClick={() => setOpen((v) => hoverable() || !v)}
      >
        Категории
        <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <>
          <div className="catdd__shade" onClick={() => setOpen(false)} />
          <div className="catdd__panel" role="group" aria-label="Категории">
            <div className="catdd__head">
              <strong>Категории</strong>
              <button type="button" onClick={() => setOpen(false)} aria-label="Закрыть">
                <X size={20} strokeWidth={1.6} aria-hidden="true" />
              </button>
            </div>
            <ul>
              {roots.map((c) => {
                const children = categories.filter((s) => s.parent_slug === c.slug)
                const isOpen = expanded === c.slug
                return (
                  <li key={c.slug} className={isOpen ? 'is-expanded' : undefined}>
                    <div className="catdd__row">
                      <a href={base + encodeURIComponent(c.slug)}>
                        <span>{c.title}</span>
                        <span className="catdd__n">{c.album_count}</span>
                      </a>
                      {children.length > 0 && (
                        <button
                          type="button"
                          className="catdd__more"
                          aria-expanded={isOpen}
                          aria-label={`Подкатегории «${c.title}»`}
                          onClick={() => setExpanded(isOpen ? null : c.slug)}
                        >
                          <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
                            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                    {children.length > 0 && (
                      <ul className="catdd__sub">
                        {children.map((s) => (
                          <li key={s.slug}>
                            <a href={base + encodeURIComponent(s.slug)}>
                              <span>{s.title}</span>
                              <span className="catdd__n">{s.album_count}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
