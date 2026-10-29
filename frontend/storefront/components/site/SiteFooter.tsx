import { ReportLink } from './ReportLink'
import styles from './site.module.css'

// Подвал витрины магазина: ссылки на оферту и жалобу должны быть доступны
// с любой страницы с контентом продавца. У лендинга подвал свой (макет 01).
export function SiteFooter() {
  return (
    <footer className={styles.foot}>
      <div className={`wrap ${styles.footIn}`}>
        <span>© 2026 вуад</span>
        <a href="/terms">Оферта</a>
        <a href="/content-policy">Политика контента</a>
        <a href="/privacy">Персональные данные</a>
        <ReportLink />
      </div>
    </footer>
  )
}
