import type { MetadataRoute } from 'next'

import { env } from '@/lib/env'

// Serves /robots.txt. Public marketing/auth pages are crawlable; API and
// authenticated app surfaces are not (they redirect to login anyway, but this
// keeps them out of the index explicitly). The sitemap points at the same
// configured origin.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/chat', '/documents', '/settings'],
    },
    sitemap: `${env.APP_URL}/sitemap.xml`,
  }
}
