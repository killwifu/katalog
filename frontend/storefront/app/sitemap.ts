import type { MetadataRoute } from 'next'
import { getSitemapShops } from '@/lib/api'

const SITE_URL = process.env.SITE_URL ?? 'http://localhost'

// Рендер на запрос (на этапе next build API недоступен);
// данные кешируются fetch-кешем на час.
export const dynamic = 'force-dynamic'

// Публичные страницы сервиса — их адреса статичны.
const PUBLIC_PAGES = ['', '/pricing', '/updates', '/remove-bg']

// Sitemap: публичные страницы + активные магазины
// (скрытые альбомы в выдачу API не попадают).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const shops = await getSitemapShops()
  return [
    ...PUBLIC_PAGES.map((path) => ({
      url: `${SITE_URL}${path}`,
      changeFrequency: 'weekly' as const,
    })),
    ...shops.map((s) => ({
      url: `${SITE_URL}/${encodeURIComponent(s.slug)}`,
      lastModified: new Date(s.updated_at),
      changeFrequency: 'daily' as const,
    })),
  ]
}
