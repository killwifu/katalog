import { Trash2, TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { Icon } from '../lib/icons'
import { Portal } from '../lib/Portal'

// Подтверждение поверх другого окна (макеты 11–12 · «Удалить все фото»).
// Esc закрывает только его: ловим на погружении и помечаем событие, чтобы
// окно под ним (useDialogClose) его пропустило.
export function ConfirmDialog({
  title,
  text,
  confirmLabel,
  cancelLabel = 'Отмена',
  icon,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string
  text: string
  confirmLabel: string
  cancelLabel?: string
  // Значок над заголовком (макет 10 · «Удалить N альбомов?»): корзина —
  // у удаления, треугольник — у «Закрыть без сохранения?».
  icon?: 'trash' | 'warn'
  // Необратимое действие (макет 20 · «Удалить навсегда»): красная кнопка и значок.
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCancel()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    <Portal><div
      className="modal__back modal__back--top"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal modal--sm">
        {icon && (
          <span className={`confirm__ico${danger ? ' confirm__ico--danger' : ''}`} aria-hidden="true">
            <Icon as={icon === 'trash' ? Trash2 : TriangleAlert} size={22} />
          </span>
        )}
        <div className="modal__head">
          <h2>{title}</h2>
        </div>
        <p className="modal__text">{text}</p>
        <div className="modal__foot">
          <span className="spacer" />
          <button className="btn btn--ghost" onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div></Portal>
  )
}
