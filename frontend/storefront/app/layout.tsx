import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

const SITE_URL = process.env.SITE_URL ?? 'http://localhost'

export const metadata: Metadata = {
  title: 'Katalog',
  description: 'Фото-каталоги для малого бизнеса',
  // Абсолютные URL для OpenGraph-картинок (/media/... -> {SITE_URL}/media/...).
  metadataBase: new URL(SITE_URL),
}

// Шрифт здесь не подключается: витрина магазина (95% трафика) живёт на
// системном стеке ради бюджета LCP. Фирменный Golos Text — только на
// публичных страницах, см. app/(marketing)/layout.tsx.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
