import { expect, test } from '@playwright/test'

const base = {
  sender: { name: 'Ana Morales', address: 'ana@example.com', initials: 'AM' },
  receivedAt: '2026-09-04T09:42:00+12:00', receivedLabel: 'Sep 4, 9:42 AM', receivedFullLabel: 'September 4, 2026 at 9:42 AM', preview: 'Confirmed', unread: true, messageCount: 1, accountId: 'a1',
}
const first = { ...base, id: 'demo:t1', threadId: 't1', latestMessageId: 'm1', subject: 'Berth' }
const second = { ...base, id: 'demo:t2', threadId: 't2', latestMessageId: 'm2', subject: 'New arrival', receivedAt: '2026-09-04T09:52:00+12:00' }
const older = { ...base, id: 'demo:t3', threadId: 't3', latestMessageId: 'm3', subject: 'Older unread', receivedAt: '2026-09-03T18:00:00+12:00' }

type ToneWindow = { __toneStarts: number[]; AudioContext: typeof AudioContext }

async function installFakeAudio(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('dispatch.setup.seen', '1') })
  await page.addInitScript(() => {
    const w = window as unknown as ToneWindow
    w.__toneStarts = []
    class FakeOsc { type = 'sine'; frequency = { value: 0 }; connect() {} start(at: number) { w.__toneStarts.push(at) } stop() {} }
    class FakeGain { gain = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }; connect() {} }
    class FakeContext { currentTime = 0; destination = {}; state = 'running'; async resume() {} createOscillator() { return new FakeOsc() } createGain() { return new FakeGain() } }
    w.AudioContext = FakeContext as unknown as typeof AudioContext
  })
}

const toneStarts = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as ToneWindow).__toneStarts.length)

test('chimes once when a live refresh brings an unread conversation', async ({ page }) => {
  let list = [first]
  let completedAt = '2026-09-04T09:01:00+12:00'
  await installFakeAudio(page)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'a1', name: 'Steve', email: 'steve@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/sync/status', (route) => route.fulfill({ json: { sync: { state: 'ready', startedAt: '2026-09-04T09:00:00+12:00', completedAt, error: null, messageCount: list.length } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=/, (route) => route.fulfill({ json: { source: 'gmail', conversations: list, nextCursor: null, total: list.length } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(.+)/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '')
    const summary = list.find((c) => c.id === id) ?? first
    return route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [] } } })
  })
  await page.route('http://127.0.0.1:8412/**', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Berth' })).toBeVisible()
  expect(await toneStarts(page)).toBe(0)
  list = [second, first]
  completedAt = '2026-09-04T09:06:00+12:00'
  await expect(page.getByRole('button', { name: /New arrival/ })).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => toneStarts(page)).toBe(9)
  completedAt = '2026-09-04T09:11:00+12:00'
  await page.waitForTimeout(6_000)
  expect(await toneStarts(page)).toBe(9)
})

test('stays silent when archiving scrolls an older unread thread onto the page', async ({ page }) => {
  let list = [first]
  await installFakeAudio(page)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'a1', name: 'Steve', email: 'steve@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/sync/status', (route) => route.fulfill({ json: { sync: { state: 'ready', startedAt: '2026-09-04T09:00:00+12:00', completedAt: '2026-09-04T09:01:00+12:00', error: null, messageCount: list.length } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=/, (route) => route.fulfill({ json: { source: 'gmail', conversations: list, nextCursor: null, total: list.length } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(.+)/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '')
    const summary = list.find((c) => c.id === id) ?? first
    const message = { ...summary, id: summary.latestMessageId, source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }
    return route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [message] } } })
  })
  // Registered last so it wins over the generic conversation route above.
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/actions', async (route) => {
    list = [older]
    await route.fulfill({ status: 202, json: { accepted: true } })
  })
  await page.route('http://127.0.0.1:8412/**', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Berth' })).toBeVisible()
  expect(await toneStarts(page)).toBe(0)
  await page.locator('[data-archive]').click()
  await expect(page.getByRole('button', { name: /Older unread/ })).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1_000)
  expect(await toneStarts(page)).toBe(0)
})
