import { expect, test } from './fixtures'
import { startStubMcp } from '../stub-mcp/server.mjs'

/**
 * Settings → Tools (spec 0048): an admin adds an MCP server, its tools are
 * listed off, one is switched on and audited, and the token never comes back.
 * Hermetic: the server is a stub on this machine, added as a private-network
 * server, which is the only way the app will reach a local address.
 */

const TOKEN = 'mcp-e2e-token-never-shown-7777'

test('an admin connects an MCP server and switches on one tool', async ({
  page,
}) => {
  const stub = await startStubMcp({ token: TOKEN, sse: true })
  const seen: string[] = []
  page.on('response', async (r) => {
    try {
      seen.push(await r.text())
    } catch {
      // Redirects and aborted requests have no body.
    }
  })
  try {
    await page.goto('/login')
    await page.getByLabel('Email').fill('demo@example.com')
    await page.getByLabel('Password', { exact: true }).fill('Password123')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/chat/)
    await page.goto('/settings#configuration')

    const tools = page.locator('#tools')
    const name = `Stub ${Date.now()}`
    await tools.getByRole('button', { name: 'Add tool server' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByLabel('URL').fill(stub.url)
    await dialog.getByLabel(/Bearer token/).fill(TOKEN)

    // A local address is refused unless the server is marked private.
    await dialog.getByRole('button', { name: 'Add and test' }).click()
    await expect(dialog.getByRole('alert')).toContainText('the test failed')
    await dialog.getByLabel('On a private network').check()
    await dialog.getByRole('button', { name: 'Save and test' }).click()
    await expect(dialog).toBeHidden()

    const row = tools.getByRole('listitem').filter({ hasText: name }).first()
    const lookup = row.getByRole('checkbox', { name: 'lookup_policy' })
    const add = row.getByRole('checkbox', { name: 'add_numbers' })
    await expect(lookup).not.toBeChecked()
    await expect(add).not.toBeChecked()
    await expect(row.getByText('private network')).toBeVisible()

    await lookup.click()
    await expect(lookup).toBeChecked()
    await expect(add).not.toBeChecked()
    await expect(
      page.locator('#changes').getByText(`${name} · lookup_policy`),
    ).toBeVisible()

    page.once('dialog', (d) => d.accept())
    await row.getByRole('button', { name: `Remove ${name}` }).click()
    await expect(tools.getByText(name, { exact: true })).toBeHidden()
    await expect(
      page.locator('#changes').getByText('removed tool server').first(),
    ).toBeVisible()
  } finally {
    await stub.close()
  }
  expect(seen.join('\n')).not.toContain(TOKEN)
})
