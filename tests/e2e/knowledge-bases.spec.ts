import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import postgres from 'postgres'

import { expect, test } from './fixtures'

// Independent knowledge bases (spec 0028), end to end through the UI.
//
// Companion to rag.spec.ts (spec 0025), which covers the single-knowledge-base
// ingest/chat/delete happy path this spec did not change. This file covers
// what 0028 actually added: a conversation's search boundary now has a second
// dimension (which knowledge bases, not just which owner), and the whole
// point of the spec is that the boundary holds even though every knowledge
// base here belongs to the SAME user — `owner_id` never fires to save you.
//
// Same posture as rag.spec.ts: RAG needs a live inference endpoint, so these
// self-skip rather than fail when one isn't configured.
test.beforeEach(() => {
  test.skip(
    !process.env.NVIDIA_API_KEY,
    'NVIDIA_API_KEY is not set — RAG end-to-end tests skipped',
  )
})

const FIXTURES = 'tests/e2e/fixtures'
const INGEST_TIMEOUT = 120_000

async function register(page: import('@playwright/test').Page, tag: string) {
  const email = `kb-${tag}+${Date.now()}@example.com`
  await page.goto('/register')
  await page.getByLabel('Name').fill('KB Tester')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByLabel('Confirm password').fill('Password123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chat/)
  return email
}

/** Create a knowledge base from `/documents` and return its id from the URL
 * its card links to — there is no other way to learn it from the UI alone. */
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
  if (!kbId)
    throw new Error(`Could not read the id for "${name}" from its link.`)
  return kbId
}

/** Upload into a specific knowledge base's page (FR3: upload always targets
 * the KB whose page it happens on) and wait for ingestion to finish. */
async function uploadAndWaitReady(
  page: import('@playwright/test').Page,
  knowledgeBaseId: string,
  fixtureFile: string,
  rowName: RegExp,
) {
  await page.goto(`/documents/${knowledgeBaseId}`)
  await page.getByLabel('Upload a PDF').setInputFiles(fixtureFile)
  const row = page.getByRole('row', { name: rowName })
  await expect(row.getByText('Ready')).toBeVisible({ timeout: INGEST_TIMEOUT })
}

/** Narrow a NEW conversation's composer selection down to exactly one
 * knowledge base, starting from the default "all" (spec 0028 UX). */
async function restrictScopeToOnly(
  page: import('@playwright/test').Page,
  keep: string,
  others: string[],
) {
  await page.getByRole('button', { name: 'All knowledge bases' }).click()
  for (const name of others) {
    await page.getByRole('menuitemcheckbox', { name }).click()
  }
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('button', {
      name: `${others.length} selected: ${keep}`,
    }),
  ).toBeVisible()
}

