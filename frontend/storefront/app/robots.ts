import type { MetadataRoute } from 'next'

const SITE_URL = process.env.SITE_URL ?? 'http://localhost'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/t'] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
