'use client'

import { CircleAlert, Ellipsis } from 'lucide-react'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { ComplaintDialogProps, ComplaintTarget } from './ComplaintDialog'
import { useToast } from './Toast'

const ITEM: Record<ComplaintTarget['kind'], string> = {
  shop: 'Пожаловаться на витрину',
  album: 'Пожаловаться на альбом',
  photo: 'Пожаловаться на фото',
}

// Меню «⋯» витрины, альбома и фото (макет 15 · «Жалоба»): один пункт —
// жалоба. Закрывается нажатием мимо и Esc. Окно жалобы грузится отдельным
// чанком по клику: покупатели жалуются редко, а бюджет JS страницы общий.
// onSent — свой показ уведомления (в просмотре фото оно светлое).
export function MoreMenu({
  target,
  className = '',
  onSent,
}: {
  target: ComplaintTarget
  className?: string
  onSent?: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [Dialog, setDialog] = useState<ComponentType<ComplaintDialogProps> | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const [toast, show] = useToast()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
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

  const report = async () => {
    setOpen(false)
    try {
      const m = await import('./ComplaintDialog')
      setDialog(() => m.ComplaintDialog)
    } catch {
      ;(onSent ?? show)('Не удалось открыть жалобу. Проверьте интернет и попробуйте ещё раз')
    }
  }

  return (
    <div ref={root} className={`sfmore ${className}`}>
      <button
        type="button"
        className="sfmore__btn"
        aria-label="Ещё"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div className="sfmore__menu" role="menu">
          <button type="button" role="menuitem" onClick={() => void report()}>
            <CircleAlert size={20} strokeWidth={1.6} aria-hidden="true" />
            {ITEM[target.kind]}
          </button>
        </div>
      )}
      {Dialog && (
        <Dialog
          target={target}
          onClose={() => {
            setDialog(null)
            root.current?.querySelector<HTMLButtonElement>('.sfmore__btn')?.focus()
          }}
          onSent={() => {
            setDialog(null)
            root.current?.querySelector<HTMLButtonElement>('.sfmore__btn')?.focus()
            ;(onSent ?? show)('Жалоба отправлена. Спасибо, мы её проверим')
          }}
        />
      )}
      {toast}
    </div>
  )
}
