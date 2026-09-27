import type { MetadataRoute } from 'next'
import { APP_DESCRIPTION, APP_NAME, APP_SHORT_NAME } from '@/lib/brand'
import { env } from '@/lib/env'

// Read per request, not at build: PWA_ENABLED is a runtime setting, and the
// published image is built once for every deployment (#140).
export const dynamic = 'force-dynamic'

// Served at /manifest.webmanifest and auto-linked by Next.js. Edit name/colors
// and re-run `pnpm gen:icons` after swapping in real branding.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_SHORT_NAME,
    description: APP_DESCRIPTION,
    id: '/',
    start_url: '/',
    scope: '/',
    // `browser` makes the app not installable when the PWA is switched off.
    display: env.PWA_ENABLED ? 'standalone' : 'browser',
    orientation: 'portrait-primary',
    background_color: '#ffffff',
    theme_color: '#0f172a',
    categories: ['productivity', 'developer'],
    shortcuts: [
      {
        name: 'New chat',
        short_name: 'New chat',
        url: '/chat',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ],
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
