import { Golos_Text } from 'next/font/google'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/site/SiteFooter'
import { SiteHeader } from '@/components/site/SiteHeader'

// Фирменный шрифт только здесь. На витрине магазина он стоил ~59 КБ с высоким
// приоритетом и +400 мс к LCP — за бюджет 2.5s; там остаётся системный стек.
// Self-hosted через next/font: запроса к fonts.googleapis.com нет.
const golos = Golos_Text({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
})

// Общая обвязка публичных страниц: главная, тарифы, обновления,
// «убрать фон» и юридические страницы. Витрина магазина сюда не входит —
// у неё своя шапка (см. app/[slug]/layout.tsx).
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={golos.className}>
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
      <SiteFooter />
    </div>
  )
}
