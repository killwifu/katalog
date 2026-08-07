import { SiteFooter } from '@/components/site/SiteFooter'
import { SiteHeader } from '@/components/site/SiteHeader'

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="page">
        <h1>Страница не найдена</h1>
        <p className="empty">Магазин или альбом не существует либо был скрыт продавцом.</p>
        <p className="center">
          <a className="btn btn--ghost" href="/">
            На главную
          </a>
        </p>
      </main>
      <SiteFooter />
    </>
  )
}
