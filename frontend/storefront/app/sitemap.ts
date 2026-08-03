import type { MetadataRoute } from 'next'
import { getSitemapShops } from '@/lib/api'

const SITE_URL = process.env.SITE_URL ?? 'http://localhost'

// Рендер на запрос (на этапе next build API недоступен);
// данные кешируются fetch-кешем на час.
export const dynamic = 'force-dynamic'

// Sitemap по активным магазинам (скрытые альбомы в выдачу API не попадают).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const shops = await getSitemapShops()
  return shops.map((s) => ({
    url: `${SITE_URL}/${encodeURIComponent(s.slug)}`,
    lastModified: new Date(s.updated_at),
    changeFrequency: 'daily',
  }))
}
