// Generates the default social share (OpenGraph / Twitter) image.
// Re-run after dropping in real branding:  pnpm gen:og
// Output is a committed asset (public/og.png) — like the icons, it is not
// regenerated in CI, so relying on local system fonts for the text is fine.
// To rebrand a fork without touching code, just replace public/og.png with a
// 1200x630 image of the same name.
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const W = 1200
const H = 630
const THEME = '#0f172a' // slate-900 (matches the app's dark background)
const FG = '#ffffff'
const MUTED = '#94a3b8' // slate-400
const ACCENT = '#38bdf8' // sky-400
const root = fileURLToPath(new URL('..', import.meta.url))

// The title is the app's name from src/lib/brand.ts (#139), so a rename there
// reaches the share image on the next `pnpm gen:og`. Read as text because
// this script runs under plain Node and cannot import TypeScript.
const brand = readFileSync(join(root, 'src/lib/brand.ts'), 'utf8')
const TITLE = brand.match(/export const APP_NAME = '([^']+)'/)?.[1]
if (!TITLE) throw new Error('APP_NAME not found in src/lib/brand.ts')
const SUBTITLE = 'Grounded document chat · Next.js · pgvector'

// The same 2x2 "app grid" mark used by the icons, scaled up.
const mark = `
<g transform="translate(96, 96) scale(1.6)" fill="${FG}">
  <rect x="0" y="0" width="40" height="40" rx="9"/>
  <rect x="56" y="0" width="40" height="40" rx="9"/>
  <rect x="0" y="56" width="40" height="40" rx="9"/>
  <rect x="56" y="56" width="40" height="40" rx="9"/>
</g>`

const svg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${THEME}"/>
  <rect x="0" y="${H - 12}" width="${W}" height="12" fill="${ACCENT}"/>
  ${mark}
  <text x="96" y="380" fill="${FG}" font-family="Helvetica, Arial, sans-serif" font-size="76" font-weight="700">${TITLE}</text>
  <text x="96" y="452" fill="${MUTED}" font-family="Helvetica, Arial, sans-serif" font-size="36" font-weight="400">${SUBTITLE}</text>
</svg>`,
)

const out = join(root, 'public/og.png')
await mkdir(dirname(out), { recursive: true })
await sharp(svg).png().toFile(out)
console.log('✓ public/og.png (1200x630)')
console.log(
  'The title is APP_NAME from src/lib/brand.ts; to use your own image instead, replace public/og.png.',
)
