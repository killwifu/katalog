import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/site/SiteFooter'

// У витрины магазина своя шапка (имя продавца, контакты, поиск) — маркетинговую
// сюда не ставим. Подвал общий: ссылки на оферту и жалобу должны быть
// доступны с любой публичной страницы.
export default function ShopLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <SiteFooter />
    </>
  )
}
