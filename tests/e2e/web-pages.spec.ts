import { expect, hasInferenceKey, test } from './fixtures'

// Spec 0047: a web page added by URL answers with a citation that links back
// to the page, refresh re-indexes it, and a private address is refused.
// Needs outbound internet as well as an inference key.

async function newKnowledgeBase(page: import('@playwright/test').Page) {
  await page.goto('/register')
  await page.getByLabel('Name').fill('Web Page Tester')
  await page.getByLabel('Email').fill(`web+${Date.now()}@example.com`)
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByLabel('Confirm password').fill('Password123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chat/)

  const name = `Web ${Date.now()}`
  await page.goto('/documents')
  await page.getByRole('button', { name: 'New knowledge base' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('link', { name }).click()
}

test('a private address is refused with the reason', async ({ page }) => {
  test.skip(!hasInferenceKey, 'No inference key (LLM_API_KEY)')
  await newKnowledgeBase(page)

  await page.getByLabel('Add from a URL').fill('http://169.254.169.254/')
  await page.getByRole('button', { name: 'Add URL' }).click()
  await expect(
    page.getByText('169.254.169.254 is not a public address.'),
  ).toBeVisible()
  await expect(page.getByText('No documents yet.')).toBeVisible()
})

test('a web page answers with a citation that links to it', async ({
  page,
}) => {
  test.skip(!hasInferenceKey, 'No inference key (LLM_API_KEY)')
  test.slow()
  await newKnowledgeBase(page)

  await page.getByLabel('Add from a URL').fill('https://example.com/')
  await page.getByRole('button', { name: 'Add URL' }).click()
  const row = page.getByRole('row', { name: /Example Domain/ })
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 120_000 })
  await expect(
    row.getByRole('link', { name: 'https://example.com/' }),
  ).toBeVisible()

  // Refresh keeps the document: same row, back to Ready.
  const href = await row
    .getByRole('link', { name: 'Example Domain' })
    .getAttribute('href')
  await row.getByRole('button', { name: /Refresh Example Domain/ }).click()
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 120_000 })
  await expect(
    page
      .getByRole('row', { name: /Example Domain/ })
      .getByRole('link', { name: 'Example Domain' }),
  ).toHaveAttribute('href', href!)

  await page.goto('/chat')
  await page.getByLabel('Question').fill('What is the example domain for?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Sources')).toBeVisible({ timeout: 60_000 })
  await page
    .getByRole('button', { name: /Example Domain/ })
    .first()
    .click()
  await expect(
    page.getByRole('link', { name: 'Open the web page' }),
  ).toHaveAttribute('href', 'https://example.com/')
})
