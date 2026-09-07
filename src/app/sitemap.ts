import type { MetadataRoute } from 'next'

import { env } from '@/lib/env'

// Serves /sitemap.xml. Lists only publicly-reachable routes — authenticated
// app pages (chat/documents/settings) are intentionally excluded. Add per-fork
// public routes here as they are built.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.APP_URL
  return [
    { url: `${base}/`, changeFrequency: 'monthly', priority: 1 },
    { url: `${base}/login`, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${base}/register`, changeFrequency: 'yearly', priority: 0.5 },
  ]
}
