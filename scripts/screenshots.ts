import { config } from 'dotenv'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { hash } from '@node-rs/argon2'
import { chromium, type Page } from '@playwright/test'
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { conversations, roles, userRoles, users } from '../src/db/schema'

/**
 * The README screenshots (#175), in dark mode.
 *
 *   pnpm build
 *   RAG_CRACK_ENABLED=true PORT=3100 APP_URL=http://localhost:3100 \
 *     AUTH_URL=http://localhost:3100 LLM_API_KEY=<your key> pnpm start
 *   pnpm gen:screenshots --pdf path/to/document.pdf
 *
 * Against a local production build (no dev overlay), with cracking on so the
 * inspector shows pages read by the parsing model. It uses its own admin
 * account, so the sidebar holds only what the shots need, and never touches
 * anyone else's data. Idempotent: the account, knowledge base and document
 * are created once and reused. Each shot is framed (backdrop, rounded window,
 * shadow) and written to docs/images/ as WebP.
 *
 * Local development only: it writes to the database named in .env.
 */

config({ path: '.env' })

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const BASE = arg('base') ?? 'http://localhost:3100'
const PDF = arg('pdf')
const QUESTION =
  arg('question') ??
  'Which Azure regions in Australia support fine-tuning, and what models?'
const KB_NAME = arg('kb') ?? 'Azure AI Foundry'
const OUT = resolve('docs/images')
const ACCOUNT = {
  name: 'Alex Morgan',
  email: 'screenshots@example.com',
  password: 'Screenshots123',
}
const VIEWPORT = { width: 1440, height: 900 }

/** The screenshot account, an admin so Observability is visible. */
async function ensureAccount(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const client = postgres(url, { max: 1 })
  const db = drizzle(client, {
    schema: { users, roles, userRoles, conversations },
  })
  const hashedPassword = await hash(ACCOUNT.password, {
    memoryCost: 19_456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  })
  let user = await db.query.users.findFirst({
    where: eq(users.email, ACCOUNT.email),
  })
  if (user) {
    await db
      .update(users)
      .set({ hashedPassword, emailVerified: new Date() })
      .where(eq(users.id, user.id))
  } else {
    const [created] = await db
      .insert(users)
      .values({
        name: ACCOUNT.name,
        email: ACCOUNT.email,
        emailVerified: new Date(),
        hashedPassword,
      })
      .returning()
    user = created!
    console.log(`Created ${ACCOUNT.email}`)
  }
  const admin = await db.query.roles.findFirst({
    where: eq(roles.name, 'admin'),
  })
  if (!admin) throw new Error('No admin role: run pnpm db:seed first')
  await db
    .insert(userRoles)
    .values({ userId: user.id, roleId: admin.id })
    .onConflictDoNothing()
  // A fresh sidebar: only this account's own chats are cleared.
  await db.delete(conversations).where(eq(conversations.ownerId, user.id))
  await client.end()
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Email').fill(ACCOUNT.email)
  await page.getByLabel('Password', { exact: true }).fill(ACCOUNT.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/chat/)
}

/** The knowledge base and its document, uploaded once; returns the page URL. */
async function ensureDocument(page: Page): Promise<string> {
  await page.goto(`${BASE}/documents`)
  const kbLink = page.getByRole('link', { name: KB_NAME, exact: true })
  if (!(await kbLink.count())) {
    await page.getByRole('button', { name: 'New knowledge base' }).click()
    await page.getByLabel('Name').fill(KB_NAME)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
  }
  await kbLink.first().click()
  await page.waitForURL(/\/documents\/[^/]+$/)
  const kbUrl = page.url()
  if (!(await page.getByRole('row').nth(1).count())) {
    if (!PDF) throw new Error('No document yet: pass --pdf <file>')
    await page.getByLabel('Upload a document').setInputFiles(PDF)
    console.log(
      'Uploaded; waiting for it to be indexed (cracking takes a while)…',
    )
  }
  const row = page.getByRole('row').nth(1)
  await row.getByText('Ready').waitFor({ timeout: 15 * 60_000 })
  await row.getByRole('link').first().click()
  await page.waitForURL(/\/documents\/[^/]+\/[^/]+$/)
  const docUrl = page.url()
  await page.goto(kbUrl)
  return docUrl
}

