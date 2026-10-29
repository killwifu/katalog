'use client'

import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

// Всплывающий список витрины (макет 15): на десктопе и планшете — панель
// под кнопкой, на телефоне — нижняя шторка с затемнением (раскладка в CSS:
// .sfpop). Закрывается крестиком, Esc, нажатием мимо и свайпом шторки вниз.
// root — обёртка с кнопкой: нажатие по ней не считается «мимо».
export function Popup({
  title,
  onClose,
  root,
  className = '',
  children,
}: {
  title: string
  onClose: () => void
  root: RefObject<HTMLElement>
  className?: string
  children: ReactNode
}) {
  const startY = useRef<number | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [onClose, root])

  return (
    <>
      <div className="sfpop__shade" onClick={onClose} />
      <div
        className={`sfpop ${className}`}
        role="dialog"
        aria-label={title}
        onTouchStart={(e) => {
          startY.current = e.currentTarget.scrollTop === 0 ? e.touches[0].clientY : null
        }}
        onTouchEnd={(e) => {
          if (startY.current !== null && e.changedTouches[0].clientY - startY.current > 80) onClose()
          startY.current = null
        }}
      >
        <div className="sfpop__head">
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label="Закрыть">
            <X size={18} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </>
  )
}
