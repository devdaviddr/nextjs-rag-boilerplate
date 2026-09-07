import { expect, test } from './fixtures'

/**
 * End-to-end smoke test of the auth flow. Requires a running app and a
 * migrated database (see README → Testing). Registers a unique user, lands on
 * the chat, signs out, and signs back in.
 */
test('register → chat → sign out → sign in', async ({ page }) => {
  const email = `e2e+${Date.now()}@example.com`
  const password = 'Password123'

  // Register
  await page.goto('/register')
  await page.getByLabel('Name').fill('E2E User')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page).toHaveURL(/\/chat/)
  // The signed-in email lives in the sidebar account menu now (spec 0026);
  // there is no dashboard card and no topbar copy of it.
  await expect(
    page.getByRole('button', { name: 'Account menu' }),
  ).toContainText(email)

  // Sign out
  // Sign out now lives in the account menu at the foot of the sidebar
  // (spec 0026), not in a top bar.
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)

  // Sign back in
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/chat/)
})

test('protected route redirects unauthenticated users to login', async ({
  page,
}) => {
  await page.goto('/chat')
  await expect(page).toHaveURL(/\/login/)
})
