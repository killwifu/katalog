import type { MetadataRoute } from 'next'

const SITE_URL = process.env.SITE_URL ?? 'http://localhost'

export default function robots(): MetadataRoute.Robots {
  return {
    // «/t» — бекон счётчика просмотров. Правила robots префиксные: голое
    // «/t» закрывало от поиска и все витрины на «t» (/tovary, /tufli…).
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/t$'] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
