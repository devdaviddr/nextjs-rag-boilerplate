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

/** Create a knowledge base from `/documents` and return its id (spec 0028 —
 * a document is always uploaded into a specific KB, never a flat pool). */
async function createKnowledgeBase(
  page: import('@playwright/test').Page,
  name: string,
): Promise<string> {
  await page.goto('/documents')
  await page.getByRole('button', { name: 'New knowledge base' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const link = page.getByRole('link', { name })
  await expect(link).toBeVisible()
  const href = await link.getAttribute('href')
  const kbId = href?.split('/').pop()
  if (!kbId) {
    throw new Error(`Could not read the id for "${name}" from its link.`)
  }
  return kbId
}

test('signing in lands on the chat, and there is no dashboard', async ({
  page,
}) => {
  // Deliberately not asserting the greeting here: without an inference key the
  // chat renders its "not configured" state by design, and CI has no key.
  await register(page, 'empty')

  // FR6: the dashboard is gone, not redirected.
  const res = await page.request.get('/dashboard')
  expect(res.status()).toBe(404)
})

test('an empty chat is a centred greeting and composer', async ({ page }) => {
  test.skip(
    !process.env.NVIDIA_API_KEY,
    'NVIDIA_API_KEY is not set — the chat renders its unconfigured state',
  )
  await register(page, 'greeting')

  // FR11: greeting + composer, no surrounding card.
  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await expect(page.getByLabel('Question')).toBeVisible()
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

    const kbId = await createKnowledgeBase(page, 'My documents')
    await page.goto(`/documents/${kbId}`)
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
    const kbId = await createKnowledgeBase(page, 'My documents')
    await page.goto(`/documents/${kbId}`)
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

/**
 * Two questions back to back in a new thread.
 *
 * The first message in a NEW thread adopts its URL with `history.replaceState`
 * and ends with `router.refresh()` so Recents updates. That refresh re-fetches
 * props for the newly adopted URL, so `initialConversationId` arrives as the
 * new id — which does not match the `undefined` this view mounted with, which
 * would fire the "router swapped threads" re-sync and wipe local state. The
 * view therefore advances its own baseline when it adopts a thread.
 *
 * HONEST LIMITATION: this test passes both with and without that guard, so it
 * does not prove the guard is load-bearing. A dropped-second-message race was
 * reported here and could not be reproduced locally — it may need timing this
 * suite does not produce. The guard is kept because the re-sync firing on a
 * conversation this view adopted itself is wrong on its own terms, and this
 * test at least pins the back-to-back path against future regressions.
 */
test('a second question sent immediately is not swallowed by the post-answer refresh', async ({
  page,
}) => {
  test.skip(!process.env.NVIDIA_API_KEY, 'NVIDIA_API_KEY is not set')
  await register(page, 'refresh-race')
  // No knowledge base, so both questions take the instant refusal path with no
  // model streaming — which is the tightest version of the race.
  await createKnowledgeBase(page, 'Race KB')
  await page.goto('/chat')

  await page.getByRole('textbox', { name: 'Question' }).fill('first question')
  await page.getByRole('textbox', { name: 'Question' }).press('Enter')
  await expect(page.getByText('first question')).toBeVisible()
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 60_000 })
  // Wait only for the first answer to finish — NOT for the refresh it triggers
  // to settle. That gap is the race; waiting it out is what hid the bug.
  await expect(page.getByRole('textbox', { name: 'Question' })).toBeEnabled({
    timeout: 60_000,
  })

  await page.getByRole('textbox', { name: 'Question' }).fill('second question')
  await page.getByRole('textbox', { name: 'Question' }).press('Enter')

  await expect(page.getByText('second question')).toBeVisible({
    timeout: 60_000,
  })
  // The composer must come back; a durably disabled Send was the symptom.
  await expect(page.getByRole('textbox', { name: 'Question' })).toBeEnabled({
    timeout: 60_000,
  })
})
