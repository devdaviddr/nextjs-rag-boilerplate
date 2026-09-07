import postgres from 'postgres'

import { expect, test } from './fixtures'

// Chat-first UX and conversation history (spec 0026).
//
// The ingestion-dependent paths need a live inference endpoint, so those
// self-skip without a key — the same posture as rag.spec.ts.

const FIXTURES = 'tests/e2e/fixtures'
const INGEST_TIMEOUT = 120_000

async function register(page: import('@playwright/test').Page, tag: string) {
  const email = `chat-${tag}+${Date.now()}@example.com`
  await page.goto('/register')
  await page.getByLabel('Name').fill('Chat Tester')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByLabel('Confirm password').fill('Password123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chat/)
  return email
}

test('signing in lands on a centred empty chat, and there is no dashboard', async ({
  page,
}) => {
  await register(page, 'empty')

  // FR11: greeting + composer, no surrounding card.
  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await expect(page.getByLabel('Question')).toBeVisible()

  // FR6: the dashboard is gone, not redirected.
  const res = await page.request.get('/dashboard')
  expect(res.status()).toBe(404)
})

test("another user's conversation cannot be opened by id", async ({
  browser,
}) => {
  test.skip(!process.env.DATABASE_URL, 'DATABASE_URL is required')
  test.slow()

  // User A creates a conversation directly in the database, so this test does
  // not depend on an inference endpoint.
  const contextA = await browser.newContext()
  const pageA = await contextA.newPage()
  const emailA = await register(pageA, 'owner')

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  let conversationId: string
  try {
    const [row] = await sql`
      INSERT INTO conversations (id, owner_id, title)
      VALUES (gen_random_uuid()::text,
              (SELECT id FROM users WHERE email = ${emailA}),
              'A private conversation')
      RETURNING id`
    conversationId = row!.id as string
  } finally {
    await sql.end()
  }

  // The owner can open it.
  await pageA.goto(`/chat/${conversationId}`)
  // The sidebar is rendered twice (desktop aside + mobile drawer), so scope
  // to the visible desktop one rather than matching both.
  await expect(
    pageA.getByRole('link', { name: 'A private conversation' }).first(),
  ).toBeVisible()
  await contextA.close()

  // A different user gets the same 404 as for a conversation that never
  // existed — no existence signal (spec 0026 NFR1).
  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await register(pageB, 'intruder')
  const res = await pageB.request.get(`/chat/${conversationId}`)
  expect(res.status()).toBe(404)
  await contextB.close()
})

test.describe('with an indexed document', () => {
  test.slow()
  test.beforeEach(() => {
    test.skip(
      !process.env.NVIDIA_API_KEY,
      'NVIDIA_API_KEY is not set — chat end-to-end tests skipped',
    )
  })

  test('a conversation persists, appears in Recents, and survives a reload', async ({
    page,
  }) => {
    await register(page, 'persist')

    await page.goto('/documents')
    await page
      .getByLabel('Upload a PDF')
      .setInputFiles(`${FIXTURES}/handbook.pdf`)
    await expect(
      page.getByRole('row', { name: /handbook/i }).getByText('Ready'),
    ).toBeVisible({ timeout: INGEST_TIMEOUT })

    await page.goto('/chat')
    await page
      .getByLabel('Question')
      .fill('How many days of annual leave do I get?')
    await page.getByRole('button', { name: 'Send' }).click()

    // FR10: Markdown, not literal asterisks.
    await expect(page.getByText(/20 working days/i)).toBeVisible({
      timeout: 90_000,
    })
    await expect(page.getByText('**')).toHaveCount(0)

    // FR4: the URL adopts the new conversation without a navigation.
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/)

    // FR7: it appears in Recents, titled from the question.
    await expect(
      page
        .getByRole('link', { name: /How many days of annual leave/i })
        .first(),
    ).toBeVisible()
    await expect(page.getByText('Today').first()).toBeVisible()

    // FR12: reloading shows the same messages AND the same citations.
    await page.reload()
    await expect(page.getByText(/20 working days/i)).toBeVisible()
    await expect(page.getByText('Sources')).toBeVisible()
    const chip = page.locator('button', { hasText: /^\[1\]/ }).first()
    await expect(chip).toBeVisible()

    // FR14: the citation opens the source panel at the cited page.
    await chip.click()
    const frame = page.locator('iframe')
    await expect(frame).toHaveCount(1)
    expect(await frame.getAttribute('src')).toMatch(
      /\/api\/documents\/[0-9a-f-]{36}\/source#page=\d+/,
    )
    // The panel must have real size — it once collapsed to zero height.
    const box = await frame.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(200)
    expect(box?.height ?? 0).toBeGreaterThan(200)

    // Escape closes it.
    await page.keyboard.press('Escape')
    await expect(page.locator('iframe')).toHaveCount(0)
  })

  test('the source route is framable by this app but not by others', async ({
    page,
  }) => {
    await register(page, 'headers')
    await page.goto('/documents')
    await page
      .getByLabel('Upload a PDF')
      .setInputFiles(`${FIXTURES}/handbook.pdf`)
    await expect(
      page.getByRole('row', { name: /handbook/i }).getByText('Ready'),
    ).toBeVisible({ timeout: INGEST_TIMEOUT })

    const res = await page.request.post('/api/chat', {
      data: { question: 'annual leave' },
    })
    const citationLine = (await res.text())
      .split('\n')
      .find((l) => l.includes('"citations"'))
    const documentId = JSON.parse(citationLine!).citations[0].documentId

    const source = await page.request.get(`/api/documents/${documentId}/source`)
    expect(source.status()).toBe(200)
    const headers = source.headers()
    expect(headers['content-type']).toBe('application/pdf')
    expect(headers['content-disposition']).toBe('inline')
    expect(headers['x-content-type-options']).toBe('nosniff')
    // A global DENY would break same-origin framing; this route narrows it.
    expect(headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(headers['content-security-policy']).toContain(
      "frame-ancestors 'self'",
    )

    // Ordinary pages must still refuse framing outright.
    const pageHeaders = (await page.request.get('/chat')).headers()
    expect(pageHeaders['x-frame-options']).toBe('DENY')
  })
})
