import styles from './site.module.css'

// Подвал: один на публичные страницы и на витрину магазина —
// ссылки на оферту и жалобу должны быть доступны с любой страницы.
export function SiteFooter() {
  return (
    <footer className={styles.foot}>
      <div className={`wrap ${styles.footIn}`}>
        <span>© 2026 Katalog</span>
        <a href="/terms">Оферта</a>
        <a href="/content-policy">Политика контента</a>
        <a href="/privacy">Персональные данные</a>
        <a href="/abuse">Пожаловаться на контент</a>
      </div>
    </footer>
  )
}
