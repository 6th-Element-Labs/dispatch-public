import { expect, test } from '@playwright/test'

test('Gmail sync setup is explicit, account-scoped, and does not show an unsolicited banner', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('dispatch.setup.seen', '1') })
  await page.route(/^http:\/\/127\.0\.0\.1:(8411|8412)\//, route => route.abort('connectionrefused'))
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work' }] } }))
  await page.route('http://127.0.0.1:8411/v1/sync/status', route => route.fulfill({ json: { sync: { state: 'ready', startedAt: null, completedAt: '2026-09-30T12:00:00Z', error: null, messageCount: 0 } } }))
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [], total: 0 } }))
  let configured = false
  let postedAccount = ''
  let state = 'connector'
  let disabledAccount = ''
  let resume = false
  await page.route(/8411\/v1\/gmail-sync(?:\?|$)/, async route => {
    if (route.request().method() === 'DELETE') {
      disabledAccount = new URL(route.request().url()).searchParams.get('account')!
      state = 'connector'; await route.fulfill({ json: { accepted: true } }); return
    }
    if (route.request().method() === 'POST') {
      postedAccount = route.request().postDataJSON().accountId
      if (resume) { state = 'connected'; await route.fulfill({ json: { connected: true } }); return }
      await route.fulfill({ status: 400, json: { error: 'fixture_sign_in_unavailable' } }); return
    }
    await route.fulfill({ json: { directSync: { configured, accounts: [{ accountId: 'one', email: 'work@example.com', state }] } } })
  })
  await page.goto('/')
  const dialog = page.getByRole('dialog', { name: 'Gmail sync', exact: true })
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: 'Mail activity', exact: true }).click()
  await page.getByRole('button', { name: 'Gmail sync', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('work@example.com')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled()
  await expect(dialog).toContainText('Google OAuth client registered for Dispatch')
  configured = true
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Mail activity', exact: true }).click()
  await page.getByRole('button', { name: 'Gmail sync', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toContainText('Could not connect Gmail sync')
  expect(postedAccount).toBe('one')
  state = 'connected'
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Mail activity', exact: true }).click()
  await page.getByRole('button', { name: 'Gmail sync', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Connected', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Use existing connection', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  expect(disabledAccount).toBe('one')
  resume = true
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Connected', exact: true })).toBeDisabled()
  await expect(dialog).not.toContainText('Finish Google sign-in')
})
