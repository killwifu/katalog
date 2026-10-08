import { useEffect, type RefObject } from 'react'

// Клавиатура в выпадающих меню и панелях (сортировка, фильтр, «Ещё», «⋯»,
// меню аккаунта). Раньше фокус оставался на кнопке: открытое меню нельзя было
// пройти с клавиатуры, Tab уводил на страницу под ним, а после Esc фокус
// терялся. Теперь как в шаблоне «menu button»: при открытии — на первый пункт,
// стрелки ходят по пунктам меню, Esc закрывает и возвращает на кнопку,
// уход фокуса за пределы (Tab) закрывает меню.
const ITEMS =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

export function useMenuFocus(
  open: boolean,
  close: () => void,
  box: RefObject<HTMLElement | null>,
  panelSelector: string,
): void {
  useEffect(() => {
    const root = box.current
    if (!open || !root) return
    const button = root.querySelector<HTMLElement>(':scope > button')
    const items = () =>
      [...root.querySelectorAll<HTMLElement>(`${panelSelector} :is(${ITEMS})`)].filter(
        (el) => el.getClientRects().length > 0 && !el.matches('.pop__sheetx'),
      )
    // Открыли мышью — фокус не трогаем (иначе на меню вспыхивает рамка), с
    // клавиатуры — на первый пункт.
    const byKeyboard = document.activeElement === button && button?.matches(':focus-visible')
    const raf = requestAnimationFrame(() => {
      if (byKeyboard) items()[0]?.focus()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Само закрытие — у владельца меню; здесь только возврат фокуса.
        requestAnimationFrame(() => button?.focus())
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const list = items().filter((el) => el.closest('[role="menu"]'))
      if (list.length === 0) return
      e.preventDefault()
      const i = list.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length
      list[i === -1 ? 0 : next].focus()
    }
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null
      if (to && !root.contains(to)) close()
    }
    root.addEventListener('keydown', onKey)
    root.addEventListener('focusout', onFocusOut)
    return () => {
      cancelAnimationFrame(raf)
      root.removeEventListener('keydown', onKey)
      root.removeEventListener('focusout', onFocusOut)
    }
  }, [open, close, box, panelSelector])
}
