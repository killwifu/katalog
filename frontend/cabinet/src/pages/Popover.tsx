import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Icon } from '../lib/icons'
import { useMenuFocus } from '../lib/menuFocus'

// Кнопка с выпадающей панелью: сортировка, фильтр, меню «Ещё». Закрывается кликом
// мимо и по Escape — иначе панель остаётся висеть поверх сетки.
export function Popover({
  open,
  onToggle,
  label,
  title,
  active,
  plain,
  icon,
  chevron = true,
  sheet,
  sheetTitle,
  children,
}: {
  // На телефоне — шторкой снизу с заголовком и крестиком (макет 10 ·
  // Mobile · Сортировка / Фильтр); шире — обычной панелью.
  sheet?: boolean
  // Заголовок шторки, если он не совпадает с подписью для скринридера.
  sheetTitle?: string
  // Иконка вместо подписи на узком экране (макет 10 · Mobile): кнопка
  // становится квадратной, подпись остаётся для скринридера.
  icon?: React.ReactNode
  open: boolean
  onToggle: (open: boolean) => void
  label: string
  title: string
  active?: boolean
  // Без стрелки и без подписи значения — для меню действий.
  plain?: boolean
  // Шеврон у подписи; у «Фильтра» в макете 10 его нет.
  chevron?: boolean
  children: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onToggle(false)
    }
    // Esc закрывает только панель, а не окно, в котором она открыта:
    // ловим на погружении и помечаем событие обработанным.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // Фокус — обратно на кнопку до закрытия: иначе он пропадает вместе с
      // пунктом меню и падает на body.
      if (box.current?.contains(document.activeElement)) box.current.querySelector<HTMLElement>(':scope > button')?.focus()
      onToggle(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, onToggle])
  // Панель у нижнего края окна (категории последней папки в массовой
  // загрузке) уходила за экран — докручиваем, чтобы она была видна целиком.
  useEffect(() => {
    if (open) box.current?.querySelector('.pop__panel')?.scrollIntoView({ block: 'nearest' })
  }, [open])
  useMenuFocus(open, () => onToggle(false), box, '.pop__panel')

  return (
    <div className="pop" ref={box}>
      <button
        className={`btn btn--ghost pop__btn ${active ? 'pop__btn--on' : ''} ${plain && icon ? 'pop__btn--icon' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={plain ? title : `${title}: ${label}`}
        onClick={() => onToggle(!open)}
      >
        {icon && (
          <span className="pop__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        {!(plain && icon) && <span className={icon ? 'pop__label' : undefined}>{label}</span>}
        {!plain && chevron && (
          <span className="pop__chev">
            <Icon as={open ? ChevronUp : ChevronDown} size={14} />
          </span>
        )}
      </button>
      {open && sheet && <div className="pop__shade" onClick={() => onToggle(false)} aria-hidden="true" />}
      {open && (
        <div className={sheet ? 'pop__panel pop__panel--sheet' : 'pop__panel'}>
          {sheet && (
            <div className="pop__sheethead">
              <b>{sheetTitle ?? title}</b>
              <button className="pop__sheetx" onClick={() => onToggle(false)} aria-label="Закрыть">
                <Icon as={X} size={20} />
              </button>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  )
}
