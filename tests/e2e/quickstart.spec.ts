import { expect, hasInferenceKey, test } from './fixtures'

// The README's "Getting started" browser steps, as written (#152): sign in as
// the seeded demo user, create a knowledge base, upload a text PDF, ask a
// question it answers and get a cited answer, then ask one it doesn't and get
// a refusal. CI runs this after `scripts/quickstart.mjs` has run the README's
// commands against the stub model server (tests/stub-llm), so a README step
// that stops working fails the release PR.

test('the README quickstart reaches a cited answer and a refusal', async ({
  page,
}) => {
  test.skip(!hasInferenceKey, 'No inference key (LLM_API_KEY)')
  test.slow()

  await page.goto('/login')
  await page.getByLabel('Email').fill('demo@example.com')
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/chat/)

  // "go to /documents and create a knowledge base"
  const name = `Quickstart ${Date.now()}`
  await page.goto('/documents')
  await page.getByRole('button', { name: 'New knowledge base' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('link', { name }).click()

  // "upload a text PDF into it and wait for its status to reach ready"
  await page
    .getByLabel('Upload a PDF')
    .setInputFiles('tests/e2e/fixtures/handbook.pdf')
  const row = page.getByRole('row', { name: /handbook/i })
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 120_000 })

  // "go to /chat … ask a question the document answers. Every answer cites
  // the page it came from."
  await page.goto('/chat')
  await page
    .getByLabel('Question')
    .fill('How many days of annual leave do I get?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Sources')).toBeVisible({ timeout: 60_000 })
  // The citation names the document and page: the leave policy is on page 1.
  await expect(
    page.getByRole('button', { name: /handbook — p1/i }).first(),
  ).toBeVisible()

  // "Now ask something the document does not cover. You get a refusal."
  await page.goto('/chat')
  await page
    .getByLabel('Question')
    .fill('What is the melting point of tungsten?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(
    page.getByText("I couldn't find anything about that in your documents."),
  ).toBeVisible({ timeout: 60_000 })
})
