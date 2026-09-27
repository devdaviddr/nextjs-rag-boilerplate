import postgres from 'postgres'

import { expect, test } from './fixtures'

// Cross-user isolation (#131). User A's knowledge base, document, file and
// chunk are written straight into the database, so this needs no inference
// endpoint and no stored object. User B then asks for each of them by id and
// must get exactly what a never-existing id gets: a 404, with no signal that
// the resource exists (spec 0025 NFR1, spec 0026 NFR1).
//
// Ownership is checked before storage is touched, so the routes that would
// stream the PDF answer 404 here without ever reaching S3.

async function register(page: import('@playwright/test').Page, tag: string) {
  const email = `iso-${tag}+${Date.now()}@example.com`
  await page.goto('/register')
  await page.getByLabel('Name').fill('Isolation Tester')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByLabel('Confirm password').fill('Password123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chat/)
  return email
}

test("another user's documents, files, citations and knowledge bases stay private", async ({
  browser,
}) => {
  test.skip(!process.env.DATABASE_URL, 'DATABASE_URL is required')
  test.slow()

  const contextA = await browser.newContext()
  const pageA = await contextA.newPage()
  const emailA = await register(pageA, 'owner')

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  let ids: { kb: string; file: string; doc: string; chunk: string }
  try {
    ids = await sql.begin(async (tx) => {
      const [owner] = await tx`SELECT id FROM users WHERE email = ${emailA}`
      const ownerId = owner!.id as string
      const [kb] = await tx`
        INSERT INTO knowledge_bases (id, owner_id, name)
        VALUES (gen_random_uuid()::text, ${ownerId}, 'Private KB')
        RETURNING id`
      const [file] = await tx`
        INSERT INTO files (id, owner_id, bucket_key, original_name, mime_type, size_bytes)
        VALUES (gen_random_uuid()::text, ${ownerId},
                ${`isolation/${Date.now()}.pdf`}, 'private.pdf',
                'application/pdf', 1024)
        RETURNING id`
      const [doc] = await tx`
        INSERT INTO documents (id, owner_id, knowledge_base_id, file_id, title, status, page_count)
        VALUES (gen_random_uuid()::text, ${ownerId}, ${kb!.id}, ${file!.id},
                'Private document', 'ready', 1)
        RETURNING id`
      const [chunk] = await tx`
        INSERT INTO chunks (id, document_id, owner_id, knowledge_base_id, content,
                            page_number, chunk_index, token_count)
        VALUES (gen_random_uuid()::text, ${doc!.id}, ${ownerId}, ${kb!.id},
                'A private passage.', 1, 0, 4)
        RETURNING id`
      return {
        kb: kb!.id as string,
        file: file!.id as string,
        doc: doc!.id as string,
        chunk: chunk!.id as string,
      }
    })
  } finally {
    await sql.end()
  }

  // Control: the owner can reach the pages and the citation.
  expect((await pageA.request.get(`/documents/${ids.kb}`)).status()).toBe(200)
  expect(
    (await pageA.request.get(`/documents/${ids.kb}/${ids.doc}`)).status(),
  ).toBe(200)
  expect(
    (await pageA.request.get(`/api/citations/${ids.chunk}`)).status(),
  ).toBe(200)
  await contextA.close()

  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await register(pageB, 'intruder')

  const missing = crypto.randomUUID()
  const paths = (kb: string, doc: string, file: string, chunk: string) => [
    `/documents/${kb}`,
    `/documents/${kb}/${doc}`,
    `/api/documents/${doc}/source`,
    `/api/documents/${doc}/page?n=1`,
    `/api/files/${file}`,
    `/api/citations/${chunk}`,
  ]
  const theirs = paths(ids.kb, ids.doc, ids.file, ids.chunk)
  const nobodys = paths(missing, missing, missing, missing)

  for (const [i, path] of theirs.entries()) {
    const status = (await pageB.request.get(path)).status()
    const baseline = (await pageB.request.get(nobodys[i]!)).status()
    expect(status, `${path} must look like a missing id`).toBe(baseline)
    expect(status, path).toBe(404)
  }
  await contextB.close()
})
