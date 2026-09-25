import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/**
 * Settings → AI provider and Models (spec 0040 FR1, FR2, FR8). Hermetic: the
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
    'AI provider',
    'Models',
    'Users',
    'About',
  ])

  // One section at a time; the open one is in the URL hash.
  await expect(
    page.getByRole('heading', { name: 'Account', level: 2 }),
  ).toBeVisible()
  await nav.getByRole('link', { name: 'AI provider' }).click()
  await expect(page).toHaveURL(/#ai-provider$/)
  const provider = page.locator('#ai-provider')
  await expect(provider.getByText('Environment (.env)')).toBeVisible()
  await expect(page.locator('#account')).toBeHidden()

  await provider.getByRole('button', { name: 'Add connection' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Provider').click()
  await page.getByRole('option', { name: 'Custom' }).click()
  await dialog.getByLabel('Name').fill('E2E local')
  await dialog.getByLabel('Base URL').fill('http://127.0.0.1:9/v1')
  await dialog.getByLabel('API key').fill(SECRET)
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
  await nav.getByRole('link', { name: 'Models' }).click()
  const chat = page.locator('li[data-role="chat"]')
  await chat.getByLabel('Connection').click()
  await expect(page.getByRole('option', { name: 'E2E local' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.locator('li[data-role="embed"]').getByLabel('Connection'),
  ).toBeDisabled()

  await page.goto('/settings#ai-provider')
  await expect(page.locator('#ai-provider')).toBeVisible()
  expect(await page.content()).not.toContain(SECRET)
  expect(seen.some((body) => body.includes(SECRET))).toBe(false)

  page.once('dialog', (d) => d.accept())
  await page
    .locator('#ai-provider li', { hasText: 'E2E local' })
    .getByRole('button', { name: 'Remove E2E local' })
    .click()
  await expect(
    page.locator('#ai-provider li', { hasText: 'E2E local' }),
  ).toHaveCount(0)
})
