import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/**
 * Observability (spec 0042). Uses the seeded admin, and a freshly registered
 * user, whose registration is itself a log line to look for.
 */

async function signInAdmin(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('demo@example.com')
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/chat/)
}

test('non-admins cannot see or reach Observability (FR11)', async ({
  page,
}) => {
  const email = `noobs+${Date.now()}@example.com`
  await page.goto('/register')
  await page.getByLabel('Name').fill('No Observability')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByLabel('Confirm password').fill('Password123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chat/)

  await expect(page.getByRole('link', { name: 'Observability' })).toHaveCount(0)
  const res = await page.goto('/observability/logs')
  expect(res?.status()).toBe(404)
  const api = await page.request.get('/api/observability/logs')
  expect(api.status()).toBe(403)
})

test('an admin reads the logs: colours, filters, details, one request (FR7)', async ({
  page,
}) => {
  // Something to find: a registration writes an auth line.
  const email = `logged+${Date.now()}@example.com`
  await page.goto('/register')
  await page.getByLabel('Name').fill('Logged User')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('Password123')
  await page.getByLabel('Confirm password').fill('Password123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/chat/)
  await page.context().clearCookies()

  await signInAdmin(page)
  await page.getByRole('link', { name: 'Observability' }).click()
  await expect(page).toHaveURL(/\/observability\/logs$/)

  const log = page.getByRole('log', { name: 'Log lines' })
  // Lines are written in batches every second; the page polls every two.
  await page
    .getByRole('searchbox', { name: 'Search logs' })
    .fill('User registered')
  const line = log.locator('li', { hasText: 'User registered' }).last()
  await expect(line).toBeVisible({ timeout: 15_000 })
  await expect(line).toHaveAttribute('data-category', 'auth')
  await expect(line).toContainText('Info')

  await line.getByRole('button', { name: /Show details/ }).click()
  await expect(line.locator('pre')).toBeVisible()

  // Level toggles filter, and say how many lines each level has.
  await page
    .getByRole('group', { name: 'Levels' })
    .getByRole('button', { name: /Error/ })
    .click()
  await expect(log.locator('li', { hasText: 'User registered' })).toHaveCount(0)

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
})

test('an admin browses runs, and replays one when there is one (FR9)', async ({
  page,
}) => {
  await signInAdmin(page)
  await page.goto('/observability/runs')
  await expect(page.getByRole('link', { name: 'Runs' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  const table = page.getByRole('table')
  const empty = page.getByText(/No runs yet/)
  await expect(table.or(empty)).toBeVisible()

  let results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])

  // CI has no model key, so only a local run with history gets this far.
  if (await empty.isVisible()) return
  await table.getByRole('link').first().click()
  // The first visit compiles the page under `next dev`.
  await expect(page).toHaveURL(/\/observability\/runs\/[\w-]+$/, {
    timeout: 15_000,
  })
  const slider = page.getByRole('slider', { name: 'Replay position' })
  await expect(slider).toBeVisible()
  await page.getByRole('button', { name: 'Back to the start' }).click()
  await expect(slider).toHaveValue('0')
  await expect(page.getByLabel('Waiting').first()).toBeVisible()

  results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
})
