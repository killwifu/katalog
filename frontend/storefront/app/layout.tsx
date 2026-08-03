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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        {children}
        <footer className="site-footer">
          <nav>
            <a href="/terms">Оферта</a>
            <a href="/content-policy">Политика контента</a>
            <a href="/privacy">Персональные данные</a>
            <a href="/abuse">Пожаловаться на контент</a>
          </nav>
        </footer>
      </body>
    </html>
  )
}
