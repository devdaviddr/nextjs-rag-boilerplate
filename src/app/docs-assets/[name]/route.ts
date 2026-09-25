import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getCurrentSession } from '@/lib/auth/session'

/**
 * Images referenced by the docs (`docs/images/*`), served to the in-app Docs
 * section (spec 0041 FR3). Signed-in only — checked HERE, because the proxy's
 * matcher skips paths with a file extension, so `/docs-assets/x.png` never
 * reaches its protected-prefix check.
 *
 * Raster formats only, and a strict name pattern: no path traversal, and no
 * SVG, which can carry script.
 */
const IMAGES_DIR = join(
  /* turbopackIgnore: true */ process.cwd(),
  'docs',
  'images',
)
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await getCurrentSession()
  if (!session?.user) return new Response('Unauthorized', { status: 401 })
  const { name } = await params
  const m = /^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|gif|webp)$/i.exec(name)
  const type = m?.[1] ? TYPES[m[1].toLowerCase()] : undefined
  if (!type) return new Response('Not found', { status: 404 })
  try {
    const bytes = await readFile(join(IMAGES_DIR, name))
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': type,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
