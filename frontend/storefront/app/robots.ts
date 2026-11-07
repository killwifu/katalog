import type { MetadataRoute } from 'next'

const SITE_URL = process.env.SITE_URL ?? 'http://localhost'

// Без этого robots.txt пререндерится при сборке образа, где SITE_URL ещё
// нет, — на проде в нём оставался http://localhost/sitemap.xml.
export const dynamic = 'force-dynamic'

export default function robots(): MetadataRoute.Robots {
  return {
    // «/t» — бекон счётчика просмотров. Правила robots префиксные: голое
    // «/t» закрывало от поиска и все витрины на «t» (/tovary, /tufli…).
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/t$'] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