test.describe('cross-knowledge-base isolation', () => {
  test.slow()

  test(
    'a chat scoped to one KB cannot answer from another, answers when both ' +
      'are selected, a title match in an unselected KB does not resolve, ' +
      'and moving a document re-tags it without re-embedding',
    async ({ page }) => {
      test.setTimeout(6 * 60_000)
      const dbUrl = process.env.DATABASE_URL
      test.skip(!dbUrl, 'DATABASE_URL is required for this test')

      const email = await register(page, 'isolation')

      // Two independent KBs, one document each. The facilities guide is the
      // real eval-corpus fixture (spec 0028's evaluation corpus), reused here
      // because it deliberately shares NO content with the handbook on
      // building hours — only the unrelated Wellington Street coincidence,
      // which this test does not touch.
      const handbookKbId = await createKnowledgeBase(page, 'Handbook KB')
      await uploadAndWaitReady(
        page,
        handbookKbId,
        `${FIXTURES}/handbook.pdf`,
        /handbook/i,
      )
      const facilitiesKbId = await createKnowledgeBase(page, 'Facilities KB')
      await uploadAndWaitReady(
        page,
        facilitiesKbId,
        `${FIXTURES}/facilities-guide.pdf`,
        /facilities-guide/i,
      )

      // --- Conversation 1: scoped to Handbook KB only -------------------
      await page.goto('/chat')
      await restrictScopeToOnly(page, 'Handbook KB', ['Facilities KB'])

      // The building's opening hours exist ONLY in the facilities guide
      // (KB B). Scoped to KB A alone, this must be refused — not answered
      // from a chunk retrieval never should have reached in the first place.
      await page
        .getByLabel('Question')
        .fill('What time does the building open on weekdays?')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(
        page.getByText(
          "I couldn't find anything about that in your documents.",
        ),
      ).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText('Sources')).toHaveCount(0)

      // A no-context refusal round-trips near-instantly (no model streaming),
      // which lands close enough to the `history.replaceState` that adopts
      // this new conversation's URL that firing the next question immediately
      // can race the client's post-answer `router.refresh()` and get lost
      // client-side before it ever reaches the composer. Waiting for the
      // network to quiet down first is the same fix a human typing at normal
      // speed gets for free.
      await page.waitForLoadState('networkidle')

      // Same conversation, still scoped to KB A only. Naming the OTHER KB's
      // document by title must not resolve to it (FR6 / retrieveDocumentChunks
      // — the "most dangerous function" the spec calls out, because owner_id
      // alone can no longer be trusted to gate this). The permitted document
      // list here contains only the handbook, so the whole-document shortcut
      // falls back to it instead of ever touching facilities-guide.
      await page.getByLabel('Question').fill('summarise facilities-guide')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(page.getByText('Sources').last()).toBeVisible({
        timeout: 60_000,
      })
      await expect(
        page.getByRole('button', { name: /handbook — p\d+/i }).first(),
      ).toBeVisible()
      await expect(
        page.getByRole('button', { name: /facilities-guide/i }),
      ).toHaveCount(0)
      // No fact unique to the excluded document leaked into the answer.
      await expect(
        page.getByText(/6am|access card|visitor bay|ballot|boardroom/i),
      ).toHaveCount(0)

      // --- Conversation 2: scoped to both KBs (the default) --------------
      await page.goto('/chat')
      await expect(
        page.getByRole('button', { name: 'All knowledge bases' }),
      ).toBeVisible()
      await page
        .getByLabel('Question')
        .fill('What time does the building open on weekdays?')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(page.getByText('Sources')).toBeVisible({ timeout: 60_000 })
      // The building opens at 6am per page 1 of the facilities guide.
      await expect(
        page.getByRole('button', { name: /facilities-guide — p1/i }).first(),
      ).toBeVisible()

      // --- FR4: moveDocument re-tags rows only, no re-embedding -----------
      const sql = postgres(dbUrl!, { max: 1 })
      try {
        const chunkSnapshot = async () => {
          const rows = await sql`
            SELECT c.id, c.created_at, c.knowledge_base_id
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE d.title = 'handbook'
              AND d.owner_id = (SELECT id FROM users WHERE email = ${email})
            ORDER BY c.chunk_index`
          return rows.map((r) => ({
            id: r.id as string,
            createdAtMs: (r.created_at as Date).getTime(),
            knowledgeBaseId: r.knowledge_base_id as string,
          }))
        }

        const before = await chunkSnapshot()
        expect(before.length).toBeGreaterThan(0)
        expect(before.every((c) => c.knowledgeBaseId === handbookKbId)).toBe(
          true,
        )

        await page.goto(`/documents/${handbookKbId}`)
        await page.getByRole('button', { name: /Move handbook/i }).click()
        await page.getByRole('menuitem', { name: 'Facilities KB' }).click()

        // Gone from the old KB's page…
        await expect(
          page.getByText('No documents yet. Upload a PDF to get started.'),
        ).toBeVisible()
        // …and present, already Ready (no re-ingestion), on the new one.
        await page.goto(`/documents/${facilitiesKbId}`)
        const movedRow = page.getByRole('row', { name: /handbook/i })
        await expect(movedRow).toBeVisible()
        await expect(movedRow.getByText('Ready')).toBeVisible()

        // The strongest available signal that nothing was re-embedded: the
        // exact same chunk rows, same ids, same createdAt — only the
        // denormalised KB tag changed.
        const after = await chunkSnapshot()
        expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id))
        expect(after.map((c) => c.createdAtMs)).toEqual(
          before.map((c) => c.createdAtMs),
        )
        expect(after.every((c) => c.knowledgeBaseId === facilitiesKbId)).toBe(
          true,
        )
      } finally {
        await sql.end()
      }

      // --- Searchable from the new KB, scoped so the old KB could not mask
      // a bug (a conversation scoped to "all" would still work even if the
      // KB tag update silently failed, since the old KB id is in "all" too).
      await page.goto('/chat')
      await restrictScopeToOnly(page, 'Facilities KB', ['Handbook KB'])
      await page
        .getByLabel('Question')
        .fill('How many days of annual leave do I get?')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(page.getByText('Sources')).toBeVisible({ timeout: 60_000 })
      await expect(
        page.getByRole('button', { name: /handbook — p\d+/i }).first(),
      ).toBeVisible()
    },
  )
})

