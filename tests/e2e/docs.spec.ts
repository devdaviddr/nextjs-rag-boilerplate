import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/**
 * The in-app Docs section (spec 0041). Mermaid only renders in a real browser,
 * so this is where FR4 — and the CSP it has to work under — is proven.
 * Uses the seeded demo user.
 */

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('demo@example.com')
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/chat/)
}

test('signed-out visitors are sent to sign in', async ({ page, request }) => {
  await page.goto('/docs')
  await expect(page).toHaveURL(/\/login/)
  const image = await request.get('/docs-assets/answer.png')
  expect(image.status()).toBe(401)
})

test('the index lists every section, reachable from the sidebar', async ({
  page,
}) => {
  await signIn(page)
  await page.getByRole('link', { name: 'Docs' }).first().click()
  await expect(page).toHaveURL(/\/docs$/)
  for (const section of [
    'About',
    'Using the app',
    'Features',
    'Architecture & retrieval',
    'Data',
    'Operations',
  ]) {
    await expect(page.getByRole('heading', { name: section })).toBeVisible()
  }
})

test('a page renders its diagrams, contents and in-app links', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await signIn(page)

  // Every Mermaid block becomes an SVG — none still loading, none fallen back
  // to its source — on all three pages that have diagrams (12 in total).
  for (const slug of ['database', 'rag', 'architecture']) {
    await page.goto(`/docs/${slug}`)
    await expect(page.locator('[data-mermaid] svg').first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Drawing diagram…')).toHaveCount(0, {
      timeout: 20_000,
    })
    await expect(page.locator('[data-mermaid-fallback]')).toHaveCount(0)
  }
  expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([])

  // The table of contents jumps to a heading on the page.
  const toc = page.getByRole('complementary', { name: 'On this page' })
  const first = toc.getByRole('link').first()
  const target = (await first.getAttribute('href')) ?? ''
  await first.click()
  await expect(page).toHaveURL(new RegExp(`${target}$`))

  // A relative doc link stays inside the app.
  await page.locator('.prose-docs a[href^="/docs/"]').first().click()
  await expect(page).toHaveURL(/\/docs\/[a-z-]+/)
  await expect(page.locator('.prose-docs h1')).toBeVisible()
})

test('diagrams also render in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page)
  await page.goto('/docs/rag')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.locator('[data-mermaid] svg').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText('Drawing diagram…')).toHaveCount(0, {
    timeout: 20_000,
  })
  await expect(page.locator('[data-mermaid-fallback]')).toHaveCount(0)
})

test('an unknown page is a 404', async ({ page }) => {
  await signIn(page)
  const response = await page.goto('/docs/no-such-page')
  expect(response?.status()).toBe(404)
})
