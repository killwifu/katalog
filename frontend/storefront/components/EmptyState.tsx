import { Image as ImageIcon, Inbox, Search } from 'lucide-react'
import type { ReactNode } from 'react'

const ICONS = { inbox: Inbox, image: ImageIcon, search: Search }

// Заглушка витрины (макет 15): значок в круге, заголовок, текст и кнопки —
// пустая витрина, пустая категория, поиск без результатов, альбом недоступен.
export function EmptyState({
  icon,
  title,
  text,
  children,
}: {
  icon: keyof typeof ICONS
  title: string
  text?: string
  children?: ReactNode
}) {
  const Icon = ICONS[icon]
  return (
    <div className="sfempty">
      <span className="sfempty__ico" aria-hidden="true">
        <Icon size={24} strokeWidth={1.6} />
      </span>
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {children && <div className="sfempty__actions">{children}</div>}
    </div>
  )
}
