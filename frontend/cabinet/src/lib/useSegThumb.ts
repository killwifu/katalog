import { useLayoutEffect, useRef } from 'react'

// Подложка переключателя по фактической кнопке: в макете сегменты — по
// содержимому («Фото» 58, «ГБ» 40), поэтому равные колонки не годятся.
// Пишем положение и ширину выбранной кнопки в --seg-x/--seg-w, подложка
// (.seg::before) едет по ним с анимацией.
export function useSegThumb<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const on = el?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (!el || !on) return
    el.style.setProperty('--seg-x', `${on.offsetLeft}px`)
    el.style.setProperty('--seg-w', `${on.offsetWidth}px`)
  }, [dep])
  return ref
}
