import { useLayoutEffect, useRef, type RefObject } from 'react'
import { pageZoom } from './zoom'

// Плавная перестановка (FLIP): после рендера сравниваем, где элементы были
// и где оказались, и доводим их до нового места анимацией, а не прыжком.
// Ключ — значение атрибута data-{attr}: тот же, по которому перетаскивание
// ищет цель. Тот, кого сейчас тащат (класс is-dragging), не трогаем.
export function useFlip(container: RefObject<HTMLElement | null>, attr: string) {
  const last = useRef(new Map<string, { x: number; y: number }>())
  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const next = new Map<string, { x: number; y: number }>()
    // Относительно контейнера: прокрутка страницы между рендерами не должна
    // выглядеть как переезд.
    const base = root.getBoundingClientRect()
    const z = pageZoom()
    for (const el of root.querySelectorAll<HTMLElement>(`[data-${attr}]`)) {
      const key = el.getAttribute(`data-${attr}`)
      if (!key) continue
      const r = el.getBoundingClientRect()
      // Посреди анимации прямоугольник включает её сдвиг: вычитаем его,
      // иначе повторный рендер (ответ сервера) перезапускал переезд рывком.
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform)
      const now = { x: (r.left - base.left) / z - m.m41, y: (r.top - base.top) / z - m.m42 }
      next.set(key, now)
      const was = last.current.get(key)
      if (!was || reduce || el.classList.contains('is-dragging') || el.hasAttribute('data-lifted')) continue
      const dx = was.x - now.x
      const dy = was.y - now.y
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
        duration: 260,
        easing: 'cubic-bezier(.2, .8, .2, 1)',
      })
    }
    last.current = next
  })
}