test('deleting a knowledge base removes its documents, chunks, and S3 object', async ({
  page,
}) => {
  test.slow()
  test.setTimeout(3 * 60_000)
  const dbUrl = process.env.DATABASE_URL
  test.skip(!dbUrl, 'DATABASE_URL is required for this test')
  test.skip(!process.env.S3_ENDPOINT, 'S3_ENDPOINT is required for this test')

  const email = await register(page, 'delete-kb')
  const kbId = await createKnowledgeBase(page, 'Doomed KB')
  await uploadAndWaitReady(page, kbId, `${FIXTURES}/handbook.pdf`, /handbook/i)

  const sql = postgres(dbUrl!, { max: 1 })
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  })
  const bucket = process.env.S3_BUCKET!

  try {
    const [row] = await sql`
      SELECT f.bucket_key
      FROM files f
      JOIN documents d ON d.file_id = f.id
      WHERE d.title = 'handbook'
        AND d.owner_id = (SELECT id FROM users WHERE email = ${email})`
    const bucketKey = row?.bucket_key as string | undefined
    expect(bucketKey).toBeTruthy()

    // Prove the object exists BEFORE deletion, so the later "gone" assertion
    // demonstrates removal rather than a key that was never there.
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: bucketKey })),
    ).resolves.toBeDefined()

    // FR2: delete the knowledge base — its documents, their chunks, and their
    // S3 objects (not covered by any DB cascade) all go with it.
    await page.goto('/documents')
    await page.getByRole('button', { name: 'Actions for Doomed KB' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      page.getByText(
        'No knowledge bases yet. Create one to start uploading documents.',
      ),
    ).toBeVisible()

    const remainingDocs = await sql`
      SELECT 1 FROM documents
      WHERE owner_id = (SELECT id FROM users WHERE email = ${email})`
    expect(remainingDocs.length).toBe(0)
    const remainingChunks = await sql`
      SELECT 1 FROM chunks
      WHERE owner_id = (SELECT id FROM users WHERE email = ${email})`
    expect(remainingChunks.length).toBe(0)
    const remainingFiles = await sql`
      SELECT 1 FROM files
      WHERE owner_id = (SELECT id FROM users WHERE email = ${email})`
    expect(remainingFiles.length).toBe(0)

    // The S3 object is gone too — no database cascade reaches it, so this is
    // only true if deleteKnowledgeBase swept it explicitly.
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: bucketKey })),
    ).rejects.toThrow()
  } finally {
    await sql.end()
  }
})

test('a brand-new user with no knowledge bases cannot send a question', async ({
  page,
}) => {
  await register(page, 'zero-kb')

  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await expect(
    page.getByText(
      'Create a knowledge base to start asking questions about your documents.',
    ),
  ).toBeVisible()
  // FR7: Send stays disabled rather than letting the request round-trip to a
  // canned refusal.
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()

  // The empty state's own button opens the same create dialog as /documents,
  // so this is a real escape from the empty state, not a dead end.
  await page.getByRole('button', { name: 'New knowledge base' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})
