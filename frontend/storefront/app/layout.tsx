import type { Metadata } from 'next'
import { Golos_Text } from 'next/font/google'
import type { ReactNode } from 'react'
import './globals.css'

const SITE_URL = process.env.SITE_URL ?? 'http://localhost'

// Шрифт self-hosted через next/font: без запроса к fonts.googleapis.com
// на горячем пути покупателя и без скачка вёрстки при подмене шрифта.
const golos = Golos_Text({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-golos',
})

export const metadata: Metadata = {
  title: 'Katalog',
  description: 'Фото-каталоги для малого бизнеса',
  // Абсолютные URL для OpenGraph-картинок (/media/... -> {SITE_URL}/media/...).
  metadataBase: new URL(SITE_URL),
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={golos.variable}>
      <body>{children}</body>
    </html>
  )
}
