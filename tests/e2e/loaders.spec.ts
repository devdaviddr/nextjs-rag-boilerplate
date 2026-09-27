import { expect, hasInferenceKey, test } from './fixtures'

// Spec 0046: Markdown, HTML and Word documents index and answer with a
// section citation, like a PDF with a page one.

async function register(page: import('@playwright/test').Page) {
  await page.goto('/register')
  await page.getByLabel('Name').fill('Loader Tester')
  await page.getByLabel('Email').fill(`loaders+${Date.now()}@example.com`)
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByLabel('Confirm password').fill('Password123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chat/)
}

for (const file of [
  'leave-policy.md',
  'leave-policy.html',
  'leave-policy.docx',
]) {
  test(`${file} answers with a section citation`, async ({ page }) => {
    test.skip(!hasInferenceKey, 'No inference key (LLM_API_KEY)')
    test.slow()
    await register(page)

    const name = `Formats ${Date.now()}`
    await page.goto('/documents')
    await page.getByRole('button', { name: 'New knowledge base' }).click()
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('link', { name }).click()

    await page
      .getByLabel('Upload a document')
      .setInputFiles(`tests/e2e/fixtures/${file}`)
    const row = page.getByRole('row', { name: /leave-policy|Leave policy/i })
    await expect(row.getByText('Ready')).toBeVisible({ timeout: 120_000 })

    await page.goto('/chat')
    await page
      .getByLabel('Question')
      .fill('How many days of annual leave do I get?')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Sources')).toBeVisible({ timeout: 60_000 })

    // "Annual leave" is the second section of every fixture.
    const chip = page.getByRole('button', { name: /leave-policy — §2/i })
    await expect(chip.first()).toBeVisible()
    await chip.first().click()
    const panel = page.getByRole('complementary', { name: /section 2/i })
    await expect(panel.getByText(/25 working days/)).toBeVisible()
    await expect(panel.locator('img')).toHaveCount(0)
  })
}
