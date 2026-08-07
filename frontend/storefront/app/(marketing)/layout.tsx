import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/site/SiteFooter'
import { SiteHeader } from '@/components/site/SiteHeader'

// Общая обвязка публичных страниц: главная, тарифы, обновления,
// «убрать фон» и юридические страницы. Витрина магазина сюда не входит —
// у неё своя шапка (см. app/[slug]/layout.tsx).
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  )
}
