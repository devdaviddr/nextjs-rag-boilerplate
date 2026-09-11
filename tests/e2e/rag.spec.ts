import postgres from 'postgres'

import { expect, test } from './fixtures'

// RAG knowledge base + document chat (spec 0025), end to end through the UI.
//
// Ingestion is out-of-band and calls a rate-limited inference endpoint, so
// these are deliberately generous on timeouts rather than flaky-fast.

// RAG needs a live inference endpoint. Without a key the feature reports
// itself as unconfigured by design, so these self-skip rather than fail —
// the same posture as the push and OAuth suites. CI passes the secret through
// when one is configured; with none set, this whole file skips.
test.beforeEach(() => {
  test.skip(
    !process.env.NVIDIA_API_KEY,
    'NVIDIA_API_KEY is not set — RAG end-to-end tests skipped',
  )
})

const FIXTURES = 'tests/e2e/fixtures'
const INGEST_TIMEOUT = 120_000

async function register(page: import('@playwright/test').Page, tag: string) {
  const email = `rag-${tag}+${Date.now()}@example.com`
  await page.goto('/register')
  await page.getByLabel('Name').fill('RAG Tester')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByLabel('Confirm password').fill('Password123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chat/)
  return email
}

/** Create a knowledge base from `/documents` and return its id (spec 0028 —
 * a document is always uploaded into a specific KB, never a flat pool, so
 * every ingestion in this file needs one to upload into first). */
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

test.describe('knowledge base', () => {
  test.slow()

  test('a text PDF ingests to ready, answers a question with a citation, and deletes cleanly', async ({
    page,
  }) => {
    await register(page, 'happy')

    const kbId = await createKnowledgeBase(page, 'My documents')
    await page.goto(`/documents/${kbId}`)
    await expect(
      page.getByText('No documents yet. Upload a PDF to get started.'),
    ).toBeVisible()

    await page
      .getByLabel('Upload a PDF')
      .setInputFiles(`${FIXTURES}/handbook.pdf`)

    const row = page.getByRole('row', { name: /handbook/i })
    await expect(row).toBeVisible()

    // FR4: the status machine runs to completion without intervention.
    await expect(row.getByText('Ready')).toBeVisible({
      timeout: INGEST_TIMEOUT,
    })

    // Page count is discovered during extraction; chunks prove it was indexed.
    await expect(row).toContainText('3')
    const chunkCell = row.getByRole('cell').nth(3)
    await expect(chunkCell).not.toHaveText('—')

    // FR10/FR11: a grounded answer, with a citation naming document and page.
    await page.goto('/chat')
    await page
      .getByLabel('Question')
      .fill('How many days of annual leave do I get?')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText('Sources')).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByRole('button', { name: /handbook — p\d+/i }).first(),
    ).toBeVisible()
    // The leave policy is on page 1 of the fixture.
    await expect(
      page.getByRole('button', { name: /handbook — p1/i }).first(),
    ).toBeVisible()

    // Regression: "summarise <doc>" has no semantic anchor in the content, so
    // similarity search scored it ~0.17 and the answer was refused even though
    // the document was indexed. Whole-document requests retrieve by document.
    await page.getByLabel('Question').fill('summarise handbook')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Sources').last()).toBeVisible({
      timeout: 60_000,
    })
    await expect(
      page.getByText("I couldn't find anything about that in your documents."),
    ).toHaveCount(0)

    // FR8: delete removes it from the knowledge base.
    await page.goto(`/documents/${kbId}`)
    await page.getByRole('button', { name: /Delete handbook/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      page.getByText('No documents yet. Upload a PDF to get started.'),
    ).toBeVisible()
  })

  test('a PDF with no text layer is rejected, not partially ingested', async ({
    page,
  }) => {
    await register(page, 'scanned')

    const kbId = await createKnowledgeBase(page, 'My documents')
    await page.goto(`/documents/${kbId}`)
    await page
      .getByLabel('Upload a PDF')
      .setInputFiles(`${FIXTURES}/no-text-layer.pdf`)

    const row = page.getByRole('row', { name: /no-text-layer/i })
    await expect(row.getByText('Failed')).toBeVisible({
      timeout: INGEST_TIMEOUT,
    })

    // FR5: the message must name the cause, not just say "error".
    await expect(row).toContainText(/scanned/i)
    await expect(row).toContainText(/OCR/i)

    // Zero chunks — a partially-indexed document would be worse than none.
    await expect(row.getByRole('cell').nth(3)).toHaveText('—')

    // Retry is offered on a failed document and creates nothing. Asserting it
    // returns to `Failed` here would be racy — the badge has not necessarily
    // re-rendered yet, so the assertion could pass against the stale one.
    // Real re-ingest idempotency is covered by the `re-ingesting a document`
    // test below, which starts from a document that actually has chunks.
    await expect(
      page.getByRole('button', { name: /Retry no-text-layer/i }),
    ).toBeVisible()
    await page.getByRole('button', { name: /Retry no-text-layer/i }).click()
    await expect(row.getByRole('cell').nth(3)).toHaveText('—')
  })

  test('an unrelated question is answered as not-in-your-documents', async ({
    page,
  }) => {
    await register(page, 'nocontext')

    // A knowledge base must exist for the composer to be usable at all (spec
    // 0028 FR7 — zero KBs disables Send entirely). It has no documents, so
    // retrieval still finds nothing and the chat model must never be called.
    await createKnowledgeBase(page, 'My documents')

    await page.goto('/chat')
    await page
      .getByLabel('Question')
      .fill('What is the melting point of tungsten?')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(
      page.getByText("I couldn't find anything about that in your documents."),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Sources')).toHaveCount(0)
  })
})

