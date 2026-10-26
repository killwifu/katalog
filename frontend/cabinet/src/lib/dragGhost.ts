import type { DragEvent } from 'react'
import { pageZoom } from './zoom'

// Картинка перетаскивания по макету (11/13 · «Изменить порядок»): фото
// «поднято» — чуть больше (×1.08), повёрнуто на −3° и с тенью; на его месте
// остаётся пунктирное место (класс .is-dragging у исходной плитки).
export const GHOST_STYLE = 'transform: scale(1.08) rotate(-3deg); box-shadow: 0 12px 24px rgb(0 0 0 / 28%); border-radius: 10px; overflow: hidden;'

export function setLiftedDragImage(e: DragEvent<HTMLElement>) {
  const el = e.currentTarget
  const r = el.getBoundingClientRect()
  const z = pageZoom()
  // Браузер снимает картинку с элемента в DOM — обёртка с полями под тень
  // и поворот, вне экрана; убираем её сразу после снимка.
  const wrap = document.createElement('div')
  wrap.style.cssText = `position: fixed; top: -10000px; left: -10000px; padding: 24px; pointer-events: none;`
  const clone = el.cloneNode(true) as HTMLElement
  clone.classList.remove('is-dragging')
  clone.style.cssText += `width: ${r.width / z}px; height: ${r.height / z}px; margin: 0; ${GHOST_STYLE}`
  wrap.appendChild(clone)
  document.body.appendChild(wrap)
  e.dataTransfer.setDragImage(wrap, e.clientX - r.left + 24, e.clientY - r.top + 24)
  setTimeout(() => wrap.remove(), 0)
}
