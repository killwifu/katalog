import { useRef, useState, type PointerEvent } from 'react'
import { GHOST_STYLE } from './dragGhost'
import { pageZoom } from './zoom'

// Перестановка за ручку указателем — для режима «Изменить порядок» на
// планшете и телефоне (макеты 13–14): HTML5-перетаскивания на тач-экране
// нет. Цель ищется по атрибуту data-{attr} под пальцем; onDrop у ручки получает
// id того, что тащили, и id того, на что бросили.
// Пока тянут, элемент «поднят» (макет 11/13 · «Изменить порядок»): копия
// чуть больше, повёрнута и с тенью едет за пальцем, на месте — пунктир
// (атрибут data-lifted: className перерисовывает React, атрибут он не трогает).
export function usePointerReorder(attr: string) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const lift = useRef<{ ghost: HTMLElement; item: HTMLElement; x: number; y: number; z: number } | null>(null)
  const drop = () => {
    const l = lift.current
    if (!l) return
    l.ghost.remove()
    l.item.removeAttribute('data-lifted')
    lift.current = null
  }
  const reset = () => {
    drop()
    setDragging(null)
    setOver(null)
  }
  const handle = (id: string, onDrop: (from: string, to: string) => void) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(id)
      const item = e.currentTarget.closest<HTMLElement>(`[data-${attr}]`)
      if (item) {
        drop()
        const z = pageZoom()
        const r = item.getBoundingClientRect()
        const ghost = item.cloneNode(true) as HTMLElement
        ghost.removeAttribute(`data-${attr}`)
        ghost.classList.add('drag-ghost')
        ghost.setAttribute('aria-hidden', 'true')
        ghost.style.cssText += `left: ${r.left / z}px; top: ${r.top / z}px; width: ${r.width / z}px; height: ${r.height / z}px; ${GHOST_STYLE}`
        ;(document.querySelector('.app') ?? document.body).appendChild(ghost)
        item.setAttribute('data-lifted', '')
        lift.current = { ghost, item, x: e.clientX, y: e.clientY, z }
      }
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (dragging !== id) return
      const l = lift.current
      if (l) l.ghost.style.translate = `${(e.clientX - l.x) / l.z}px ${(e.clientY - l.y) / l.z}px`
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest(`[data-${attr}]`)
      const target = under?.getAttribute(`data-${attr}`) ?? null
      setOver(target === id ? null : target)
    },
    onPointerUp: () => {
      if (dragging === id && over) onDrop(id, over)
      reset()
    },
    onPointerCancel: reset,
    // Нажатие на ручку не должно открывать то, на чём она стоит.
    onClick: (e: PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => {
      e.preventDefault()
      e.stopPropagation()
    },
  })
  return { dragging, over, handle }
}