/** Ask the question in a new chat and wait for the verified answer. */
async function ask(page: Page): Promise<void> {
  await page.goto(`${BASE}/chat`)
  await page.getByLabel('Question').fill(QUESTION)
  await page.getByRole('button', { name: 'Send' }).click()
  // The metrics line appears once the answer is written; then the citation
  // check finishes, the activity drawer settles and Recents lists the chat.
  await page
    .getByText(/ total ·/)
    .last()
    .waitFor({ timeout: 180_000 })
  await page
    .getByText('Checking sources')
    .waitFor({ state: 'detached', timeout: 60_000 })
  await page
    .getByRole('button', { name: /Agent activity · \d+ steps?/ })
    .last()
    .waitFor({ timeout: 60_000 })
  await page
    .getByRole('link', { name: QUESTION.slice(0, 20) })
    .first()
    .waitFor({ timeout: 60_000 })
  await page.waitForTimeout(1500)
}

async function shot(page: Page): Promise<Buffer> {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(600)
  return page.screenshot({ type: 'png' })
}

/** The screenshot in a window on a dark backdrop, as the README shows it. */
async function frame(page: Page, png: Buffer, name: string): Promise<void> {
  const src = `data:image/png;base64,${png.toString('base64')}`
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;background:transparent}
    .stage{display:inline-block;padding:56px 64px;
      background:radial-gradient(120% 90% at 15% 0%,#23324a 0%,#121926 45%,#0a0e15 100%)}
    .win{width:1440px;border-radius:14px;overflow:hidden;
      box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}
    .bar{height:34px;background:#1b212b;display:flex;align-items:center;gap:8px;padding:0 14px;
      border-bottom:1px solid rgba(255,255,255,.06)}
    .bar i{width:11px;height:11px;border-radius:50%;background:#3a4250}
    .bar span{margin-left:12px;font:12px ui-sans-serif,system-ui;color:#8b95a5}
    img{display:block;width:1440px}
  </style></head><body><div class="stage" id="s"><div class="win">
    <div class="bar"><i></i><i></i><i></i><span>localhost</span></div>
    <img src="${src}"></div></div></body></html>`)
  await page.waitForLoadState('load')
  const raw = await page.locator('#s').screenshot({ type: 'png' })
  const file = join(OUT, `${name}.webp`)
  await sharp(raw).resize({ width: 2000 }).webp({ quality: 88 }).toFile(file)
  console.log(`Wrote ${file}`)
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await ensureAccount()
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  await context.addInitScript(() => {
    try {
      localStorage.setItem('theme', 'dark')
    } catch {
      // Storage blocked: the dark colour scheme still applies.
    }
  })
  const page = await context.newPage()
  await signIn(page)
  const docUrl = await ensureDocument(page)

  const shots: Array<[string, Buffer]> = []

  // 1. The answer, with its cited page open beside it.
  await ask(page)
  await page
    .getByRole('button', { name: / — (p|§)\d+/ })
    .first()
    .click()
  await page.getByRole('complementary').first().waitFor()
  await page.waitForTimeout(2500)
  shots.push(['answer', await shot(page)])

  // 2. The Agent activity drawer under the same answer.
  await page.keyboard.press('Escape')
  await page
    .getByRole('button', { name: /Agent activity/ })
    .last()
    .click()
  await page.getByRole('region', { name: 'Agent activity' }).waitFor()
  await page.waitForTimeout(1500)
  await page
    .getByRole('region', { name: 'Agent activity' })
    .scrollIntoViewIfNeeded()
  shots.push(['agent-activity', await shot(page)])

  // 3. What cracking read from each page.
  await page.goto(docUrl)
  await page.waitForLoadState('networkidle')
  shots.push(['cracking', await shot(page)])

  // 4. Observability.
  await page.goto(`${BASE}/observability`)
  await page.waitForLoadState('networkidle')
  shots.push(['observability', await shot(page)])

  // 5. The in-app docs.
  await page.goto(`${BASE}/docs`)
  await page.waitForLoadState('networkidle')
  shots.push(['docs', await shot(page)])

  const framer = await (
    await browser.newContext({ deviceScaleFactor: 2 })
  ).newPage()
  for (const [name, png] of shots) await frame(framer, png, name)
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
