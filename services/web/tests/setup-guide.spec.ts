import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [] } }))
  await page.route('http://127.0.0.1:8411/v1/sync/status', (route) => route.fulfill({
    json: { sync: { state: 'ready', startedAt: '2026-09-04T09:00:00+12:00', completedAt: '2026-09-04T09:01:00+12:00', error: null, messageCount: 0 } },
  }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [] } }))
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ status: 503, json: { status: 'not_ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
})

test('shows the first-run setup overlay until Continue', async ({ page }) => {
  await page.goto('/')
  const setup = page.locator('[data-setup]')
  await expect(setup).toBeVisible()
  await expect(setup).toHaveAttribute('role', 'dialog')
  await expect(setup).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.dispatch-toolbar')).toHaveAttribute('inert', '')
  await expect(page.locator('.dispatch-workspace')).toHaveAttribute('inert', '')
  await expect(setup.getByRole('heading', { name: 'Your whole Codex, pointed at your inbox.' })).toBeFocused()
  await page.keyboard.press('?')
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(setup.getByRole('heading', { name: 'Your whole Codex, pointed at your inbox.' })).toBeFocused()
  await expect(setup.getByRole('link', { name: 'Open install guide' })).toHaveAttribute('href', 'https://developers.openai.com/codex/cli')
  await expect(setup.getByText('codex login')).toBeVisible()
  await expect(setup.getByRole('link', { name: 'Open Codex' })).toHaveAttribute('href', 'codex://plugins/gmail@openai-curated')
  await expect(setup.getByText('/plugins')).toBeVisible()
  await expect(setup.getByText('Catch me up on this thread')).toBeVisible()
  await expect(setup.locator('[data-setup-agent-label]')).toHaveText(/Codex|Waiting|Connecting|Unavailable/)
  await expect(page.locator('[data-mailbox-title]')).toHaveText('Inbox')
  await page.locator('[data-setup-continue]').click()
  await expect(setup).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible()
  await page.locator('[data-setup-open]').click()
  await expect(setup).toBeVisible()
  await expect(setup.getByRole('heading', { name: 'Your whole Codex, pointed at your inbox.' })).toBeFocused()
  await page.locator('[data-setup-continue]').click()
  await expect(page.locator('[data-setup-open]')).toBeFocused()
  await page.reload()
  await expect(page.locator('[data-setup]')).toBeHidden()
})

test('Set up later hides the overlay like Continue', async ({ page }) => {
  await page.goto('/')
  const setup = page.locator('[data-setup]')
  await expect(setup).toBeVisible()
  await page.locator('[data-setup-later]').click()
  await expect(setup).toBeHidden()
  await page.reload()
  await expect(page.locator('[data-setup]')).toBeHidden()
})

test('keeps Continue reachable in a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 450, height: 300 })
  await page.goto('/')
  const setup = page.locator('[data-setup]')
  await expect.poll(() => setup.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await page.locator('[data-setup-continue]').click()
  await expect(setup).toBeHidden()
})

test('opens the Gmail plugin through the trusted native web-link command', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    Object.assign(window, {
      isTauri: true,
      __setupInvocations: calls,
      __TAURI__: {
        core: {
          invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push({ command, args })
            return {}
          },
        },
      },
    })
  })
  await page.goto('/')
  await page.locator('[data-setup-gmail]').click()
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __setupInvocations: Array<{ command: string; args?: Record<string, unknown> }> }
  ).__setupInvocations)).toContainEqual({
    command: 'open_web_link',
    args: { url: 'codex://plugins/gmail@openai-curated' },
  })
})
