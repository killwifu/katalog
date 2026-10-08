import { useEffect, type MouseEvent } from 'react'

// Закрытие окна по Esc и по клику мимо (макет: «Закрытие (крестик,
// «Отмена», Esc, клик мимо) при введённых данных → подтверждение»).
// close — та же функция, что у крестика: она сама решает, спрашивать ли
// подтверждение. Возвращает обработчик для подложки окна.
export function useDialogClose(close: () => void): { onMouseDown: (e: MouseEvent) => void } {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc уже забрала открытая внутри окна панель (Popover).
      if (e.key === 'Escape' && !e.defaultPrevented) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
  return {
    // mousedown, а не click: выделение текста в поле, законченное за
    // пределами окна, не должно его закрывать.
    onMouseDown: (e) => {
      if (e.target === e.currentTarget) close()
    },
  }
}
