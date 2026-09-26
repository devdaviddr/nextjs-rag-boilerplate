import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/**
 * Settings → Configuration: providers and models (spec 0040 FR1, FR2, FR8;
 * spec 0042 FR1, FR2). Hermetic: the
 * connection added here points at a closed local port, so nothing leaves the
 * machine. Uses the seeded demo user, who is an admin.
 */

const SECRET = 'sk-e2e-never-shown-0123456789wxyz'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('demo@example.com')
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/chat/)
}

test('an admin adds, tests and removes a connection; the key never comes back', async ({
  page,
}) => {
  const seen: string[] = []
  page.on('response', async (r) => {
    try {
      seen.push(await r.text())
    } catch {
      // Redirects and aborted requests have no body.
    }
  })
  await signIn(page)
  await page.goto('/settings')

  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav.getByRole('link')).toHaveText([
    'Account',
    'Configuration',
    'Users',
    'About',
  ])

  // One section at a time; the open one is in the URL hash.
  await expect(
    page.getByRole('heading', { name: 'Account', level: 2 }),
  ).toBeVisible()
  await nav.getByRole('link', { name: 'Configuration' }).click()
  await expect(page).toHaveURL(/#configuration$/)
  const provider = page.locator('#providers')
  await expect(provider.getByText('Environment (.env)')).toBeVisible()
  await expect(page.locator('#account')).toBeHidden()

  await provider.getByRole('button', { name: 'Add connection' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Provider', { exact: true }).click()
  await page.getByRole('option', { name: 'Custom' }).click()
  await dialog.getByLabel('Name', { exact: true }).fill('E2E local')
  await dialog
    .getByLabel('Base URL', { exact: true })
    .fill('http://127.0.0.1:9/v1')
  await dialog.locator('#conn-key').fill(SECRET)
  await dialog.getByRole('button', { name: 'Add connection' }).click()
  await expect(dialog).toBeHidden()

  const row = provider.locator('li', { hasText: 'E2E local' })
  await expect(row).toContainText('Key ••••wxyz')
  await row.getByRole('button', { name: 'Test' }).click()
  await expect(row.getByRole('status')).toContainText('No response', {
    timeout: 20_000,
  })

  // The connection is offered to the jobs that can move, and the model
  // box lists what a connection serves (here: nothing answers, so it says so).
  const chat = page.locator('li[data-role="chat"]')
  await chat.getByLabel('Connection', { exact: true }).click()
  await expect(page.getByRole('option', { name: 'E2E local' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page
      .locator('li[data-role="embed"]')
      .getByLabel('Connection', { exact: true }),
  ).toBeDisabled()

  // An old link to the AI provider tab still opens Configuration.
  await page.goto('/settings#ai-provider')
  await expect(page.locator('#providers')).toBeVisible()
  expect(await page.content()).not.toContain(SECRET)
  expect(seen.some((body) => body.includes(SECRET))).toBe(false)

  page.once('dialog', (d) => d.accept())
  await page
    .locator('#providers li', { hasText: 'E2E local' })
    .getByRole('button', { name: 'Remove E2E local' })
    .click()
  await expect(
    page.locator('#providers li', { hasText: 'E2E local' }),
  ).toHaveCount(0)
})

test('every AI setting explains itself: hover, click and keyboard', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/settings#configuration')

  // One ⓘ per job, plus one per field in each job row and one for Providers.
  const planner = page.getByRole('button', {
    name: 'About Planner',
    exact: true,
  })
  await planner.hover()
  await expect(page.getByRole('dialog')).toContainText('tool calls')
  await page.mouse.move(0, 0)
  await expect(page.getByRole('dialog')).toBeHidden()

  // Click pins it open until dismissed.
  await page.getByRole('button', { name: 'About Embeddings' }).click()
  await page.mouse.move(0, 0)
  await expect(page.getByRole('dialog')).toContainText('re-indexing')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  // Keyboard: focus and Enter.
  await page.getByRole('button', { name: 'About Providers' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('OpenAI-style API')
  await page.keyboard.press('Escape')

  for (const job of [
    'Chat',
    'Planner',
    'HyDE',
    'Vision',
    'Page parser',
    'Embeddings',
  ]) {
    await expect(
      page.getByRole('button', { name: `About ${job}`, exact: true }),
    ).toHaveCount(1)
  }

  // Save is always the primary button; with nothing changed it says so.
  const save = page
    .locator('li[data-role="chat"]')
    .getByRole('button', { name: 'Save' })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(
    page.locator('li[data-role="chat"]').getByRole('status'),
  ).toContainText('Nothing to save')
})

test('an admin tunes a retrieval setting, sees who saved it, and resets it', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/settings#configuration')

  const row = page.locator('li[data-setting="RAG_TOP_K"]')
  const box = row.getByLabel('Passages per answer', { exact: true })

  // Out of range: refused, with the allowed range.
  await box.fill('0')
  await row.getByRole('button', { name: 'Save' }).click()
  await expect(row.getByRole('status')).toContainText(
    'Passages per answer must be a whole number from 1 up.',
  )

  await box.fill('6')
  await row.getByRole('button', { name: 'Save' }).click()
  await expect(
    page.locator('li[data-setting="RAG_TOP_K"]').getByText('saved here by'),
  ).toBeVisible()
  await expect(page.locator('#changes')).toContainText('RAG_TOP_K')

  await page
    .locator('li[data-setting="RAG_TOP_K"]')
    .getByRole('button', { name: 'Use .env' })
    .click()
  await expect(
    page.locator('li[data-setting="RAG_TOP_K"]').getByText('saved here'),
  ).toHaveCount(0)
})
