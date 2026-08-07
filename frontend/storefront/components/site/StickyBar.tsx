import styles from './site.module.css'

// Липкая полоса действия внизу экрана: только мобильный.
// Пустой .stickySpacer держит место, чтобы полоса не закрывала конец страницы.
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
    <>
      <div className={styles.stickySpacer} aria-hidden="true" />
      <div className={styles.sticky}>
        <div className={styles.stickyText}>
          <b>{title}</b>
          <span>{note}</span>
        </div>
        <a className="btn btn--primary btn--sm" href={href}>
          {action}
        </a>
      </div>
    </>
  )
}
