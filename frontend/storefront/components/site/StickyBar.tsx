import styles from './site.module.css'

// Липкая полоса действия внизу экрана: только мобильный.
// Глобальный класс stickybar — зацепка для правила body:has(.stickybar)
// в globals.css, которое добавляет отступ под полосой. Распоркой рядом
// с полосой это не решается: подвал рендерит layout уже после страницы.
export function StickyBar({
  title,
  note,
  action,
  href,
}: {
  title: string
  note: string
  action: string
  href: string
}) {
  return (
    <div className={`stickybar ${styles.sticky}`}>
      <div className={styles.stickyText}>
        <b>{title}</b>
        <span>{note}</span>
      </div>
      <a className="btn btn--primary btn--sm" href={href}>
        {action}
      </a>
    </div>
  )
}