// NFR5: re-ingesting a document must not duplicate its chunks. Proving this
// needs the document to be `failed` while still having chunks, which the UI
// alone cannot produce — so the status is flipped directly in the database,
// then Retry is driven through the UI as a user would.
test('re-ingesting a document does not duplicate its chunks', async ({
  page,
}) => {
  test.slow()
  const dbUrl = process.env.DATABASE_URL
  test.skip(!dbUrl, 'DATABASE_URL is required for this test')

  const email = await register(page, 'reingest')
  const kbId = await createKnowledgeBase(page, 'My documents')
  await page.goto(`/documents/${kbId}`)
  await page
    .getByLabel('Upload a PDF')
    .setInputFiles(`${FIXTURES}/handbook.pdf`)

  const row = page.getByRole('row', { name: /handbook/i })
  await expect(row.getByText('Ready')).toBeVisible({ timeout: INGEST_TIMEOUT })

  const chunkCell = row.getByRole('cell').nth(3)
  const before = Number(await chunkCell.innerText())
  expect(before).toBeGreaterThan(0)

  const sql = postgres(dbUrl!, { max: 1 })
  try {
    // Scoped to THIS test's user. Matching on title alone would also hit the
    // handbook belonging to whichever other worker is running the happy-path
    // test, which is a cross-test failure that only appears under parallelism.
    await sql`UPDATE documents SET status = 'failed', error = 'forced for test'
              WHERE title = 'handbook' AND status = 'ready'
                AND owner_id = (SELECT id FROM users WHERE email = ${email})`
    await page.reload()
    await expect(row.getByText('Failed')).toBeVisible()

    await page.getByRole('button', { name: /Retry handbook/i }).click()
    await expect(row.getByText('Ready')).toBeVisible({
      timeout: INGEST_TIMEOUT,
    })

    const after = Number(await chunkCell.innerText())
    expect(after).toBe(before)
  } finally {
    await sql.end()
  }
})

// Spec 0037: what was actually indexed, and the badge that says some of it
// wasn't. The partial states are forced through the database because the UI
// cannot produce one on demand — a genuinely failed page needs a document that
// fails to parse, which is exactly what makes this worth asserting.
test('a document can be inspected page by page, and a partial one says so', async ({
  page,
}) => {
  test.slow()
  const dbUrl = process.env.DATABASE_URL
  test.skip(!dbUrl, 'DATABASE_URL is required for this test')

  const email = await register(page, 'inspect')
  const kbId = await createKnowledgeBase(page, 'My documents')
  await page.goto(`/documents/${kbId}`)
  await page
    .getByLabel('Upload a PDF')
    .setInputFiles(`${FIXTURES}/handbook.pdf`)

  const row = page.getByRole('row', { name: /handbook/i })
  await expect(row.getByText('Ready')).toBeVisible({ timeout: INGEST_TIMEOUT })

  // FR1: reachable from the list.
  await row.getByRole('link', { name: 'handbook' }).click()
  await expect(page).toHaveURL(new RegExp(`/documents/${kbId}/[0-9a-f-]+$`))
  const documentId = page.url().split('/').pop()!

  // FR4: the stored text, on the page it came from.
  await expect(page.getByRole('heading', { name: 'handbook' })).toBeVisible()
  await page.getByRole('button', { name: /^Text/ }).first().click()
  await expect(page.getByText(/\d+ tokens/).first()).toBeVisible()

  const sql = postgres(dbUrl!, { max: 1 })
  try {
    // FR3, FR6: a failed page reads as "Not indexed" with its recorded reason,
    // and the enum never reaches the screen.
    await sql`UPDATE documents SET extraction = ${sql.json({
      pages: [
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
        { page: 2, route: 'clean-text', outcome: 'text-layer' },
        {
          page: 3,
          route: 'no-text',
          outcome: 'failed',
          reason: 'Parser found no elements. This page is not indexed.',
        },
      ],
      parseCalls: 1,
      describeCalls: 0,
      budgetExhausted: false,
    })} WHERE id = ${documentId}
        AND owner_id = (SELECT id FROM users WHERE email = ${email})`

    await page.reload()
    await expect(
      page.getByText('Some of this document is not searchable'),
    ).toBeVisible()
    await expect(page.getByText('Not indexed').first()).toBeVisible()
    await expect(page.getByText('text-layer')).toHaveCount(0)
    await expect(page.getByText('clean-text')).toHaveCount(0)

    // FR7: and the LIST says so too, beside `Ready` rather than instead of it.
    await page.goto(`/documents/${kbId}`)
    await expect(row.getByText('Ready')).toBeVisible()
    await expect(row.getByText('Partly indexed')).toBeVisible()
  } finally {
    await sql.end()
  }

  // NFR1: someone else's document is a 404, indistinguishable from one that
  // does not exist. Cookies first — `/register` redirects a signed-in user
  // away, so the second account cannot be created while the first is active.
  await page.context().clearCookies()
  await register(page, 'inspect-other')
  const otherKbId = await createKnowledgeBase(page, 'Not mine')
  const response = await page.goto(`/documents/${otherKbId}/${documentId}`)
  expect(response?.status()).toBe(404)
})
