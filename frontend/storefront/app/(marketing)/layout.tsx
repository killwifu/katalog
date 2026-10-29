import type { ReactNode } from 'react'
import { CookieBanner } from '@/components/site/CookieBanner'
import { SiteHeader } from '@/components/site/SiteHeader'
import s from '@/components/site/landing.module.css'

// Общая обвязка публичных страниц (макет 01): главная, тарифы, «убрать фон»
// и юридические страницы. Шрифт — Inter, как во всём макете (подключён в
// корневом layout). Витрина магазина сюда не входит — у неё своя шапка и
// подвал (см. app/[slug]/layout.tsx).
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={s.root}>
      {/* Маркер сессии — не httpOnly cookie, который сервер кладёт при входе
          и снимает при выходе. Читаем его синхронно, до отрисовки шапки:
          страница статическая и отдаётся из кеша всем одинаково, а решать
          «Войти или Кабинет» после гидратации значит мигать этой кнопкой. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "document.documentElement.dataset.auth=document.cookie.indexOf('katalog_signed=')>-1?'in':'out'",
        }}
      />
      <SiteHeader />
      {children}
      <footer className={s.foot}>
        <div className={s.in}>
          <div className={s.footTop}>
            <div>
              <a className={s.footLogo} href="/">
                вуад
              </a>
              <p>Фотокаталог для бизнеса</p>
            </div>
            <nav className={s.footNav}>
              <a href="/">Главная</a>
              <a href="/pricing">Тарифы</a>
              <a className="auth-out" href="/app/login">
                Войти
              </a>
              <a className="auth-in" href="/app/">
                Кабинет
              </a>
            </nav>
          </div>
          <div className={s.footBottom}>
            <span>© 2026 вуад</span>
            <nav className={s.footLegal}>
              <a href="/terms">Оферта</a>
              <a href="/privacy">Политика конфиденциальности</a>
            </nav>
          </div>
        </div>
      </footer>
      <CookieBanner />
    </div>
  )
}
