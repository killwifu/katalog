import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { Icon, SpinnerIcon } from '../lib/icons'

// Уведомление поверх страницы (макет 10 · toast): тёмная плашка, слева
// иконка — успех (circle-check), ошибка (circle-alert) или крутилка,
// справа кнопки-таблетки и крестик.
export function Toast({
  text,
  spin,
  actions = [],
  onClose,
}: {
  text: string
  spin?: boolean
  actions?: { label: string; run: () => void }[]
  onClose: () => void
}) {
  // Ошибки у нас всегда начинаются одинаково — по этому и выбираем иконку,
  // а не заводим флаг в каждом из десятков вызовов.
  const failed = /^(Не удалось|Ошибка|Вернулось)/.test(text)
  return (
    <div className="toast" role={failed ? 'alert' : 'status'}>
      {spin ? (
        <SpinnerIcon />
      ) : (
        <Icon as={failed ? CircleAlert : CircleCheck} size={20} className={failed ? 'toast__ico--err' : 'toast__ico'} />
      )}
      <span className="toast__text">{text}</span>
      {actions.map((a) => (
        <button key={a.label} className="toast__act" onClick={a.run}>
          {a.label}
        </button>
      ))}
      <button className="toast__close" onClick={onClose} aria-label="Закрыть">
        <Icon as={X} />
      </button>
    </div>
  )
}
