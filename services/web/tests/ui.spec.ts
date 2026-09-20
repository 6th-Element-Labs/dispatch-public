import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const messages = [
  {
    id: 'm1', threadId: 't1', sender: { name: 'Ana Morales', address: 'ana@example.com', initials: 'AM' },
    subject: 'Opua berth confirmation', receivedAt: '2026-09-04T09:42:00+12:00', receivedLabel: 'Sep 4, 9:42 AM', receivedFullLabel: 'September 4, 2026 at 9:42 AM', preview: 'Confirmed', unread: true,
  },
  {
    id: 'm2', threadId: 't2', sender: { name: 'James Liu', address: 'james@example.com', initials: 'JL' },
    subject: 'Services agreement', receivedAt: '2026-09-04T08:16:00+12:00', receivedLabel: 'Sep 4, 8:16 AM', receivedFullLabel: 'September 4, 2026 at 8:16 AM', preview: 'Comments added', unread: true,
  },
]

const conversations = messages.map((message) => ({
  ...message,
  id: `demo:${message.threadId}`,
  latestMessageId: message.id,
  messageCount: 1,
}))

async function stubAgent(page: import('@playwright/test').Page, bindings: Record<string, { threadId: string }> = {}) {
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', async (route) => {
    const body = await route.request().postDataJSON() as { kind?: string; accountId?: string; gmailThreadId?: string; draftKey?: string }
    const key = body.kind === 'draft' ? `draft:${body.draftKey}` : body.kind === 'conversation' ? `conversation:${body.accountId}:${body.gmailThreadId}` : 'unbound'
    const threadId = bindings[key]?.threadId ?? (body.kind === 'draft' ? bindings.draft?.threadId : undefined) ?? `thread-${key}`
    await route.fulfill({ json: { binding: { key: body, threadId, created: false, replaced: false } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const id = route.request().url().split('/').pop()
    await route.fulfill({ json: { thread: { turns: [{ items: [{ type: 'agentMessage', text: `History for ${id}` }] }] } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('dispatch.setup.seen', '1') })
  await page.route(/8411\/v1\/mailboxes\/counts/, (route) => route.fulfill({ json: { source: 'demo', counts: { inbox: 0, drafts: 0, spam: 0 } } }))
  await page.route('http://127.0.0.1:8412/v1/activity', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: []\n\n' }))
  await page.route(/8411\/v1\/send-receipts/, route => route.fulfill({ json: { receipts: [] } }))
  await page.route(/8411\/v1\/offline/, route => route.fulfill({ json: { offline: { conversations: 0, bytes: 0 } } }))
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [] } }))
  await page.route('http://127.0.0.1:8411/v1/sync/status', (route) => route.fulfill({ json: { sync: { state: 'ready', startedAt: '2026-09-04T09:00:00+12:00', completedAt: '2026-09-04T09:01:00+12:00', error: null, messageCount: 2 } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/, (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')
    const filtered = conversations.filter((conversation) => state === 'all' || (state === 'unread' ? conversation.unread : !conversation.unread))
    return route.fulfill({ json: { source: 'demo', conversations: filtered } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(.+)/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split('/').pop()
    const summary = conversations.find((conversation) => conversation.threadId === threadId) ?? conversations[0]!
    const message = { ...messages.find((item) => item.threadId === summary.threadId)!, source: 'demo', body: { kind: 'sanitized-html', content: '<p>Hello <strong>Steve</strong>.</p><blockquote>Earlier message</blockquote><script>window.attacked=true</script>' }, attachments: [] }
    const threadMessages = summary.threadId === 't1'
      ? [{ ...message, id: 'm0', receivedAt: '2026-09-03T07:30:00+12:00', receivedLabel: 'Sep 3, 7:30 AM', receivedFullLabel: 'September 3, 2026 at 7:30 AM' }, message]
      : [message]
    return route.fulfill({ json: { conversation: { ...summary, messageCount: threadMessages.length, source: 'demo', messages: threadMessages } } })
  })
  await page.route('http://127.0.0.1:8411/v1/drafts', (route) => route.fulfill({ status: 201, json: { draft: { id: 'd1', inReplyToMessageId: 'm1', to: [messages[0]!.sender], subject: 'Re: Opua berth confirmation', bodyText: 'Thanks.', state: 'draft' } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts/preview', async (route) => {
    const request = await route.request().postDataJSON() as { bodyMarkdown: string }
    await route.fulfill({ json: { bodyHtml: `<p>${request.bodyMarkdown}</p>` } })
  })
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ status: 503, json: { status: 'not_ready' } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/recipients/, (route) => route.fulfill({ json: { recipients: [] } }))
})

test('captures the public synthetic-mail screenshot', async ({ page }) => {
  test.skip(process.env.CAPTURE_PUBLIC_SCREENSHOT !== '1', 'Run only when refreshing the public README screenshot')
  await stubAgent(page)
  await page.route('http://127.0.0.1:8412/v1/models', route => route.fulfill({ json: {
    defaults: { model: 'gpt-5.6-sol', effort: 'medium' },
    rateLimitsError: null,
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high'], exhausted: false, resetsAt: null },
    ],
  } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/[^/]+$/, route => (
    route.request().method() === 'GET'
      ? route.fulfill({ json: {
        thread: { turns: [{ items: [{ type: 'agentMessage', text: 'The marina confirmed the berth for September 4. No reply is required.' }] }] },
      } })
      : route.fallback()
  ))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await page.evaluate(() => {
    const state = document.querySelector<HTMLElement>('[data-agent-state-text]')
    if (state) state.style.display = 'none'
    const status = document.querySelector<HTMLElement>('[data-agent-status]')
    if (status) {
      status.dataset.status = 'Connected'
      status.title = 'Connected'
      status.setAttribute('aria-label', 'Connected')
      status.style.background = 'var(--tblr-green)'
    }
  })
  const assets = resolve(import.meta.dirname, '../../../docs/assets')
  await mkdir(assets, { recursive: true })
  await page.screenshot({ path: resolve(assets, 'dispatch-screenshot.png') })
})

test('new compose has its own task and never opens the general history', async ({ page }) => {
  await stubAgent(page)
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.locator('[data-agent-stream]')).toContainText('History for thread-draft%3A')
  const first = await page.locator('[data-agent-stream]').innerText()
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.locator('[data-agent-stream]')).toContainText('History for thread-draft%3A')
  await expect.poll(() => page.locator('[data-agent-stream]').innerText()).not.toBe(first)
  await expect(page.locator('[data-agent-stream]')).not.toContainText('History for thread-unbound')
})

test('a sync heartbeat in an empty mailbox cannot close the active compose editor', async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [], total: 0 } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByLabel('Draft subject').fill('Keep this editor open')
  await page.waitForTimeout(5_500)
  await expect(page.getByLabel('Draft subject')).toBeVisible()
  await expect(page.getByLabel('Draft subject')).toHaveValue('Keep this editor open')
})

test('renders the three-panel mail surface and sanitizes provider HTML', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible()
  await expect(page.locator('.dispatch-toolbar')).toBeVisible()
  await expect(page.locator('.dispatch-titlebar')).toHaveCount(0)
  await expect(page.locator('.dispatch-statusbar')).toHaveCount(0)
  await expect(page.getByText('Dispatch', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Codex' })).toBeVisible()
  await expect(page.locator('[data-model-toggle]')).toHaveText('Model')
  await expect(page.getByText('GPT-5.6 Sol · Medium')).toHaveCount(0)
  await expect(page.locator('[data-context]')).toHaveCount(0)
  await expect(page.locator('.dispatch-agent > header')).toHaveCount(0)
  await expect(page.locator('.dispatch-agent > footer [data-model-toggle]')).toBeVisible()
  await expect(page.locator('[data-conversation-id="demo:t1"] time')).toHaveText('Sep 4, 9:42 AM')
  await expect(page.locator('[data-body] script')).toHaveCount(0)
  await expect(page.locator('.dispatch-thread-message')).toHaveCount(2)
  await expect(page.locator('.dispatch-thread-message.dispatch-thread-collapsed')).toHaveCount(1)
  await expect(page.getByText('Quoted history')).toHaveCount(1)
  await page.locator('.dispatch-thread-message.dispatch-thread-collapsed').click()
  await expect(page.getByText('Quoted history')).toHaveCount(2)
  await expect(page.locator('[data-thread-meta]')).toContainText('2 messages')
  await expect(page.locator('.dispatch-reader-header .subheader')).toHaveCount(0)
  await expect(page.locator('.dispatch-reader-actions')).toHaveCount(0)
  await expect(page.locator('.dispatch-thread-message time').first()).toHaveText('September 4, 2026 at 9:42 AM')
  await expect(page.locator('[data-agent-status]')).toHaveAttribute('data-status', 'Reconnecting')
  await expect(page.locator('[data-agent-status]')).toHaveAttribute('title', 'Waiting for Codex App Server')
  await expect(page.locator('[data-agent-status]')).toHaveAttribute('aria-label', 'Waiting for Codex App Server')
})

test('opens folders from the toolbar popover and keeps the account scope in the toolbar', async ({ page }) => {
  await page.goto('/')
  const folder = page.locator('[data-folder-toggle]')
  await expect(folder).toHaveText('Inbox')
  await expect(page.locator('[data-folder-menu]')).toBeHidden()
  await folder.click()
  await expect(page.locator('[data-folder-menu]')).toBeVisible()
  await page.locator('[data-folder-menu] [data-mailbox="sent"]').click()
  await expect(page.locator('[data-folder-menu]')).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Sent' })).toBeVisible()
  await expect(page.locator('.dispatch-toolbar').getByRole('combobox', { name: 'Gmail account' })).toBeVisible()
  await expect(page.locator('.dispatch-toolbar').getByRole('textbox', { name: 'Search mail' })).toBeVisible()
  await page.keyboard.press('Meta+k')
  await expect(page.getByRole('textbox', { name: 'Search mail' })).toBeFocused()
  await expect(page.locator('.dispatch-toolbar [data-panel]')).toHaveCount(3)
})

test('shows a live Tabler activity indicator while Codex is working', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const status = document.querySelector('[data-agent-status]')
    if (!status) return
    status.setAttribute('data-status', 'Working')
    status.setAttribute('title', 'Working')
    status.setAttribute('aria-label', 'Working')
  })
  await expect(page.locator('[data-agent-activity]')).toBeVisible()
  await page.evaluate(() => {
    const status = document.querySelector('[data-agent-status]')
    if (!status) return
    status.setAttribute('data-status', 'Connected')
    status.setAttribute('title', 'Connected')
    status.setAttribute('aria-label', 'Connected')
  })
  await expect(page.locator('[data-agent-activity]')).toBeHidden()
})

test('changes selection and opens a mail-service-owned draft', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.getByRole('heading', { name: 'Services agreement' })).toBeVisible()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveValue('Thanks.')
})

test('renders a connector-selected Gmail account without trusting list markup', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const hostile = {
    ...conversations[0]!,
    sender: { name: '<img src=x onerror=window.attacked=true>', address: 'sender@example.com', initials: 'X' },
    subject: '<script>window.attacked=true</script>',
    accountId: 'link-one',
    accountLabel: 'work@example.com',
  }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', scope: 'unified', conversations: [hostile] } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...hostile, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'sanitized-html', content: '<p>Safe body</p>' }, attachments: [] }] } } }))
  await page.goto('/')
  await expect(page.locator('[data-mail-source]')).toHaveText(/^(Gmail connected|Gmail synced) · /)
  await expect(page.getByRole('combobox', { name: 'Gmail account' })).toHaveValue('')
  await expect(page.getByRole('combobox', { name: 'Gmail account' }).locator('option').first()).toHaveText('All inboxes (1)')
  await expect(page.locator('[data-message-list] img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as Window & { attacked?: boolean }).attacked)).not.toBe(true)
})

test('navigates native Gmail folders and routes accepted message actions', async ({ page }) => {
  let requestedMailbox = ''
  let action: unknown
  let releaseAction!: () => void
  const actionGate = new Promise<void>((resolve) => { releaseAction = resolve })
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  const nextSummary = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?.*/, (route) => {
    requestedMailbox = new URL(route.request().url()).searchParams.get('mailbox') ?? ''
    return route.fulfill({ json: { source: 'gmail', conversations: [summary, nextSummary], nextCursor: null, total: 2 } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...nextSummary, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Next body' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/actions', async (route) => {
    action = await route.request().postDataJSON()
    await actionGate
    await route.fulfill({ status: 202, json: { accepted: true } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Sent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sent' })).toBeVisible()
  await expect.poll(() => requestedMailbox).toBe('sent')
  await page.getByRole('button', { name: 'Inbox', exact: true }).click()
  await page.locator('[data-archive]').click()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveCount(0)
  await expect.poll(() => action).toEqual({ accountId: 'link-one', messageIds: ['m1'], action: 'archive' })
  await expect(page.getByRole('heading', { name: 'Services agreement' })).toBeVisible()
  await expect(page.locator('[data-trash]')).toBeEnabled()
  releaseAction()
  await expect(page.getByRole('heading', { name: 'Services agreement' })).toBeVisible()
})

function gmailInbox(page: Page, count: number): { summaries: Array<typeof conversations[number] & { accountId: string; accountLabel: string }>; actions: Array<{ threadId: string; body: Record<string, unknown> }> } {
  const summaries = Array.from({ length: count }, (_, index) => ({
    ...conversations[index % conversations.length]!,
    id: `gmail:link-one:t${index + 1}`,
    threadId: `t${index + 1}`,
    subject: `Thread ${index + 1}`,
    unread: false,
    accountId: 'link-one',
    accountLabel: 'work@example.com',
  }))
  const actions: Array<{ threadId: string; body: Record<string, unknown> }> = []
  return { summaries, actions }
}

async function routeGmailInbox(page: Page, fixture: ReturnType<typeof gmailInbox>): Promise<void> {
  const location = (threadId: string): string => {
    let where = 'inbox'
    for (const item of fixture.actions.filter((entry) => entry.threadId === threadId)) where = String(item.body.action)
    return where
  }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?.*/, (route) => {
    const wanted = new URL(route.request().url()).searchParams.get('mailbox') ?? 'inbox'
    const listed = fixture.summaries.filter((summary) => location(summary.threadId) === wanted)
    return route.fulfill({ json: { source: 'gmail', conversations: listed, nextCursor: null, total: listed.length } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(t\d+)\?account=link-one/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split('/').pop()
    const summary = fixture.summaries.find((item) => item.threadId === threadId)!
    return route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, id: `${threadId}-m1`, threadId, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: `Body ${threadId}` }, attachments: [] }] } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(t\d+)\/actions/, async (route) => {
    const threadId = new URL(route.request().url()).pathname.split('/')[3]!
    fixture.actions.push({ threadId, body: await route.request().postDataJSON() })
    await route.fulfill({ status: 202, json: { accepted: true } })
  })
}

test('shift-click selects a range and the toolbar archives every selected conversation', async ({ page }) => {
  const fixture = gmailInbox(page, 4)
  await routeGmailInbox(page, fixture)
  await page.goto('/')
  await page.locator('[data-conversation-id="gmail:link-one:t2"]').click()
  await page.locator('[data-conversation-id="gmail:link-one:t4"]').click({ modifiers: ['Shift'] })
  await expect(page.locator('.dispatch-message[aria-selected="true"]')).toHaveCount(3)
  await expect(page.locator('[data-subject]')).toHaveText('3 conversations selected')
  await expect(page.locator('[data-reply]')).toBeHidden()
  await expect(page.locator('[data-archive]')).toBeVisible()
  await page.locator('[data-conversation-id="gmail:link-one:t2"]').click({ modifiers: ['Meta'] })
  await expect(page.locator('.dispatch-message[aria-selected="true"]')).toHaveCount(2)
  await expect(page.locator('[data-subject]')).toHaveText('2 conversations selected')
  await page.locator('[data-archive]').click()
  await expect(page.locator('[data-conversation-id="gmail:link-one:t3"]')).toHaveCount(0)
  await expect(page.locator('[data-conversation-id="gmail:link-one:t4"]')).toHaveCount(0)
  await expect.poll(() => fixture.actions.map((item) => item.threadId).sort()).toEqual(['t3', 't4'])
  expect(fixture.actions.every((item) => item.body.action === 'archive' && item.body.accountId === 'link-one')).toBe(true)
  await expect(page.locator('[data-subject]')).toHaveText('Thread 2')
})

test('dragging selected conversations onto a rail folder moves them', async ({ page }) => {
  const fixture = gmailInbox(page, 3)
  await routeGmailInbox(page, fixture)
  await page.goto('/')
  if (await page.locator('.dispatch-rail').isHidden()) await page.getByRole('button', { name: 'Show mailboxes' }).click()
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').click()
  await page.locator('[data-conversation-id="gmail:link-one:t2"]').click({ modifiers: ['Shift'] })
  const target = page.locator('.dispatch-rail [data-mailbox="trash"]')
  await page.locator('[data-conversation-id="gmail:link-one:t2"]').dragTo(target)
  await expect.poll(() => fixture.actions.map((item) => item.threadId).sort()).toEqual(['t1', 't2'])
  expect(fixture.actions.every((item) => item.body.action === 'trash')).toBe(true)
  await expect(page.locator('[data-conversation-id="gmail:link-one:t1"]')).toHaveCount(0)
  await expect(page.locator('[data-subject]')).toHaveText('Thread 3')
  await expect(page.locator('.dispatch-drop-target')).toHaveCount(0)
})

test('a drop onto the current folder or Sent is refused', async ({ page }) => {
  const fixture = gmailInbox(page, 2)
  await routeGmailInbox(page, fixture)
  await page.goto('/')
  if (await page.locator('.dispatch-rail').isHidden()) await page.getByRole('button', { name: 'Show mailboxes' }).click()
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').dragTo(page.locator('.dispatch-rail [data-mailbox="inbox"]'))
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').dragTo(page.locator('.dispatch-rail [data-mailbox="sent"]'))
  await page.waitForTimeout(300)
  expect(fixture.actions).toEqual([])
  await expect(page.locator('[data-conversation-id="gmail:link-one:t1"]')).toHaveCount(1)
})

test('a multi-selection context menu offers folder actions for the whole selection', async ({ page }) => {
  const fixture = gmailInbox(page, 3)
  await routeGmailInbox(page, fixture)
  await page.goto('/')
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').click()
  await page.locator('[data-conversation-id="gmail:link-one:t3"]').click({ modifiers: ['Meta'] })
  await page.locator('[data-conversation-id="gmail:link-one:t3"]').click({ button: 'right' })
  const menu = page.locator('[data-thread-context-menu]')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText(['Archive', 'Mark as Spam', 'Move to Trash'])
  await menu.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect.poll(() => fixture.actions.map((item) => item.threadId).sort()).toEqual(['t1', 't3'])
  await expect(page.locator('[data-subject]')).toHaveText('Thread 2')
})

test('arrow keys move the selection and shift extends it', async ({ page }) => {
  const fixture = gmailInbox(page, 4)
  await routeGmailInbox(page, fixture)
  await page.goto('/')
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').click()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-subject]')).toHaveText('Thread 2')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.dispatch-message[aria-selected="true"]')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-subject]')).toHaveText('Thread 2')
  await page.keyboard.press('Meta+a')
  await expect(page.locator('[data-subject]')).toHaveText('4 conversations selected')
})

test('Delete and Backspace move the selection to Trash unless a field has focus', async ({ page }) => {
  const fixture = gmailInbox(page, 3)
  await routeGmailInbox(page, fixture)
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('keep me')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Delete')
  await expect(page.getByRole('textbox', { name: 'Ask Codex' })).toHaveValue('keep m')
  expect(fixture.actions).toEqual([])
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').click()
  await page.keyboard.press('Delete')
  await expect.poll(() => fixture.actions.map((item) => `${item.threadId}:${item.body.action}`)).toEqual(['t1:trash'])
  await expect(page.locator('[data-subject]')).toHaveText('Thread 2')
  await page.locator('[data-conversation-id="gmail:link-one:t3"]').click({ modifiers: ['Shift'] })
  await page.keyboard.press('Backspace')
  await expect.poll(() => fixture.actions.map((item) => item.threadId).sort()).toEqual(['t1', 't2', 't3'])
  await expect(page.locator('.dispatch-message')).toHaveCount(0)
})

test('the Delete key in Trash explains that permanent delete is unavailable', async ({ page }) => {
  const fixture = gmailInbox(page, 2)
  fixture.actions.push({ threadId: 't1', body: { action: 'trash' } })
  await routeGmailInbox(page, fixture)
  await page.goto('/')
  await page.getByRole('button', { name: 'Trash', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible()
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-mail-error]')).toHaveText(/Empty the trash in Gmail/)
  expect(fixture.actions).toHaveLength(1)
  await expect(page.locator('[data-conversation-id="gmail:link-one:t1"]')).toHaveCount(1)
})

test('a move shows an undo toast that puts the conversations back', async ({ page }) => {
  const fixture = gmailInbox(page, 4)
  await routeGmailInbox(page, fixture)
  await page.goto('/')
  await page.locator('[data-conversation-id="gmail:link-one:t2"]').click()
  await page.locator('[data-conversation-id="gmail:link-one:t3"]').click({ modifiers: ['Shift'] })
  await page.locator('[data-archive]').click()
  const toast = page.locator('[data-undo-toast]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('Archived 2 conversations')
  await expect(page.locator('[data-conversation-id="gmail:link-one:t2"]')).toHaveCount(0)
  await page.locator('[data-undo]').click()
  await expect(toast).toBeHidden()
  await expect.poll(() => fixture.actions.filter((item) => item.body.action === 'inbox').map((item) => item.threadId).sort()).toEqual(['t2', 't3'])
  await expect(page.locator('.dispatch-message')).toHaveText([/Thread 1/, /Thread 2/, /Thread 3/, /Thread 4/])
})

test('Cmd-Z undoes the last move while the toast is showing and the toast times out', async ({ page }) => {
  const fixture = gmailInbox(page, 2)
  await routeGmailInbox(page, fixture)
  await page.clock.install()
  await page.goto('/')
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').click()
  await page.keyboard.press('Delete')
  const toast = page.locator('[data-undo-toast]')
  await expect(toast).toContainText('Moved 1 conversation to Trash')
  await page.keyboard.press('Meta+z')
  await expect(toast).toBeHidden()
  await expect.poll(() => fixture.actions.map((item) => `${item.threadId}:${item.body.action}`)).toEqual(['t1:trash', 't1:inbox'])
  await expect(page.locator('[data-conversation-id="gmail:link-one:t1"]')).toHaveCount(1)
  await page.locator('[data-conversation-id="gmail:link-one:t2"]').click()
  await page.locator('[data-trash]').click()
  await expect(toast).toBeVisible()
  await page.clock.fastForward(7000)
  await expect(toast).toBeHidden()
  await page.keyboard.press('Meta+z')
  await page.clock.fastForward(500)
  expect(fixture.actions.filter((item) => item.threadId === 't2')).toHaveLength(1)
})

test('the rail and folder menu show unread and folder counts', async ({ page }) => {
  let counts = { inbox: 12, drafts: 2, spam: 140 }
  await page.route(/8411\/v1\/mailboxes\/counts/, (route) => route.fulfill({ json: { source: 'gmail', counts } }))
  await page.goto('/')
  const rail = page.locator('.dispatch-rail')
  if (await rail.isHidden()) await page.getByRole('button', { name: 'Show mailboxes' }).click()
  await expect(rail.locator('[data-mailbox-count="inbox"]')).toHaveText('12')
  await expect(rail.locator('[data-mailbox-count="inbox"]')).toHaveClass(/dispatch-mailbox-count-unread/)
  await expect(rail.locator('[data-mailbox-count="drafts"]')).toHaveText('2')
  await expect(rail.locator('[data-mailbox-count="spam"]')).toHaveText('99+')
  await expect(rail.locator('[data-mailbox="sent"] .dispatch-mailbox-count')).toHaveCount(0)
  await page.locator('[data-folder-toggle]').click()
  await expect(page.locator('[data-folder-menu] [data-mailbox-count="inbox"]')).toHaveText('12')
  counts = { inbox: 0, drafts: 2, spam: 0 }
  await page.locator('[data-refresh]').click()
  await expect(rail.locator('[data-mailbox-count="inbox"]')).toBeHidden()
  await expect(rail.locator('[data-mailbox-count="spam"]')).toBeHidden()
})

test('Dock badge shows unread Inbox conversations across all accounts', async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as Window & {
      dockBadges?: Array<number | undefined>
      __TAURI__?: { window: { getCurrentWindow(): { setBadgeCount(count?: number): Promise<void> } } }
    }
    win.dockBadges = []
    win.__TAURI__ = { window: { getCurrentWindow: () => ({ setBadgeCount: async count => { win.dockBadges!.push(count) } }) } }
  })
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.unroute(/8411\/v1\/mailboxes\/counts/)
  let globalUnread = 7
  let accountUnread = 2
  await page.route(/8411\/v1\/mailboxes\/counts/, route => {
    const scoped = new URL(route.request().url()).searchParams.get('account') === 'link-one'
    return route.fulfill({ json: { source: 'gmail', counts: { inbox: scoped ? accountUnread : globalUnread, drafts: 0, spam: 0 } } })
  })
  await page.goto('/')
  const badgeCalls = () => page.evaluate(() => JSON.stringify((window as Window & { dockBadges?: Array<number | undefined> }).dockBadges))
  await expect.poll(badgeCalls).toContain('7')
  await page.locator('[data-account]').selectOption('link-one')
  await expect(page.locator('.dispatch-rail [data-mailbox-count="inbox"]')).toHaveText('2')
  await expect.poll(badgeCalls).toMatch(/7\]$/)
  globalUnread = 0
  accountUnread = 0
  await page.locator('[data-refresh]').click()
  await expect.poll(badgeCalls).toMatch(/null\]$/)
})

test('single-letter shortcuts act on the selected conversation and G chords switch folders', async ({ page }) => {
  const fixture = gmailInbox(page, 3)
  await routeGmailInbox(page, fixture)
  let requestedMailbox = ''
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?.*/, (route) => { requestedMailbox = new URL(route.request().url()).searchParams.get('mailbox') ?? ''; return route.fallback() })
  await page.goto('/')
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').click()
  await page.keyboard.press('j')
  await expect(page.locator('[data-subject]')).toHaveText('Thread 2')
  await page.keyboard.press('k')
  await expect(page.locator('[data-subject]')).toHaveText('Thread 1')
  await page.keyboard.press('e')
  await expect.poll(() => fixture.actions.map((item) => `${item.threadId}:${item.body.action}`)).toEqual(['t1:archive'])
  await expect(page.locator('[data-subject]')).toHaveText('Thread 2')
  await page.keyboard.press('#')
  await expect.poll(() => fixture.actions.map((item) => `${item.threadId}:${item.body.action}`)).toEqual(['t1:archive', 't2:trash'])
  await page.keyboard.press('g')
  await page.keyboard.press('t')
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible()
  await expect.poll(() => requestedMailbox).toBe('trash')
  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('')
  await page.getByRole('textbox', { name: 'Ask Codex' }).press('e')
  await page.getByRole('textbox', { name: 'Ask Codex' }).press('c')
  await expect(page.getByRole('textbox', { name: 'Ask Codex' })).toHaveValue('ec')
  expect(fixture.actions).toHaveLength(2)
})

test('? opens the shortcut sheet and toolbar buttons carry their key', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await expect(page.locator('.dispatch-reader-toolbar [data-archive]')).toHaveAttribute('data-shortcut', 'E')
  await expect(page.locator('.dispatch-reader-toolbar [data-reply-all]')).toHaveAttribute('data-shortcut', 'A')
  await page.keyboard.press('?')
  const dialog = page.locator('[data-shortcuts-dialog]')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Move to Trash')
  await expect(dialog).toContainText('G then I / S / D / A / T')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.keyboard.press('c')
  await expect(page.locator('.dispatch-agent-error').last()).toContainText('Connect a Gmail account before composing mail.')
})

test('the reader labels only downloaded copies, not live Gmail messages', async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [
    { id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' },
    { id: 'link-two', connectorId: 'gmail-app', name: 'Home', email: 'home@example.com' },
  ] } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?.*/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [
    { ...conversations[0]!, id: 'gmail:link-one:t1', accountId: 'link-one', accountLabel: 'work@example.com', messageCount: 2 },
    { ...conversations[1]!, id: 'gmail:link-one:t2', accountId: 'link-one', accountLabel: 'work@example.com', messageCount: 1 },
  ], nextCursor: null, total: 2 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', source: 'gmail', availability: { mode: 'live', cachedAt: '2026-09-17T07:37:06Z' }, messages: [
    { ...messages[0]!, id: 'm0', accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'First' }, attachments: [] },
    { ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Second' }, attachments: [] },
  ] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com', source: 'gmail', availability: { mode: 'downloaded', cachedAt: '2026-09-17T07:37:06Z', reason: 'Gmail is unavailable' }, messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Only' }, attachments: [] }] } } }))
  await page.goto('/')
  await page.locator('[data-conversation-id="gmail:link-one:t1"]').click()
  const meta = page.locator('[data-thread-meta]')
  await expect(meta).toHaveText(/work@example\.com\s*·\s*Inbox\s*·\s*2 messages/)
  await expect(page.locator('[data-copy-status]')).toBeHidden()
  await expect(meta).not.toContainText('Offline')
  await page.locator('[data-conversation-id="gmail:link-one:t2"]').click()
  await expect(meta).not.toContainText('message')
  await expect(page.locator('[data-copy-status]')).toBeVisible()
  await expect(page.locator('[data-copy-status]')).toHaveText(/Downloaded copy/)
  await expect(page.locator('[data-copy-status]')).toHaveAttribute('data-mode', 'downloaded')
  await expect(page.locator('[data-copy-status]')).toHaveAttribute('title', /Gmail is unavailable/)
})

test('previews a new compose draft with account, Cc, and Bcc before saving', async ({ page }) => {
  let draftRequest: unknown
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', async (route) => {
    draftRequest = await route.request().postDataJSON()
    await route.fulfill({ status: 201, json: { draft: { id: 'compose-1', inReplyToMessageId: '', to: [{ name: 'client@example.com', address: 'client@example.com', initials: '@' }], cc: 'cc@example.com', bcc: 'audit@example.com', subject: 'Project update', bodyText: 'Draft preview', state: 'draft', accountId: 'link-one' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await expect(page.getByRole('heading', { name: 'New message' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Draft account' })).toHaveValue('link-one')
  await page.getByRole('textbox', { name: 'Draft recipient' }).fill('client@example.com')
  await page.getByRole('textbox', { name: 'Draft Cc' }).fill('cc@example.com')
  await page.getByRole('textbox', { name: 'Draft Bcc' }).fill('audit@example.com')
  await page.getByRole('textbox', { name: 'Draft subject' }).fill('Project update')
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Draft preview')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect.poll(() => draftRequest).toEqual({ messageId: '', clientDraftId: expect.any(String), accountId: 'link-one', to: 'client@example.com', cc: 'cc@example.com', bcc: 'audit@example.com', subject: 'Project update', bodyMarkdown: 'Draft preview', bodyText: 'Draft preview', attachments: [] })
})

test('autosaves each saved-draft header and keeps the account locked', async ({ page }) => {
  const updates: Record<string, unknown>[] = []
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', (route) => route.fulfill({ status: 201, json: { draft: {
    id: 'autosave-1', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: '', bodyMarkdown: '', bodyHtml: '<p></p>', bodyText: '', attachments: [], state: 'draft', accountId: 'link-one',
  } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts/autosave-1', async (route) => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    updates.push(fields)
    await route.fulfill({ json: { draft: {
      id: 'autosave-1', inReplyToMessageId: '', to: [], cc: fields.cc, bcc: fields.bcc, subject: fields.subject,
      bodyMarkdown: fields.bodyMarkdown, bodyHtml: '<p></p>', bodyText: fields.bodyText, attachments: [], state: 'draft', accountId: 'link-one',
    } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByRole('combobox', { name: 'Draft account' })).toBeDisabled()

  const changes: Array<[string, string, string]> = [
    ['Draft recipient', 'client@example.com', 'to'],
    ['Draft Cc', 'copy@example.com', 'cc'],
    ['Draft Bcc', 'audit@example.com', 'bcc'],
    ['Draft subject', 'Updated subject', 'subject'],
  ]
  for (const [name, value, field] of changes) {
    const count = updates.length
    await page.getByRole('textbox', { name }).fill(value)
    await expect.poll(() => updates.length).toBe(count + 1)
    expect(updates.at(-1)?.[field]).toBe(value)
  }
})

test('saves a new draft before asking Codex to revise its real Gmail draft ID', async ({ page }) => {
  let turnRequest: Record<string, unknown> | undefined
  const operationOrder: string[] = []
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', (route) => route.fulfill({ status: 201, json: { draft: {
    id: 'gmail-draft-42', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Plan', bodyMarkdown: 'Original',
    bodyHtml: '<p>Original</p>', bodyText: 'Original', attachments: [], state: 'draft', accountId: 'link-one',
  } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts/gmail-draft-42', async (route) => {
    operationOrder.push('update')
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { draft: {
      id: 'gmail-draft-42', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Plan',
      bodyMarkdown: fields.bodyMarkdown, bodyHtml: '<p>Revised locally</p>', bodyText: fields.bodyText,
      attachments: [], state: 'draft', accountId: 'link-one',
    } } })
  })
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [{ id: 'gmail', name: 'Gmail', isAccessible: true, isEnabled: true }] } }))
  await page.route('http://127.0.0.1:8412/v1/threads', (route) => route.fulfill({ status: 201, json: { thread: { id: 'thread-revise' } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-revise', created: false, replaced: false } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/thread-revise$/, (route) => route.fulfill({ json: { thread: { turns: [] } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/thread-revise/turns', async (route) => {
    operationOrder.push('turn')
    turnRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { turn: { id: 'turn-1' } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.goto('/')
  await expect(page.locator('[data-connector]')).toHaveAttribute('title', 'Gmail available')
  await expect(page.locator('[data-connector]')).toHaveAttribute('data-ready', 'true')
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByRole('textbox', { name: 'Draft subject' }).fill('Plan')
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Original')
  await page.getByRole('button', { name: 'Ask Codex to revise' }).click()

  await expect.poll(() => turnRequest).toBeDefined()
  const text = String(turnRequest?.text)
  expect(text).toContain('gmail-draft-42')
  expect(text).toContain('link-one')
  expect(text).toContain('update_draft')
  expect(text).toContain('multipart/alternative')
  expect(text).not.toContain('text_plain')
  expect(text).toContain('payload')
  expect(text).not.toContain('Never send')
  expect(text).not.toContain('Never call gmail.send')

  operationOrder.length = 0
  turnRequest = undefined
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Revised locally')
  await page.getByRole('button', { name: 'Ask Codex to revise' }).click()
  await expect.poll(() => operationOrder).toEqual(['update', 'turn'])
})

test('picks Luna Reserve when Sol has hit its usage limit and sends it with the next turn', async ({ page }) => {
  const turns: Record<string, unknown>[] = []
  let catalogReads = 0
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads', (route) => route.fulfill({ status: 201, json: { thread: { id: 'thread-model' } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-model', created: false, replaced: false } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/thread-model$/, (route) => route.fulfill({ json: { thread: { turns: [] } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/thread-model/turns', async (route) => {
    turns.push(await route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 202, json: { turn: { id: `turn-${turns.length}` } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.route('http://127.0.0.1:8412/v1/models', (route) => {
    catalogReads += 1
    return route.fulfill({ json: {
      defaults: { model: 'gpt-5.6-sol', effort: 'medium' },
      rateLimitsError: null,
      models: [
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], exhausted: true, resetsAt: 1788754468 },
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], exhausted: true, resetsAt: 1788754468 },
        { id: 'gpt-reserve', label: 'Luna Reserve', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], exhausted: false, resetsAt: 1789252467 },
      ],
    } })
  })
  await page.goto('/')
  await expect(page.locator('[data-connector]')).toHaveAttribute('title', 'No Gmail connector')
  await expect(page.locator('[data-connector]')).toHaveAttribute('data-ready', 'false')
  const toggle = page.locator('[data-model-toggle]')
  await expect(toggle).toHaveText('GPT-5.6 Sol · Medium')
  await expect(toggle).toHaveClass(/bg-yellow-lt/)
  await expect(page.locator('[data-model-menu]')).toBeHidden()

  await toggle.click()
  const menu = page.locator('[data-model-menu]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-model-summary]')).toContainText('GPT-5.6 Sol has reached its usage limit')
  await expect(menu.locator('[data-model-id="gpt-5.6-sol"]')).toBeDisabled()
  await expect(menu.locator('[data-model-id="gpt-5.6-sol"]')).toContainText('Limit reached · resets')
  await expect(menu.locator('[data-model-id="gpt-reserve"]')).toBeEnabled()
  await expect(menu.locator('[data-effort="ultra"]')).toBeVisible()
  expect(page.getByText('Full reset')).toHaveCount(0)

  await menu.locator('[data-model-id="gpt-reserve"]').click()
  await expect(menu.locator('[data-model-id="gpt-reserve"]')).toHaveAttribute('aria-checked', 'true')
  await expect(menu.locator('[data-effort="ultra"]')).toHaveCount(0)
  await menu.locator('[data-effort="max"]').click()
  await expect(toggle).toHaveText('Luna Reserve · Max')
  await expect(toggle).toHaveClass(/bg-blue-lt/)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Summarize this thread.')
  await page.keyboard.press('Enter')
  await expect.poll(() => turns.length).toBe(1)
  expect(turns[0]).toMatchObject({ text: 'Summarize this thread.', model: 'gpt-reserve', effort: 'max' })

  await page.reload()
  await expect(page.locator('[data-model-toggle]')).toHaveText('Luna Reserve · Max')
  expect(catalogReads).toBeGreaterThan(0)
})

test('tells the user the model list needs Codex when the agent is down', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-agent-status]')).toHaveAttribute('data-status', 'Reconnecting')
  await expect(page.locator('[data-model-toggle]')).toHaveText('Model')
  await page.locator('[data-model-toggle]').click()
  await expect(page.locator('[data-model-summary]')).toHaveText('Codex not connected')
  await expect(page.locator('[data-model-id="gpt-5.6-sol"]')).toHaveCount(0)
})

test('shows the Codex config default without pinning the next turn', async ({ page }) => {
  const turns: Record<string, unknown>[] = []
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads', (route) => route.fulfill({ status: 201, json: { thread: { id: 'thread-config' } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-config', created: false, replaced: false } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/thread-config$/, (route) => route.fulfill({ json: { thread: { turns: [] } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/thread-config/turns', async (route) => {
    turns.push(await route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 202, json: { turn: { id: `turn-${turns.length}` } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.route('http://127.0.0.1:8412/v1/models', (route) => route.fulfill({ json: {
    defaults: { model: 'gpt-6-astra', effort: 'xhigh' },
    rateLimitsError: null,
    models: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['medium', 'xhigh'], exhausted: false, resetsAt: null },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high'], exhausted: false, resetsAt: null },
    ],
  } }))
  await page.goto('/')
  const toggle = page.locator('[data-model-toggle]')
  await expect(toggle).toHaveText('GPT-6 Astra · Extra high')
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Use my Codex default.')
  await page.keyboard.press('Enter')
  await expect.poll(() => turns.length).toBe(1)
  expect(turns[0]).toMatchObject({ text: 'Use my Codex default.' })
  expect(turns[0]).not.toHaveProperty('model')
  expect(turns[0]).not.toHaveProperty('effort')

  await toggle.click()
  await page.locator('[data-model-id="gpt-5.6-sol"]').click()
  await page.locator('[data-effort="medium"]').click()
  await page.keyboard.press('Escape')
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Use Sol this turn.')
  await page.keyboard.press('Enter')
  await expect.poll(() => turns.length).toBe(2)
  expect(turns[1]).toMatchObject({ text: 'Use Sol this turn.', model: 'gpt-5.6-sol', effort: 'medium' })
})

test('does not ask Codex to revise when Gmail does not return a draft ID', async ({ page }) => {
  let turnCount = 0
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', (route) => route.fulfill({ status: 201, json: { draft: {
    id: '', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: '', bodyMarkdown: '', bodyHtml: '<p></p>',
    bodyText: '', attachments: [], state: 'draft', accountId: 'link-one',
  } } }))
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [{ id: 'gmail', name: 'Gmail', isAccessible: true, isEnabled: true }] } }))
  await page.route('http://127.0.0.1:8412/v1/threads', (route) => route.fulfill({ status: 201, json: { thread: { id: 'thread-no-id' } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-no-id', created: false, replaced: false } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/thread-no-id$/, (route) => route.fulfill({ json: { thread: { turns: [] } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/thread-no-id/turns', async (route) => {
    turnCount += 1
    await route.fulfill({ status: 202, json: {} })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.goto('/')
  await expect(page.locator('[data-connector]')).toHaveAttribute('title', 'Gmail available')
  await expect(page.locator('[data-connector]')).toHaveAttribute('data-ready', 'true')
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByRole('button', { name: 'Ask Codex to revise' }).click()

  await expect(page.locator('[data-draft-error]')).toContainText('did not return a draft ID')
  expect(turnCount).toBe(0)
})

test('creates a threaded reply-all draft without addressing the active account', async ({ page }) => {
  let draftRequest: Record<string, unknown> | undefined
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all.*/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', to: [{ name: 'Work', address: 'work@example.com', initials: 'W' }, { name: 'Colleague', address: 'colleague@example.com', initials: 'C' }], cc: [{ name: 'Manager', address: 'manager@example.com', initials: 'M' }], body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', async (route) => {
    draftRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 201, json: { draft: { id: 'reply-all-1', inReplyToMessageId: 'm1', to: [], cc: draftRequest.cc, bcc: '', subject: 'Re: Opua berth confirmation', bodyText: '', state: 'draft', accountId: 'link-one' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Reply all' }).click()
  await expect.poll(() => draftRequest).toMatchObject({ messageId: 'm1', accountId: 'link-one', to: 'ana@example.com, colleague@example.com', cc: 'manager@example.com', bcc: '' })
})

test('uses the newest message for a reply-all draft', async ({ page }) => {
  let draftRequest: Record<string, unknown> | undefined
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const newest = {
    ...messages[0]!,
    id: 'newest-message',
    accountId: 'link-one',
    source: 'gmail',
    sender: { name: 'Newest Sender', address: 'newest@example.com', initials: 'NS' },
    to: [{ name: 'Work', address: 'work@example.com', initials: 'W' }],
    body: { kind: 'plain-text', content: 'Newest words' },
    attachments: [],
  }
  const oldest = {
    ...messages[0]!,
    id: 'oldest-message',
    accountId: 'link-one',
    source: 'gmail',
    sender: { name: 'Older Sender', address: 'older@example.com', initials: 'OS' },
    to: [{ name: 'Work', address: 'work@example.com', initials: 'W' }],
    body: { kind: 'plain-text', content: 'Older words' },
    attachments: [],
  }
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', latestMessageId: newest.id, messageCount: 2 }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all.*/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [newest, oldest] } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', async (route) => {
    draftRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 201, json: { draft: { id: 'newest-reply-all', inReplyToMessageId: newest.id, to: [newest.sender], cc: '', bcc: '', subject: 'Re: Opua berth confirmation', bodyMarkdown: '', bodyHtml: '', bodyText: '', attachments: [], state: 'draft', accountId: 'link-one' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Reply all' }).click()
  await expect.poll(() => draftRequest).toMatchObject({ messageId: 'newest-message', to: 'newest@example.com' })
  expect(String(draftRequest?.to)).not.toContain('older@example.com')
})

test('opens a Drafts row in the editor and discards it', async ({ page }) => {
  let requestedMailbox = ''
  let openRequest: unknown
  let discarded = false
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const draftSummary = {
    ...conversations[0]!,
    id: 'gmail:draft-thread-9',
    threadId: 'draft-thread-9',
    latestMessageId: 'draft-message-9',
    accountId: 'link-one',
    accountLabel: 'work@example.com',
    subject: 'Saved draft',
  }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?.*/, (route) => {
    requestedMailbox = new URL(route.request().url()).searchParams.get('mailbox') ?? ''
    const draftConversations = requestedMailbox === 'drafts' && !discarded ? [draftSummary] : []
    return route.fulfill({ json: { source: 'gmail', conversations: draftConversations, nextCursor: null, total: draftConversations.length } })
  })
  await page.route('http://127.0.0.1:8411/v1/drafts/open', async (route) => {
    openRequest = await route.request().postDataJSON()
    if (discarded) return route.fulfill({ status: 404, json: { error: 'draft_not_found' } })
    await route.fulfill({ json: { draft: { id: 'draft-9', inReplyToMessageId: 'draft-message-9', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Saved draft', bodyMarkdown: 'Saved words', bodyHtml: '<p>Saved words</p>', bodyText: 'Saved words', attachments: [], state: 'draft', accountId: 'link-one' } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/drafts\/draft-9\?action=discard&account=link-one/, async (route) => {
    discarded = true
    await route.fulfill({ json: {} })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await expect.poll(() => requestedMailbox).toBe('drafts')
  await page.locator('[data-conversation-id="gmail:draft-thread-9"]').click()
  await expect.poll(() => openRequest).toEqual({ accountId: 'link-one', messageId: 'draft-message-9', threadId: 'draft-thread-9' })
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveValue('Saved words')
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect.poll(() => discarded).toBe(true)
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveCount(0)
})

test('updates read state only after the Gmail command is accepted', async ({ page }) => {
  let command: unknown
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    command = await route.request().postDataJSON()
    await route.fulfill({ json: { accepted: true, result: { unread: false } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Mark read' }).click()
  await expect.poll(() => command).toEqual({ accountId: 'link-one', messageIds: ['m1'], unread: false })
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible()
})

test('Dock badge follows accepted Mark Unread and Mark Read commands', async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as Window & {
      dockBadges?: Array<number | undefined>
      __TAURI__?: { window: { getCurrentWindow(): { setBadgeCount(count?: number): Promise<void> } } }
    }
    win.dockBadges = []
    win.__TAURI__ = { window: { getCurrentWindow: () => ({ setBadgeCount: async count => { win.dockBadges!.push(count) } }) } }
  })
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: false }
  await stubGmailInbox(page, summary)
  await page.unroute(/8411\/v1\/mailboxes\/counts/)
  let unread = 0
  await page.route(/8411\/v1\/mailboxes\/counts/, route => route.fulfill({ json: { source: 'gmail', counts: { inbox: unread, drafts: 0, spam: 0 } } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async route => {
    unread = (route.request().postDataJSON() as { unread: boolean }).unread ? 1 : 0
    await route.fulfill({ json: { accepted: true, result: { unread: unread > 0 } } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  const badgeCalls = () => page.evaluate(() => JSON.stringify((window as Window & { dockBadges?: Array<number | undefined> }).dockBadges))
  await page.getByRole('button', { name: 'Mark unread' }).click()
  await expect.poll(badgeCalls).toMatch(/1\]$/)
  await page.getByRole('button', { name: 'Mark read' }).click()
  await expect.poll(badgeCalls).toMatch(/null\]$/)
})

test('marks an unread Gmail conversation read after a 5 second selection dwell', async ({ page }) => {
  let command: unknown
  await page.clock.install()
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const first = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  const second = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  let listed = [first, second]
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: listed, nextCursor: null, total: listed.length } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...first, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...second, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Other' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    command = await route.request().postDataJSON()
    listed = [{ ...first, unread: false }, second]
    await route.fulfill({ json: { accepted: true, result: { unread: false } } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.clock.fastForward(4999)
  expect(command).toBeUndefined()
  await page.clock.fastForward(1)
  await expect.poll(() => command).toEqual({ accountId: 'link-one', messageIds: ['m1'], unread: false })
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).not.toHaveClass(/dispatch-message-unread/)
})

test('keeps a dwell-marked row read when a later list still says unread', async ({ page }) => {
  let command: unknown
  await page.clock.install()
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const first = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  const second = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [first, second], nextCursor: null, total: 2 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...first, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...second, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Other' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    command = await route.request().postDataJSON()
    await route.fulfill({ json: { accepted: true, result: { unread: false } } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.clock.fastForward(5000)
  await expect.poll(() => command).toEqual({ accountId: 'link-one', messageIds: ['m1'], unread: false })
  await expect(page.locator('[data-conversation-id="demo:t1"]')).not.toHaveClass(/dispatch-message-unread/)
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible()
})

test('keeps a dwell-marked row read when a late thread fetch still says unread', async ({ page }) => {
  let command: unknown
  let releaseThread: (() => void) | undefined
  const threadHeld = new Promise<void>((resolve) => { releaseThread = resolve })
  await page.clock.install()
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const first = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  const second = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [first, second], nextCursor: null, total: 2 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, async (route) => {
    await threadHeld
    await route.fulfill({ json: { conversation: { ...first, source: 'gmail', unread: true, messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', unread: true, body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...second, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Other' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    command = await route.request().postDataJSON()
    await route.fulfill({ json: { accepted: true, result: { unread: false } } })
  })
  await page.route('http://127.0.0.1:8411/v1/sync', (route) => route.fulfill({ json: { sync: { state: 'ready', startedAt: '2026-09-06T08:00:00Z', completedAt: '2026-09-06T08:00:02Z', error: null, messageCount: 2 } } }))
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.clock.fastForward(5000)
  await expect.poll(() => command).toEqual({ accountId: 'link-one', messageIds: [], unread: false })
  await expect(page.locator('[data-conversation-id="demo:t1"]')).not.toHaveClass(/dispatch-message-unread/)
  releaseThread?.()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).not.toHaveClass(/dispatch-message-unread/)
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).not.toHaveClass(/dispatch-message-unread/)
})

test('does not mark read when the user leaves before 5 seconds', async ({ page }) => {
  let command: unknown
  await page.clock.install()
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const first = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  const second = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [first, second], nextCursor: null, total: 2 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...first, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...second, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Other' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/.+\/read-state/, async (route) => {
    command = await route.request().postDataJSON()
    await route.fulfill({ json: { accepted: true, result: { unread: false } } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.clock.fastForward(2000)
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await page.clock.fastForward(5000)
  await expect.poll(() => command).toEqual({ accountId: 'link-one', messageIds: ['m2'], unread: false })
})

test('keeps the conversation unread when the dwell mark-read command fails', async ({ page }) => {
  await page.clock.install()
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', (route) => route.fulfill({ status: 502, json: { error: 'gmail_read_state_failed' } }))
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.clock.fastForward(5000)
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveClass(/dispatch-message-unread/)
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeVisible()
  await expect(page.locator('[data-mail-error]')).toBeVisible()
})

test('removes a dwell-marked conversation from Unread and keeps the reader open', async ({ page }) => {
  await page.clock.install()
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const first = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  const second = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  let unreadConversations = [first, second]
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=unread/, (route) => route.fulfill({ json: { source: 'gmail', conversations: unreadConversations, nextCursor: null, total: unreadConversations.length } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...first, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...second, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Other' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    unreadConversations = [second]
    await route.fulfill({ json: { accepted: true, result: { unread: false } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Unread', exact: true }).click()
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await page.clock.fastForward(5000)
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveCount(0)
  await expect(page.locator('[data-conversation-id="demo:t2"]')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible()
})

test('makes unread conversation rows bolder and tinted', async ({ page }) => {
  const read = {
    ...conversations[1]!,
    unread: false,
    subject: 'Invoice status update',
    sender: { name: 'OpenInvoice', address: 'notifications@openinvoice.example', initials: 'OP' },
  }
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'demo', conversations: [conversations[0], read], nextCursor: null, total: 2 } }))
  await page.goto('/')
  const unread = page.locator('[data-conversation-id="demo:t1"]')
  const readRow = page.locator('[data-conversation-id="demo:t2"]')
  await expect(unread).toHaveClass(/dispatch-message-unread/)
  await expect(readRow).not.toHaveClass(/dispatch-message-unread/)
  await expect(unread.locator('strong')).toHaveCSS('font-weight', '700')
  await expect(readRow.locator('strong')).toHaveCSS('font-weight', /^(400|500)$/)
  const unreadBg = await unread.evaluate((node) => getComputedStyle(node).backgroundColor)
  const readBg = await readRow.evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(unreadBg).not.toBe(readBg)
})

test('edits, saves, and sends a Gmail draft from the middle panel', async ({ page }) => {
  let sendCount = 0
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', (route) => route.fulfill({ status: 201, json: { draft: { id: 'draft-1', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Re: Opua berth confirmation', bodyText: '', state: 'draft', accountId: 'link-one' } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts/draft-1', async (route) => route.fulfill({ json: { draft: { id: 'draft-1', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: 'manager@example.com', bcc: 'audit@example.com', subject: 'Re: Opua berth confirmation', bodyText: 'Approved reply', state: 'draft', accountId: 'link-one' } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/drafts\/draft-1\?action=send.*/, async (route) => {
    sendCount += 1
    await route.fulfill({ json: { receipt: { id: 'receipt-1', draftId: 'draft-1', accountId: 'link-one', accountLabel: 'work@example.com', messageId: 'sent-1', status: 'accepted', requestedAt: '2026-09-08T01:00:00Z', detailsSource: 'draft', details: { to: ['ana@example.com'], cc: ['manager@example.com'], bcc: ['audit@example.com'], subject: 'Re: Opua berth confirmation', attachments: [] } } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/[^/]+\/turns/, () => {
    throw new Error('Send must not call the agent service')
  })
  await page.getByRole('textbox', { name: 'Draft body' }).fill('**Approved reply**')
  await page.getByRole('textbox', { name: 'Draft Cc' }).fill('manager@example.com')
  await page.getByRole('textbox', { name: 'Draft Bcc' }).fill('audit@example.com')
  await page.getByRole('button', { name: 'Send draft' }).click()
  await expect(page.getByRole('button', { name: 'Send now' })).toBeVisible()
  await expect(page.locator('[data-send-confirm-text]')).toHaveText('To: ana@example.com\nCc: manager@example.com\nBcc: audit@example.com\nSubject: Re: Opua berth confirmation')
  expect(sendCount).toBe(0)
  await page.getByRole('button', { name: 'Send now' }).click()
  await expect.poll(() => sendCount).toBe(1)
  await expect(page.locator('[data-receipts-dialog]')).toBeHidden()
})

test('allows one, two, or three adjustable panels while keeping one visible', async ({ page }) => {
  await page.goto('/')
  const messagesToggle = page.getByRole('button', { name: 'Messages', exact: true })
  const emailToggle = page.getByRole('button', { name: 'Email', exact: true })
  const codexToggle = page.getByRole('button', { name: 'Codex', exact: true })
  await messagesToggle.click()
  await expect(page.getByRole('complementary', { name: 'Messages' })).toBeHidden()
  await emailToggle.click()
  await expect(page.getByRole('main', { name: 'Selected email' })).toBeHidden()
  await codexToggle.click()
  await expect(codexToggle).toHaveAttribute('aria-pressed', 'true')
  await messagesToggle.click()
  await expect(page.getByRole('complementary', { name: 'Messages' })).toBeVisible()
  await emailToggle.click()
  await expect(page.getByRole('main', { name: 'Selected email' })).toBeVisible()
  await expect(page.locator('[role="separator"]')).toHaveCount(2)
  const messagesPanel = page.getByRole('complementary', { name: 'Messages' })
  const before = await messagesPanel.boundingBox()
  const divider = await page.locator('[data-divider="messages"]').boundingBox()
  expect(before).not.toBeNull()
  expect(divider).not.toBeNull()
  await page.mouse.move(divider!.x + 2, divider!.y + 100)
  await page.mouse.down()
  await page.mouse.move(divider!.x + 42, divider!.y + 100)
  await page.mouse.up()
  const after = await messagesPanel.boundingBox()
  expect(after!.width).toBeGreaterThan(before!.width + 30)
  const agentPanel = page.getByRole('complementary', { name: 'Codex' })
  const agentBefore = await agentPanel.boundingBox()
  const agentDivider = await page.locator('[data-divider="agent"]').boundingBox()
  expect(agentBefore).not.toBeNull()
  expect(agentDivider).not.toBeNull()
  await page.mouse.move(agentDivider!.x + 4, agentDivider!.y + 100)
  await page.mouse.down()
  await page.mouse.move(agentDivider!.x - 42, agentDivider!.y + 100)
  await page.mouse.up()
  const agentAfter = await agentPanel.boundingBox()
  expect(agentAfter!.width).toBeGreaterThan(agentBefore!.width + 30)
  await page.reload()
  const persistedMessages = await messagesPanel.boundingBox()
  const persistedAgent = await agentPanel.boundingBox()
  expect(persistedMessages!.width).toBeGreaterThan(before!.width + 30)
  expect(persistedAgent!.width).toBeGreaterThan(agentBefore!.width + 30)
  await page.locator('[data-folder-toggle]').click()
  await page.getByRole('menuitem', { name: 'Collapse thread list' }).click()
  await expect(messagesPanel).toBeHidden()
  await messagesToggle.click()
  await expect(messagesPanel).toBeVisible()
  await page.locator('[data-divider="agent"]').dblclick()
  await expect(agentPanel).toBeHidden()
  await codexToggle.click()
  await expect(agentPanel).toBeVisible()
  await page.keyboard.press('Control+Backquote')
  await expect(messagesPanel).toBeHidden()
  await page.keyboard.press('Control+Backquote')
  await expect(messagesPanel).toBeVisible()
})

test('waits for the mail service at startup instead of flashing a request failure', async ({ page }) => {
  let attempts = 0
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => {
    attempts += 1
    if (attempts <= 2) return route.abort('connectionrefused')
    return route.fulfill({ json: { accounts: [] } })
  })
  await page.goto('/')
  await expect(page.locator('[data-mail-source]')).toHaveText('Starting mail service…')
  await expect(page.locator('[data-mail-error]')).toBeHidden()
  await expect(page.locator('[data-conversation-id]').first()).toBeVisible()
  await expect(page.locator('[data-mail-error]')).toBeHidden()
  expect(attempts).toBeGreaterThanOrEqual(3)
})

test('toolbar icon buttons are large enough to hit and the bar drags the native window', async ({ page }) => {
  await page.goto('/')
  const buttons = page.locator('.dispatch-toolbar .btn-icon:visible')
  expect(await buttons.count()).toBeGreaterThanOrEqual(6)
  for (const box of await buttons.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()))) {
    expect(box.width).toBeGreaterThanOrEqual(36)
    expect(box.height).toBeGreaterThanOrEqual(36)
  }
  const readerButtons = page.locator('.dispatch-reader-toolbar .btn-icon')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  for (const box of await readerButtons.evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).display !== 'none').map((node) => node.getBoundingClientRect()))) {
    expect(box.width).toBeGreaterThanOrEqual(36)
    expect(box.height).toBeGreaterThanOrEqual(36)
  }
  const dragRegions = page.locator('.dispatch-toolbar [data-tauri-drag-region]')
  await expect(page.locator('.dispatch-toolbar-cluster:not([data-tauri-drag-region])')).toHaveCount(0)
  await expect(page.locator('.dispatch-toolbar-spacer:not([data-tauri-drag-region])')).toHaveCount(0)
  expect(await dragRegions.count()).toBeGreaterThanOrEqual(5)
  await expect(page.locator('.dispatch-toolbar button[data-tauri-drag-region], .dispatch-toolbar input[data-tauri-drag-region], .dispatch-toolbar select[data-tauri-drag-region]')).toHaveCount(0)
})

test('a long sync label never widens the page past the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await expect(page.locator('.dispatch-thread-message').first()).toBeVisible()
  await page.evaluate(() => { document.querySelector('[data-mail-source]')!.textContent = 'Syncing Gmail · account 1/3 · 2449 fetched, still indexing older conversations' })
  const layout = await page.evaluate(() => ({
    inner: window.innerWidth,
    page: document.documentElement.scrollWidth,
    header: document.querySelector('.dispatch-toolbar')!.getBoundingClientRect().right,
    controls: document.querySelector('.dispatch-panel-controls')!.getBoundingClientRect().right,
    agent: document.querySelector('.dispatch-agent')!.getBoundingClientRect().right,
  }))
  expect(layout.page).toBeLessThanOrEqual(layout.inner)
  expect(layout.header).toBeLessThanOrEqual(layout.inner)
  expect(layout.controls).toBeLessThanOrEqual(layout.inner - 4)
  expect(layout.agent).toBeLessThanOrEqual(layout.inner)
  for (const name of ['Messages', 'Email', 'Codex']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport()
  const compose = await page.getByRole('button', { name: 'Compose' }).boundingBox()
  const folder = await page.locator('[data-folder-toggle]').boundingBox()
  expect(compose!.x + compose!.width).toBeLessThanOrEqual(folder!.x)
})

test('dragging a divider past its minimum closes that panel', async ({ page }) => {
  await page.goto('/')
  const messagesPanel = page.getByRole('complementary', { name: 'Messages' })
  const agentPanel = page.getByRole('complementary', { name: 'Codex' })
  const divider = await page.locator('[data-divider="messages"]').boundingBox()
  expect(divider).not.toBeNull()
  await page.mouse.move(divider!.x + 4, divider!.y + 100)
  await page.mouse.down()
  await page.mouse.move(divider!.x - 320, divider!.y + 100, { steps: 12 })
  await page.mouse.up()
  await expect(messagesPanel).toBeHidden()
  await page.getByRole('button', { name: 'Messages', exact: true }).click()
  await expect(messagesPanel).toBeVisible()
  expect((await messagesPanel.boundingBox())!.width).toBeGreaterThanOrEqual(220)
  const agentDivider = await page.locator('[data-divider="agent"]').boundingBox()
  expect(agentDivider).not.toBeNull()
  await page.mouse.move(agentDivider!.x + 4, agentDivider!.y + 100)
  await page.mouse.down()
  await page.mouse.move(agentDivider!.x + 420, agentDivider!.y + 100, { steps: 12 })
  await page.mouse.up()
  await expect(agentPanel).toBeHidden()
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  await expect(agentPanel).toBeVisible()
  expect((await agentPanel.boundingBox())!.width).toBeGreaterThanOrEqual(280)
})

test('reflows pane content instead of overflowing when a divider narrows it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-conversation-id]').first()).toBeVisible()
  const divider = await page.locator('[data-divider="messages"]').boundingBox()
  expect(divider).not.toBeNull()
  await page.mouse.move(divider!.x + 4, divider!.y + 100)
  await page.mouse.down()
  await page.mouse.move(divider!.x - 400, divider!.y + 100, { steps: 10 })
  await page.mouse.up()
  const messages = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.dispatch-messages')!
    const widths = [...panel.children, ...panel.querySelectorAll('.dispatch-message')].map((child) => child.getBoundingClientRect().width)
    return { panel: panel.getBoundingClientRect().width, scrollWidth: panel.scrollWidth, maxChild: Math.max(...widths) }
  })
  expect(messages.panel).toBeLessThanOrEqual(221)
  expect(messages.scrollWidth).toBeLessThanOrEqual(Math.ceil(messages.panel))
  expect(messages.maxChild).toBeLessThanOrEqual(Math.ceil(messages.panel))
  const agentDivider = await page.locator('[data-divider="agent"]').boundingBox()
  expect(agentDivider).not.toBeNull()
  await page.mouse.move(agentDivider!.x + 4, agentDivider!.y + 100)
  await page.mouse.down()
  await page.mouse.move(agentDivider!.x + 400, agentDivider!.y + 100, { steps: 10 })
  await page.mouse.up()
  const agent = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.dispatch-agent')!
    return { panel: panel.getBoundingClientRect().width, scrollWidth: panel.scrollWidth, maxChild: Math.max(...[...panel.children].map((child) => child.getBoundingClientRect().width)) }
  })
  expect(agent.panel).toBeLessThanOrEqual(281)
  expect(agent.scrollWidth).toBeLessThanOrEqual(Math.ceil(agent.panel))
  expect(agent.maxChild).toBeLessThanOrEqual(Math.ceil(agent.panel))
})

test('uses one native Tabler pane at a time on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const messagesPanel = page.getByRole('complementary', { name: 'Messages' })
  const readerPanel = page.getByRole('main', { name: 'Selected email' })
  const agentPanel = page.getByRole('complementary', { name: 'Codex' })
  await expect(messagesPanel).toBeVisible()
  await expect(readerPanel).toBeHidden()
  await expect(agentPanel).toBeHidden()
  await expect(page.locator('[data-folder-toggle]')).toBeVisible()
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await expect(messagesPanel).toBeHidden()
  await expect(readerPanel).toBeVisible()
  await page.getByRole('button', { name: 'Back to Inbox' }).click()
  await expect(messagesPanel).toBeVisible()
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  await expect(agentPanel).toBeVisible()
  await expect(messagesPanel).toBeHidden()
  await page.keyboard.press('Control+Backquote')
  await expect(messagesPanel).toBeVisible()
  await page.keyboard.press('Control+Backquote')
  await expect(agentPanel).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('restores structured Codex history as readable text', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-history', created: false, replaced: false } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/thread-history/resume', (route) => route.fulfill({ json: { thread: { id: 'thread-history' } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/thread-history', (route) => route.fulfill({ json: {
    thread: { turns: [{ items: [
      { type: 'userMessage', content: [{ type: 'input_text', text: 'Summarize this thread.\n\nSelected Gmail account link-one, thread t1.' }] },
      { type: 'agentMessage', content: { type: 'output_text', text: '## Here is the summary.\n\n- First fact\n- Second fact\n\n| Source | Date |\n| --- | --- |\n| Gmail | Sep 3 |\n\n`thread/read`\n\n[Open evidence](https://example.com)' } },
      { type: 'userMessage', content: [{ type: 'input_text', text: `Long context ${'x'.repeat(320)}` }] },
      { type: 'agentMessage', content: { type: 'output_text', text: `Long response ${'y'.repeat(320)}\n\nhttps://example.com/${'path'.repeat(80)}` } },
    ] }] },
  } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.addInitScript(() => localStorage.setItem('dispatch.codex.threadId', 'thread-history'))
  await page.goto('/')
  await expect(page.getByText('Summarize this thread.', { exact: true })).toBeVisible()
  await expect(page.getByText('Selected Gmail account link-one', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Here is the summary.', { exact: true })).toBeVisible()
  await expect(page.locator('.ai-response h2')).toHaveText('Here is the summary.')
  await expect(page.locator('.ai-response table')).toContainText('Gmail')
  await expect(page.locator('.ai-response code')).toHaveText('thread/read')
  await expect(page.getByRole('link', { name: 'Open evidence' })).toHaveAttribute('target', '_blank')
  await expect(page.getByText('[object Object]', { exact: true })).toHaveCount(0)
  expect(await page.locator('[data-agent-stream]').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  for (const message of await page.locator('.dispatch-agent-message').all()) {
    expect(await message.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
})

test('keeps a replaced Codex thread out of the chat and writes it to the log', async ({ page }) => {
  const logs: string[] = []
  page.on('console', (message) => logs.push(message.text()))
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-fresh', created: true, replaced: true, detail: 'no rollout found for thread id dead-id' } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dispatch.codex.threadId'))).toBe('thread-fresh')
  await expect(page.getByText(/Codex thread replaced/)).toHaveCount(0)
  await expect(page.getByText(/no rollout found/)).toHaveCount(0)
  await expect.poll(() => logs.some((line) => line.includes('no rollout found for thread id dead-id'))).toBe(true)
})

test('does not read history for a brand-new Codex task', async ({ page }) => {
  let historyReads = 0
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-new', created: true, replaced: false } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/thread-new', (route) => { historyReads += 1; return route.fulfill({ status: 502, json: { error: 'thread_unavailable' } }) })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dispatch.codex.threadId'))).toBe('thread-new')
  expect(historyReads).toBe(0)
  await expect(page.getByText(/Could not restore Codex history/)).toHaveCount(0)
})

test('switches the Codex pane when the selected conversation changes', async ({ page }) => {
  const turns: string[] = []
  await stubAgent(page, {
    unbound: { threadId: 'thread-unbound' },
    'conversation:link-one:t1': { threadId: 'thread-t1' },
    'conversation:link-one:t2': { threadId: 'thread-t2' },
  })
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(.+)/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const one = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  const two = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [one, two], nextCursor: null, total: 2 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1/, (route) => route.fulfill({ json: { conversation: { ...one, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'A' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2/, (route) => route.fulfill({ json: { conversation: { ...two, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'B' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/.*\/turns/, async (route) => {
    turns.push(route.request().url())
    await route.fulfill({ status: 202, json: { accepted: true } })
  })
  await page.goto('/')
  await expect(page.getByText('History for thread-t1')).toBeVisible()
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.getByText('History for thread-t2')).toBeVisible()
  await expect(page.getByText('History for thread-t1')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Work on B')
  await page.getByRole('textbox', { name: 'Ask Codex' }).press('Enter')
  await expect.poll(() => turns.some((url) => url.includes('thread-t2'))).toBe(true)
  expect(turns.some((url) => url.includes('thread-t1'))).toBe(false)
})

test('keeps general history out of a new compose', async ({ page }) => {
  await stubAgent(page, { unbound: { threadId: 'thread-unbound' } })
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await expect(page.locator('[data-agent-stream]')).toContainText('History for thread-draft%3A')
  await expect(page.getByText('History for thread-unbound')).toHaveCount(0)
})

test('replaces a stale Codex binding cache from agent', async ({ page }) => {
  await stubAgent(page, { unbound: { threadId: 'thread-agent' } })
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'demo', conversations: [], nextCursor: null, total: 0 } }))
  await page.addInitScript(() => {
    localStorage.setItem('dispatch.codex.threadId', 'thread-stale')
    localStorage.setItem('dispatch.codex.bindings.v1', JSON.stringify({ unbound: 'thread-stale' }))
  })
  await page.goto('/')
  await expect(page.getByText('History for thread-agent')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dispatch.codex.threadId'))).toBe('thread-agent')
})

test('filters conversations by all, unread, and read state', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveClass(/dispatch-message-unread/)
  await page.getByRole('button', { name: 'Unread', exact: true }).click()
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(page.locator('[data-conversation-id]')).toHaveCount(0)
  await expect(page.locator('.dispatch-message-list-empty')).toHaveText('No read messages in inbox.')
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
})

test('loads indexed conversation pages without rendering the full mailbox at once', async ({ page }) => {
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    return route.fulfill({ json: { source: 'demo', conversations: [cursor ? conversations[1] : conversations[0]], nextCursor: cursor ? null : '1', total: 2 } })
  })
  await page.goto('/')
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Load more · 1 remaining' })).toBeVisible()
  await page.getByRole('button', { name: 'Load more · 1 remaining' }).click()
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
  await expect(page.locator('.dispatch-load-more')).toHaveCount(0)
})

test('searches the unified Gmail index from the message pane', async ({ page }) => {
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')
    return route.fulfill({ json: { source: 'demo', conversations: query ? [conversations[1]] : conversations, nextCursor: null, total: query ? 1 : 2 } })
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Search mail' }).fill('from:james@example.com')
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Services agreement' })).toBeVisible()
})

test('shows cached conversations immediately while Gmail refreshes', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.fulfill({ json: { source: 'demo', conversations } })
  })
  await page.reload()
  await expect(page.locator('[data-mail-source]')).toHaveText(/^Refreshing · cached /)
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
  await expect(page.locator('[data-mail-source]')).toHaveText('Demo mail')
})

test('Refresh fetches Gmail heads and preserves the selected thread', async ({ page }) => {
  let refreshed = false
  await page.route('http://127.0.0.1:8411/v1/sync', async (route) => {
    refreshed = true
    await route.fulfill({ json: { sync: { state: 'ready', startedAt: '2026-09-05T09:10:00Z', completedAt: '2026-09-05T09:10:02Z', error: null, messageCount: 3 } } })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect.poll(() => refreshed).toBe(true)
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
})

test('network return requests wake refresh and refresh failures use plain language', async ({ page }) => {
  const reasons: string[] = []
  let fail = false
  await page.route('http://127.0.0.1:8411/v1/sync', route => {
    reasons.push(route.request().postDataJSON().reason)
    return route.fulfill({ status: fail ? 503 : 202, json: fail ? { error: 'RAW_PROVIDER_ERROR' } : { accepted: true, sync: { state: 'syncing', completedAt: null } } })
  })
  await page.goto('/')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => reasons.includes('wake')).toBe(true)
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  fail = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('[data-mail-error]')).toContainText('reconnect automatically')
  await expect(page.locator('[data-mail-error]')).not.toContainText('RAW_PROVIDER_ERROR')
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
})

test('new mail appears when one account refreshes even if another account is rate limited', async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', name: 'Test', email: 'test@example.com', connectorId: 'gmail' }] } }))
  let updated = false
  let observed = 0
  const fresh = { ...conversations[0]!, id: 'demo:new', threadId: 'new', latestMessageId: 'new', subject: 'Arrived after wake' }
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'demo', conversations: updated ? [fresh, ...conversations] : conversations } }))
  await page.route('http://127.0.0.1:8411/v1/sync/status', route => { observed++; return route.fulfill({ json: { sync: { state: updated ? 'failed' : 'ready', error: updated ? 'RATE_LIMITED' : null, completedAt: '2026-09-11T00:00:00Z', messageCount: 3, mailRevision: updated ? 2 : 1 } } }) })
  await page.goto('/')
  await expect.poll(() => observed).toBeGreaterThan(0)
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  updated = true
  await expect(page.locator('[data-conversation-id="demo:new"]')).toBeVisible({ timeout: 8000 })
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
})

for (const editing of [false, true]) test(`new reply refreshes the open thread and preserves draft edits: ${editing}`, async ({ page }) => {
  let updated = false
  let refreshed = false
  await stubAgent(page)
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', name: 'Test', email: 'test@example.com', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/conversations\?/, route => { refreshed ||= updated; return route.fulfill({ json: { source: 'demo', conversations: updated ? [{ ...conversations[0]!, latestMessageId: 'jacob', messageCount: 2 }, conversations[1]!] : conversations } }) })
  await page.route(/8411\/v1\/conversations\/t1(?:\?|$)/, route => route.fulfill({ json: { conversation: { ...conversations[0]!, source: 'demo', messages: [{ ...messages[0]!, id: updated ? 'jacob' : 'm1', body: { kind: 'sanitized-html', content: `${updated ? '<p>Received thanks from Jacob!</p>' : '<p>Original message</p>'}<div style="height:2000px">Earlier correspondence</div>` }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/sync/status', route => route.fulfill({ json: { sync: { state: 'ready', completedAt: '2026-09-11T00:00:00Z', messageCount: 3, mailRevision: updated ? 2 : 1 } } }))
  await page.goto('/')
  await expect(page.getByText('Original message', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Keep this unsent prompt')
  if (!editing) {
    await page.locator('[data-body]').evaluate(element => { element.scrollTop = 500 })
    expect(await page.locator('[data-body]').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  }
  if (editing) {
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await page.getByRole('textbox', { name: 'Draft body' }).fill('Keep my draft edits')
  }
  updated = true
  if (editing) {
    await expect.poll(() => refreshed, { timeout: 8000 }).toBe(true)
    await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveValue('Keep my draft edits')
  } else {
    await expect(page.getByText('Received thanks from Jacob!', { exact: true })).toBeVisible({ timeout: 8000 })
    await expect.poll(() => page.locator('[data-body]').evaluate(element => element.scrollTop)).toBe(0)
    await expect(page.getByRole('textbox', { name: 'Ask Codex' })).toHaveValue('Keep this unsent prompt')
  }
})

test('collapses an unsent draft without losing edits and gives space back to the email', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Draft body' })
  await body.fill('Keep these unsent words')
  const before = await page.locator('[data-body]').boundingBox()
  await page.getByRole('button', { name: 'Collapse draft', exact: true }).click()
  await expect(page.getByText('Unsent draft', { exact: true })).toBeVisible()
  await expect(page.getByText('Not sent', { exact: true })).toBeVisible()
  await expect(body).toBeHidden()
  await expect(page.getByRole('button', { name: 'Send draft', exact: true })).toBeHidden()
  expect((await page.locator('[data-body]').boundingBox())!.height).toBeGreaterThan(before!.height)
  const expand = page.getByRole('button', { name: 'Expand draft', exact: true })
  await expand.focus(); await page.keyboard.press('Enter')
  await expect(body).toHaveValue('Keep these unsent words')
})

for (const action of ['automatic', 'refresh', 'compose']) test(`failed message download recovers safely: ${action}`, async ({ page }) => {
  let reads = 0
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', name: 'Test', email: 'test@example.com', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/conversations\/t1(?:\?|$)/, route => {
    if (++reads === 1) return route.fulfill({ status: 503, json: { error: 'network unavailable after wake' } })
    return route.fulfill({ json: { conversation: { ...conversations[0]!, source: 'demo', messages: [{ ...messages[0]!, body: { kind: 'sanitized-html', content: '<p>Downloaded after reconnect</p>' }, attachments: [] }] } } })
  })
  await page.route('http://127.0.0.1:8411/v1/sync', route => route.fulfill({ status: 202, json: { sync: { state: 'syncing', completedAt: null } } }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toBeVisible()
  if (action === 'refresh') await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  if (action === 'compose') {
    await page.getByRole('button', { name: 'Compose', exact: true }).click()
    await page.getByRole('textbox', { name: 'Draft body' }).fill('Do not replace this draft')
    await page.waitForTimeout(5500)
    await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveValue('Do not replace this draft')
    expect(reads).toBe(1)
  } else await expect(page.getByText('Downloaded after reconnect', { exact: true })).toBeVisible({ timeout: action === 'refresh' ? 3000 : 8000 })
})

test('network loss never persists downloaded-only mode and old automatic offline settings are repaired', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dispatch.offline-mode', 'true'))
  let refreshes = 0
  await page.route('http://127.0.0.1:8411/v1/sync', route => { refreshes++; return route.fulfill({ status: 202, json: { sync: { state: 'syncing', completedAt: null } } }) })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('dispatch.offline-mode'))).toBeNull()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => refreshes).toBe(1)
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  expect(await page.evaluate(() => localStorage.getItem('dispatch.offline-mode'))).toBeNull()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => refreshes).toBe(2)
  await expect(page.locator('[data-mail-source]')).not.toHaveText('Downloaded mail')
})

test('derives an immediate unread view from the cached All inbox', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=unread/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.fulfill({ json: { source: 'demo', conversations } })
  })
  await page.getByRole('button', { name: 'Unread', exact: true }).click()
  await expect(page.locator('[data-mail-source]')).toHaveText(/^Refreshing · cached /)
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
  await expect(page.locator('[data-mail-source]')).toHaveText('Demo mail')
})

test('labels cached mail stale and exposes the refresh failure', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({
    status: 502, json: { error: 'gmail_conversation_list_failed', detail: 'connector timed out' },
  }))
  await page.reload()
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2)
  await expect(page.locator('[data-mail-source]')).toHaveText(/^STALE · /)
  await expect(page.locator('[data-mail-error]')).toContainText('Gmail is unavailable')
  await expect(page.locator('[data-mail-error]')).toContainText('Showing mail saved')
})

test('recovers the mail list automatically after a transient service failure', async ({ page }) => {
  let attempts = 0
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => {
    attempts += 1
    return attempts === 1
      ? route.fulfill({ status: 502, json: { error: 'gmail_unavailable', detail: 'temporary outage' } })
      : route.fulfill({ json: { source: 'demo', conversations, nextCursor: null, total: conversations.length } })
  })
  await page.goto('/')
  await expect(page.locator('[data-mail-source]')).toHaveText('Unavailable')
  await expect(page.locator('[data-mail-error]')).toContainText('reconnect automatically')
  await expect(page.locator('[data-conversation-id]')).toHaveCount(2, { timeout: 5_000 })
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test('a Codex draft that Gmail no longer has is reported as sent or replaced, not as raw JSON', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'connector-gmail', name: 'Work', email: 'work@example.com' }] } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [], nextCursor: null, total: 0 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/drafts\/r-7734/, (route) => route.fulfill({ status: 404, json: { error: 'gmail_draft_not_found', detail: 'Gmail draft r-7734 was not found' } }))
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [{ id: 'gmail', name: 'Gmail', isAccessible: true, isEnabled: true }] } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-mcp', created: true, replaced: false } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250))
    await route.fulfill({ contentType: 'text/event-stream', body: [
      'data: {"method":"turn/started","params":{"threadId":"thread-mcp","turn":{"status":"inProgress"}}}\n\n',
      'data: {"method":"item/completed","params":{"threadId":"thread-mcp","item":{"type":"mcpToolCall","status":"completed","tool":"gmail.update_draft","arguments":{"link_id":"link-one"},"result":{"structuredContent":{"draft_id":"r-7734"}}}}}\n\n',
    ].join('') })
  })
  await page.goto('/')
  await expect(page.locator('.dispatch-agent-tool').last()).toContainText('Gmail no longer has that draft')
  await expect(page.locator('.dispatch-agent-error')).toHaveCount(0)
  await expect(page.locator('.dispatch-agent-stream')).not.toContainText('Request failed')
})

test('a chat held by another Codex app offers Retry and Start new chat', async ({ page }) => {
  const bindings: Array<Record<string, unknown>> = []
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({ contentType: 'text/event-stream', body: 'data: {"method":"turn/started","params":{"threadId":"thread-fresh","turn":{"status":"inProgress"}}}\n\n' }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bindings.push(body)
    if (body.replace === true) return route.fulfill({ json: { binding: { key: body, threadId: 'thread-fresh', created: true, replaced: true, detail: 'A new chat was started for this email.' } } })
    return route.fulfill({ status: 409, json: { error: 'codex_thread_busy', detail: 'thread thread-old already has an active writer', threadId: 'thread-old' } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  const card = page.locator('[data-thread-busy]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('open in another Codex app')
  await expect(page.locator('[data-agent-status]')).toHaveAttribute('data-status', 'Needs attention')
  await expect(page.locator('.dispatch-agent-error')).toHaveCount(0)
  await card.getByRole('button', { name: 'Retry' }).click()
  await expect.poll(() => bindings.length).toBeGreaterThanOrEqual(2)
  await expect(page.locator('[data-thread-busy]')).toHaveCount(1)
  await page.locator('[data-thread-busy]').getByRole('button', { name: 'Start new chat' }).click()
  await expect.poll(() => bindings.some((body) => body.replace === true)).toBe(true)
  await expect(page.locator('[data-thread-busy]')).toHaveCount(0)
  await expect(page.locator('[data-agent-status]')).not.toHaveAttribute('data-status', 'Needs attention')
})

test('raw service errors in the Codex pane are rewritten as sentences', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ status: 502, json: { error: 'codex_binding_failed', detail: 'thread 01a0 already has an active writer' } }))
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  const error = page.locator('.dispatch-agent-error').last()
  await expect(error).toContainText('Codex could not open the chat for this email.')
  await expect(error).not.toContainText('Request failed')
  await expect(error).toHaveAttribute('data-raw-message', /codex_binding_failed/)
})

test('opens a Gmail draft that Codex created through MCP', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'connector-gmail', name: 'Work', email: 'work@example.com' }] } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [], nextCursor: null, total: 0 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/drafts\/codex-draft-9/, (route) => route.fulfill({ json: { draft: {
    id: 'codex-draft-9', inReplyToMessageId: '', to: [{ name: 'Ana', address: 'ana@example.com', initials: 'A' }],
    cc: '', bcc: '', subject: 'Berth plan', bodyMarkdown: 'See you in Opua.', bodyHtml: '<p>See you in Opua.</p>',
    bodyText: 'See you in Opua.', attachments: [{ name: 'arrival.pdf', mediaType: 'application/pdf' }], state: 'draft', accountId: 'link-one',
  } } }))
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [{ id: 'gmail', name: 'Gmail', isAccessible: true, isEnabled: true }] } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-mcp', created: true, replaced: false } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250))
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [
        'data: {"method":"turn/started","params":{"threadId":"thread-mcp","turn":{"status":"inProgress"}}}\n\n',
        'data: {"method":"item/completed","params":{"threadId":"thread-mcp","item":{"type":"mcpToolCall","status":"completed","tool":"gmail.create_draft","arguments":{"link_id":"link-one"},"result":{"structuredContent":{"draft_id":"codex-draft-9"}}}}}\n\n',
      ].join(''),
    })
  })
  const draftReads: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/v1/drafts/codex-draft-9')) draftReads.push(request.url())
  })
  await page.goto('/')
  await expect.poll(() => draftReads.length).toBeGreaterThan(0)
  await expect(page.getByRole('textbox', { name: 'Draft subject' })).toHaveValue('Berth plan')
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveValue('See you in Opua.')
  await expect(page.getByLabel('Draft attachments')).toContainText('arrival.pdf')
})

test('answers Codex approval requests without changing the request id type', async ({ page }) => {
  let approval: unknown
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads', (route) => route.fulfill({ status: 201, json: { thread: { id: 'thread-test' } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-test', created: true, replaced: false } } }))
  await page.route('http://127.0.0.1:8412/v1/server-requests/respond', async (route) => {
    approval = await route.request().postDataJSON()
    await route.fulfill({ json: { status: 'resolved' } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: [
      'data: {"method":"turn/started","params":{"threadId":"thread-test","turn":{"status":"inProgress"}}}\n\n',
      'data: {"id":42,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-test","reason":"Read a local note"}}\n\n',
    ].join(''),
  }))
  await page.goto('/')
  await expect(page.getByText('Approve command?')).toBeVisible()
  await page.getByRole('button', { name: 'Allow once' }).click()
  await expect.poll(() => approval).toEqual({ id: 42, result: { decision: 'accept' } })
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
})

test('marks a conversation selected before its full thread finishes loading', async ({ page }) => {
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const summary = conversations[1]!
    return route.fulfill({ json: { conversation: { ...summary, source: 'demo', messages: [{ ...messages[1]!, source: 'demo', body: { kind: 'plain-text', content: 'Loaded.' }, attachments: [] }] } } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.locator('[data-conversation-id="demo:t2"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Services agreement' })).toBeVisible()
  await expect(page.getByText('Loading conversation…')).toBeVisible()
  await expect(page.getByText('Loaded.', { exact: true })).toBeVisible()
})

test('forwards source message attachments and lists them on the draft', async ({ page }) => {
  let draftRequest: Record<string, unknown> | undefined
  let opened: string | undefined
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  const attachment = { id: 'a1', name: 'arrival.pdf', mediaType: 'application/pdf', sizeLabel: '824 KB' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [attachment] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', async (route) => {
    draftRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 201, json: { draft: { id: 'fwd-1', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Fwd: Opua berth confirmation', bodyMarkdown: '', bodyHtml: '<p></p>', bodyText: '', attachments: draftRequest.attachments, state: 'draft', accountId: 'link-one' } } })
  })
  await page.route(/\/v1\/messages\/m1\/attachments\/a1\/open/, async (route) => {
    opened = route.request().url()
    await route.fulfill({ json: { opened: true, filename: 'arrival.pdf' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Forward' }).click()
  await expect.poll(() => draftRequest?.attachments).toEqual([{ ...attachment, sourceMessageId: 'm1' }])
  await expect(page.getByLabel('Draft attachments')).toContainText('arrival.pdf')
  await page.getByRole('list', { name: 'Draft attachments' }).getByRole('button', { name: 'Preview arrival.pdf' }).click()
  await expect(page.getByTitle('arrival.pdf')).toHaveAttribute('src', /\/v1\/messages\/m1\/attachments\/a1/)
  await page.getByRole('button', { name: 'Open arrival.pdf' }).click()
  await expect.poll(() => opened).toContain('/v1/messages/m1/attachments/a1/open')
})

test('attaches a local file to the open draft', async ({ page }) => {
  let saved: Record<string, unknown> | undefined
  let opened: unknown
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', async (route) => {
    saved = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 201, json: { draft: { id: 'attach-1', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: '', bodyMarkdown: '', bodyHtml: '<p></p>', bodyText: '', attachments: saved.attachments, state: 'draft', accountId: 'link-one' } } })
  })
  await page.route('http://127.0.0.1:8411/v1/drafts/attachments/open', async (route) => {
    opened = route.request().postDataJSON()
    await route.fulfill({ json: { opened: true, filename: 'notes.txt' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.locator('[data-draft-files]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect.poll(() => saved?.attachments).toEqual([expect.objectContaining({ name: 'notes.txt', mediaType: 'text/plain', contentBase64: 'aGVsbG8=' })])
  await expect(page.getByLabel('Draft attachments')).toContainText('notes.txt')
  await page.getByRole('button', { name: 'Open notes.txt' }).click()
  await expect.poll(() => opened).toEqual({ filename: 'notes.txt', contentBase64: 'aGVsbG8=' })
})

test('adds a recipient chip from mail autocomplete', async ({ page }) => {
  let draftRequest: Record<string, unknown> | undefined
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/recipients/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/recipients/, (route) => route.fulfill({ json: { recipients: [{ name: 'Ana Morales', address: 'ana@example.com', initials: 'AM' }] } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', async (route) => {
    draftRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 201, json: { draft: { id: 'chip-1', inReplyToMessageId: '', to: [{ name: 'Ana Morales', address: 'ana@example.com', initials: 'AM' }], cc: '', bcc: '', subject: '', bodyMarkdown: '', bodyHtml: '<p></p>', bodyText: '', attachments: [], state: 'draft', accountId: 'link-one' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByRole('textbox', { name: 'Draft recipient' }).fill('ana')
  await page.getByRole('option', { name: 'Ana Morales <ana@example.com>' }).click()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect.poll(() => draftRequest?.to).toBe('ana@example.com')
  await expect(page.getByRole('button', { name: 'Remove ana@example.com' })).toBeVisible()
})

test('opens a desktop attachment through mail instead of downloading it', async ({ page }) => {
  let opened: { method: string; url: string } | undefined
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1/, (route) => {
    if (route.request().url().includes('/actions') || route.request().url().includes('/read-state')) return route.fallback()
    return route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{
      ...messages[0]!,
      accountId: 'link-one',
      source: 'gmail',
      body: { kind: 'plain-text', content: 'Body' },
      attachments: [{ id: 'att-9', name: 'arrival.pdf', mediaType: 'application/pdf', sizeLabel: '12 KB' }],
    }] } } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/messages\/m1\/attachments\/att-9\/open/, async (route) => {
    opened = { method: route.request().method(), url: route.request().url() }
    await route.fulfill({ json: { opened: true, filename: 'arrival.pdf', path: '/tmp/arrival.pdf' } })
  })
  const warmed: string[] = []
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/messages\/m1\/attachments\/att-9\/cache/, async (route) => {
    warmed.push(route.request().url())
    await route.fulfill({ json: { cached: true, reused: false, filename: 'arrival.pdf', mediaType: 'application/pdf' } })
  })
  await page.goto('/')
  await expect.poll(() => warmed).toEqual(['http://127.0.0.1:8411/v1/messages/m1/attachments/att-9/cache?filename=arrival.pdf&account=link-one'])
  await page.getByRole('button', { name: 'arrival.pdf 12 KB' }).click()
  await expect.poll(() => opened).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:8411/v1/messages/m1/attachments/att-9/open?filename=arrival.pdf&account=link-one',
  })
  await expect(page.getByText('Opened arrival.pdf')).toBeVisible()
  const preview = page.getByRole('button', { name: 'Preview arrival.pdf' })
  await preview.click()
  await expect(page.locator('iframe.dispatch-attachment-frame')).toHaveAttribute('src', 'http://127.0.0.1:8411/v1/messages/m1/attachments/att-9?filename=arrival.pdf&account=link-one')
  await preview.click()
  await expect(page.locator('iframe.dispatch-attachment-frame')).toHaveCount(0)
})

test('shows image attachments inline from the mail cache', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1/, (route) => {
    if (route.request().url().includes('/actions') || route.request().url().includes('/read-state')) return route.fallback()
    return route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{
      ...messages[0]!,
      accountId: 'link-one',
      source: 'gmail',
      body: { kind: 'plain-text', content: 'Photos attached' },
      attachments: [
        { id: 'img-a', name: 'image.png', mediaType: 'image/png', sizeLabel: '3 KB' },
        { id: 'img-b', name: 'image.png', mediaType: 'image/png', sizeLabel: '97 KB' },
      ],
    }] } } })
  })
  await page.route(/8411\/v1\/messages\/m1\/attachments\/img-[ab]\/cache/, (route) => route.fulfill({ json: { cached: true } }))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  await page.route(/8411\/v1\/messages\/m1\/attachments\/img-[ab]\?/, (route) => route.fulfill({ body: png, contentType: 'image/png' }))
  await page.goto('/')
  const images = page.locator('.dispatch-attachment-preview img')
  await expect(images).toHaveCount(2)
  await expect(images.nth(1)).toHaveAttribute('src', 'http://127.0.0.1:8411/v1/messages/m1/attachments/img-b?filename=image.png&account=link-one')
  await expect.poll(() => images.nth(0).evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1)
})

test('renders rewritten CID images in the thread reader', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  const src = 'http://127.0.0.1:8411/v1/messages/m1/attachments/img-1?account=link-one&filename=logo.png'
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'sanitized-html', content: `<p><img src="${src}" alt="logo"></p>` }, attachments: [{ id: 'img-1', name: 'logo.png', mediaType: 'image/png', sizeLabel: '1 KB', contentId: 'logo@mail' }] }] } } }))
  await page.goto('/')
  await expect(page.locator('.dispatch-thread-body img')).toHaveAttribute('src', src)
})

async function stubGmailInbox(page: import('@playwright/test').Page, summary: typeof conversations[number] & { accountId: string }) {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
}

async function chooseThreadMenu(page: import('@playwright/test').Page, name: string) {
  await page.locator('[data-conversation-id="demo:t1"]').click({ button: 'right' })
  await expect(page.locator('[data-thread-context-menu]')).toBeVisible()
  await page.locator('[data-thread-context-menu]').getByRole('menuitem', { name, exact: true }).evaluate((node) => (node as HTMLButtonElement).click())
}

test('opens a thread context menu on right-click and blocks the page menu', async ({ page }) => {
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await stubGmailInbox(page, summary)
  await page.goto('/')
  const row = page.locator('[data-conversation-id="demo:t1"]')
  const prevented = await row.evaluate((element) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(prevented).toBe(true)
  await expect(page.locator('[data-thread-context-menu]')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Move to Trash', exact: true })).toBeVisible()
  await expect(row).toHaveAttribute('aria-selected', 'true')
})

test('replies from the thread context menu through the same draft handler', async ({ page }) => {
  let draftRequest: unknown
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await stubGmailInbox(page, summary)
  await page.unroute('http://127.0.0.1:8411/v1/drafts')
  await page.route('http://127.0.0.1:8411/v1/drafts', async (route) => {
    draftRequest = await route.request().postDataJSON()
    await route.fulfill({ status: 201, json: { draft: { id: 'ctx-reply', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Re: Opua berth confirmation', bodyText: '', state: 'draft', accountId: 'link-one' } } })
  })
  await page.goto('/')
  await chooseThreadMenu(page, 'Reply')
  await expect.poll(() => draftRequest).toMatchObject({ messageId: 'm1', accountId: 'link-one' })
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toBeVisible()
})

test('marks unread from the thread context menu through the same read-state handler', async ({ page }) => {
  let command: unknown
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: false }
  await stubGmailInbox(page, summary)
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    command = await route.request().postDataJSON()
    await route.fulfill({ json: { accepted: true, result: { unread: true } } })
  })
  await page.goto('/')
  await chooseThreadMenu(page, 'Mark as Unread')
  await expect.poll(() => command).toEqual({ accountId: 'link-one', messageIds: ['m1'], unread: true })
})

test('stale cached unread labels cannot reverse the toolbar or row styling', async ({ page }) => {
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: false }
  await stubGmailInbox(page, summary)
  await page.route(/8411\/v1\/conversations\/t1\?account=link-one/, route => route.fulfill({ json: { conversation: {
    ...summary, unread: true, source: 'gmail', availability: { mode: 'downloaded', cachedAt: '2026-09-20T00:00:00Z' },
    messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', unread: true, body: { kind: 'plain-text', content: 'Saved body with old labels' }, attachments: [] }],
  } } }))
  const writes: unknown[] = []
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async route => {
    writes.push(route.request().postDataJSON());
    await route.fulfill({ json: { accepted: true } })
  })
  await page.goto('/')
  const row = page.locator('[data-conversation-id="demo:t1"]')
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible()
  await expect(row.locator('strong')).toHaveCSS('font-weight', '400')
  await page.getByRole('button', { name: 'Mark unread' }).click()
  await expect(row).toHaveClass(/dispatch-message-unread/)
  await expect(row.locator('strong')).toHaveCSS('font-weight', '700')
  await expect(row.locator('b')).toHaveCSS('font-weight', '700')
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeVisible()
  await row.click()
  await expect(row.locator('strong')).toHaveCSS('font-weight', '700')
  expect(writes).toEqual([{ accountId: 'link-one', unread: true, messageIds: ['m1'] }])
})

test('Mark as Unread from the row does not wait for a slow message body', async ({ page }) => {
  const summary = { ...conversations[0]!, accountId: 'link-one', unread: false }
  await stubGmailInbox(page, summary)
  let pendingBody: import('@playwright/test').Route | undefined
  await page.route(/8411\/v1\/conversations\/t1\?account=link-one/, route => { pendingBody = route })
  let command: unknown
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async route => {
    command = route.request().postDataJSON()
    await route.fulfill({ json: { accepted: true } })
  })
  await page.goto('/')
  await chooseThreadMenu(page, 'Mark as Unread')
  await expect.poll(() => command).toEqual({ accountId: 'link-one', unread: true, messageIds: [] })
  const row = page.locator('[data-conversation-id="demo:t1"]')
  await expect(row.locator('strong')).toHaveCSS('font-weight', '700')
  await expect(row.locator('b')).toHaveCSS('font-weight', '700')
  await pendingBody!.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', unread: false, source: 'gmail', body: { kind: 'plain-text', content: 'Late body' }, attachments: [] }] } } })
  await expect(page.getByText('Late body', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeVisible()
  await expect(row.locator('strong')).toHaveCSS('font-weight', '700')
})

test('marks an explicitly unread thread read after reselecting it for 5 seconds', async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => localStorage.setItem('dispatch.manually-unread.v1', JSON.stringify(['demo:t1'])))
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const first = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: false }
  const second = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: false }
  let firstUnread = false
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/, (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')
    const items = [{ ...first, unread: firstUnread }, second].filter(item => state === 'all' || (state === 'unread' ? item.unread : !item.unread))
    return route.fulfill({ json: { source: 'gmail', conversations: items, nextCursor: null, total: items.length } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...first, unread: firstUnread, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', unread: firstUnread, body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...second, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Other' }, attachments: [] }] } } }))
  const writes: unknown[] = []
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    const body = route.request().postDataJSON() as { unread: boolean }
    writes.push(body)
    firstUnread = body.unread
    await route.fulfill({ json: { accepted: true, result: { unread: firstUnread } } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.getByRole('button', { name: 'Mark unread' }).click()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveClass(/dispatch-message-unread/)
  await page.clock.fastForward(6_000)
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveClass(/dispatch-message-unread/)
  expect(writes).toEqual([{ accountId: 'link-one', messageIds: ['m1'], unread: true }])
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.clock.fastForward(4_999)
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveClass(/dispatch-message-unread/)
  expect(writes).toHaveLength(1)
  await page.clock.fastForward(1)
  await expect(page.locator('[data-conversation-id="demo:t1"]')).not.toHaveClass(/dispatch-message-unread/)
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible()
  expect(writes).toEqual([
    { accountId: 'link-one', messageIds: ['m1'], unread: true },
    { accountId: 'link-one', messageIds: ['m1'], unread: false },
  ])
  await page.reload()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).not.toHaveClass(/dispatch-message-unread/)
})

test('moves a newly marked unread thread out of the Read filter', async ({ page }) => {
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: false }
  await stubGmailInbox(page, summary)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(read|unread)/, (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')
    const items = state === (summary.unread ? 'unread' : 'read') ? [summary] : []
    return route.fulfill({ json: { source: 'gmail', conversations: items, nextCursor: null, total: items.length } })
  })
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    summary.unread = (route.request().postDataJSON() as { unread: boolean }).unread
    await route.fulfill({ json: { accepted: true, result: { unread: summary.unread } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.getByRole('button', { name: 'Mark unread' }).click()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Unread', exact: true }).click()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toBeVisible()
})

test('moves a conversation to Trash from the thread context menu', async ({ page }) => {
  let action: unknown
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await stubGmailInbox(page, summary)
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/actions', async (route) => {
    action = await route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { accepted: true } })
  })
  await page.goto('/')
  await chooseThreadMenu(page, 'Move to Trash')
  await expect.poll(() => action).toEqual({ accountId: 'link-one', messageIds: ['m1'], action: 'trash' })
})

test('does not start the read dwell from a thread-row right-click', async ({ page }) => {
  let command: unknown
  await page.clock.install()
  const first = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  const second = { ...conversations[1]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: true }
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [first, second], nextCursor: null, total: 2 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...first, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...second, source: 'gmail', messages: [{ ...messages[1]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Other' }, attachments: [] }] } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/.+\/read-state/, async (route) => {
    command = await route.request().postDataJSON()
    await route.fulfill({ json: { accepted: true, result: { unread: false } } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t2"]').click({ button: 'right' })
  await expect(page.locator('[data-thread-context-menu]')).toBeVisible()
  await page.clock.fastForward(5000)
  expect(command).toBeUndefined()
  await expect(page.locator('[data-conversation-id="demo:t2"]')).toHaveClass(/dispatch-message-unread/)
})

test('puts the reader subject on its own row above the actions', async ({ page }) => {
  await page.goto('/')
  const subject = page.locator('[data-subject]')
  const reply = page.getByRole('button', { name: 'Reply', exact: true })
  await expect(subject).toHaveText('Opua berth confirmation')
  await expect(page.locator('.dispatch-reader-toolbar [data-subject]')).toHaveCount(0)
  const [subjectBox, replyBox] = await Promise.all([subject.boundingBox(), reply.boundingBox()])
  expect(subjectBox).toBeTruthy()
  expect(replyBox).toBeTruthy()
  expect(subjectBox!.y + subjectBox!.height).toBeLessThanOrEqual(replyBox!.y)
  const style = await subject.evaluate((node) => {
    const computed = getComputedStyle(node)
    return { whiteSpace: computed.whiteSpace, fontSize: Number.parseFloat(computed.fontSize) }
  })
  expect(style.whiteSpace).toBe('nowrap')
  expect(style.fontSize).toBe(18)
})

test('reader actions share one icon-over-label treatment', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  const actions = page.locator('.dispatch-reader-toolbar .dispatch-reader-action:visible')
  await expect(actions).toHaveCount(8)
  await expect(actions).toHaveText(['Reply', 'Reply all', 'Forward', 'Archive', 'Spam', 'Trash', 'Codex', 'More'])
  const boxes = await actions.evaluateAll((nodes) => nodes.map((node) => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height, direction: getComputedStyle(node).flexDirection, color: getComputedStyle(node).color } }))
  expect(new Set(boxes.map((box) => Math.round(box.height))).size).toBe(1)
  expect(new Set(boxes.map((box) => box.color)).size).toBe(1)
  for (const box of boxes) { expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.direction).toBe('column') }
  await expect(page.locator('.dispatch-reader-toolbar [data-ask]')).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.locator('[data-reader-menu] [role="menuitem"]')).toHaveCount(1)
})

test('a narrow reader keeps every toolbar action inside the pane', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 820 })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  const pane = await page.locator('.dispatch-reader').boundingBox()
  const boxes = await page.locator('.dispatch-reader-toolbar .dispatch-reader-action:visible').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()))
  expect(boxes.length).toBe(8)
  for (const box of boxes) {
    expect(box.right).toBeLessThanOrEqual(pane!.x + pane!.width + 0.5)
    expect(box.left).toBeGreaterThanOrEqual(pane!.x - 0.5)
  }
  await expect(page.locator('[data-ask]')).toBeInViewport()
})

test('a wide HTML email scrolls inside its card instead of being clipped', async ({ page }) => {
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t2/, (route) => {
    if (route.request().url().includes('/actions') || route.request().url().includes('/read-state')) return route.fallback()
    const wide = '<table style="width:1400px"><tr><td style="width:1400px;white-space:nowrap">Our records show that a payment for your subscription was not completed and this sentence keeps going well past the pane.</td></tr></table>'
    return route.fulfill({ json: { conversation: { ...conversations[1]!, source: 'demo', messages: [{ ...messages[1]!, source: 'demo', body: { kind: 'sanitized-html', content: wide }, attachments: [] }] } } })
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t2"]').click()
  const content = page.locator('.dispatch-thread-content').first()
  await expect(content).toBeVisible()
  const metrics = await content.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowX: getComputedStyle(node).overflowX }))
  expect(metrics.overflowX).toBe('auto')
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
  const reader = await page.locator('.dispatch-reader').evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }))
  expect(reader.scrollWidth).toBeLessThanOrEqual(reader.clientWidth + 1)
})

for (const saveOutcome of ['succeeds', 'fails', 'pending'] as const) {
  test(`returning from a draft to the inbox keeps every row selectable when the autosave ${saveOutcome}`, async ({ page }) => {
    await page.unroute('http://127.0.0.1:8411/v1/accounts')
    await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
    await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
    const inbox = conversations.map((conversation) => ({ ...conversation, accountId: 'link-one', accountLabel: 'work@example.com' }))
    const draftRow = { ...inbox[0]!, id: 'link-one:t9', threadId: 't9', latestMessageId: 'dmsg', subject: 'Re: quick call', sender: { name: 'Steve', address: 'work@example.com', initials: 'S' } }
    await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?.*/, (route) => {
      const mailbox = new URL(route.request().url()).searchParams.get('mailbox')
      return route.fulfill({ json: { source: 'gmail', conversations: mailbox === 'drafts' ? [draftRow] : inbox, nextCursor: null, total: 1 } })
    })
    await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...inbox[0]!, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Inbox body' }, attachments: [] }] } } }))
    const draft = { id: 'draft-9', inReplyToMessageId: 'dmsg', to: [{ name: 'Ana', address: 'ana@example.com', initials: 'A' }], cc: '', bcc: '', subject: 'Re: quick call', bodyMarkdown: 'Hi Ana', bodyHtml: '<p>Hi Ana</p>', bodyText: 'Hi Ana', attachments: [], state: 'draft', accountId: 'link-one' }
    await page.route('http://127.0.0.1:8411/v1/drafts/open', async (route) => {
      expect(await route.request().postDataJSON()).toEqual({ accountId: 'link-one', messageId: 'dmsg', threadId: 't9' })
      await route.fulfill({ status: 201, json: { draft } })
    })
    let saves = 0
    let pendingSave: import('@playwright/test').Route | undefined
    await page.route('http://127.0.0.1:8411/v1/drafts/draft-9', async (route) => {
      saves += 1
      if (saveOutcome === 'pending') { pendingSave = route; return }
      if (saveOutcome === 'fails') return route.fulfill({ status: 502, json: { error: 'gmail_draft_update_failed', detail: 'connector refused' } })
      const fields = await route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ json: { draft: { ...draft, bodyMarkdown: fields.bodyMarkdown, bodyText: fields.bodyText } } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Drafts', exact: true }).click()
    await page.locator('[data-conversation-id="link-one:t9"]').click()
    const body = page.getByRole('textbox', { name: 'Draft body' })
    await expect(body).toHaveValue('Hi Ana')
    await body.fill('Hi Ana, edited')
    if (saveOutcome === 'pending') await expect.poll(() => Boolean(pendingSave)).toBe(true)
    await page.getByRole('button', { name: 'Inbox', exact: true }).click()
    await page.locator('[data-conversation-id="demo:t2"]').click()
    await expect(page.getByRole('heading', { name: 'Services agreement' })).toBeVisible({ timeout: 5000 })
    await page.locator('[data-conversation-id="demo:t1"]').click()
    await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
    await expect(page.locator('.dispatch-thread-body').first()).toContainText('Inbox body')
    await expect(page.getByRole('textbox', { name: 'Draft body' })).toBeHidden()
    await expect.poll(() => saves).toBeGreaterThanOrEqual(1)
    await expect(page.locator('[data-mail-error]')).toBeHidden()
    if (saveOutcome !== 'succeeds') expect(await page.evaluate(() => localStorage.getItem('dispatch.editor-recovery.v1'))).toContain('Hi Ana, edited')
    if (pendingSave) await pendingSave.fulfill({ status: 502, json: { error: 'gmail_draft_update_failed', detail: 'delayed provider failure' } })
  })
}

test('cached draft opens immediately and a late refresh cannot overwrite newer edits', async ({ page }) => {
  const draft = { id: 'cached', accountId: 'one', gmailThreadId: 't1', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Cached draft', bodyMarkdown: 'Stored content', bodyText: 'Stored content', bodyHtml: '<p>Stored content</p>', attachments: [], state: 'draft', cachedAt: '2026-09-11T00:00:00Z' }
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [{ ...conversations[0], accountId: 'one', subject: 'Cached draft' }] } }))
  await page.route('http://127.0.0.1:8411/v1/drafts/open', route => route.fulfill({ json: { draft } }))
  let refreshing: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/drafts/cached?account=one', route => { refreshing = route })
  await page.goto('/')
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await expect(page.getByLabel('Draft body')).toHaveValue('Stored content')
  await expect(page.locator('[data-send-draft]')).toBeDisabled()
  await expect.poll(() => Boolean(refreshing)).toBe(true)
  await page.getByLabel('Draft body').fill('My newer edit')
  await refreshing!.fulfill({ json: { draft: { ...draft, cachedAt: undefined, bodyMarkdown: 'Remote older version' } } })
  await expect(page.getByLabel('Draft body')).toHaveValue('My newer edit')
})

test('renders inline code in Codex replies as readable inline text, not badges', async ({ page }) => {
  await page.goto('/')
  const rendered = await page.evaluate(async () => {
    const { renderChatMarkdown } = await import(/* @vite-ignore */ ('/src/chat-renderer' + '.ts')) as { renderChatMarkdown: (value: string) => HTMLElement }
    const root = renderChatMarkdown('I can update drafts, but I must never call `gmail.send_draft` or `gmail.send_email`.')
    document.body.append(root)
    const codes = [...root.querySelectorAll('code')]
    return {
      text: root.textContent,
      classes: codes.map((code) => code.className),
      fontFamily: getComputedStyle(codes[0]!).fontFamily,
      transform: getComputedStyle(codes[0]!).textTransform,
    }
  })
  expect(rendered.text?.trim()).toBe('I can update drafts, but I must never call gmail.send_draft or gmail.send_email.')
  expect(rendered.classes).toEqual(['dispatch-inline-code', 'dispatch-inline-code'])
  expect(rendered.fontFamily).toMatch(/mono/i)
  expect(rendered.transform).toBe('none')
})

test('answers a connector permission prompt with one click', async ({ page }) => {
  let answer: unknown
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads', (route) => route.fulfill({ status: 201, json: { thread: { id: 'thread-test' } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-test', created: true, replaced: false } } }))
  await page.route('http://127.0.0.1:8412/v1/server-requests/respond', async (route) => {
    answer = await route.request().postDataJSON()
    await route.fulfill({ json: { status: 'resolved' } })
  })
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: [
      'data: {"method":"turn/started","params":{"threadId":"thread-test","turn":{"status":"inProgress"}}}\n\n',
      'data: {"id":7,"method":"mcpServer/elicitation/request","params":{"threadId":"thread-test","message":"Allow Gmail to run tool \\"gmail.update_draft\\"?","requestedSchema":{"type":"object","properties":{}}}}\n\n',
    ].join(''),
  }))
  await page.goto('/')
  await expect(page.getByText('Allow this connector action?')).toBeVisible()
  await expect(page.getByText('Allow Gmail to run tool "gmail.update_draft"?')).toBeVisible()
  await expect(page.locator('.dispatch-request-json')).toHaveCount(0)
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect.poll(() => answer).toEqual({ id: 7, result: { action: 'accept', content: {} } })
})

test('reloads the Drafts list when a Codex turn completes', async ({ page }) => {
  let draftLists = 0
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ json: { status: 'ready' } }))
  await page.route('http://127.0.0.1:8412/v1/apps', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('http://127.0.0.1:8412/v1/threads', (route) => route.fulfill({ status: 201, json: { thread: { id: 'thread-test' } } }))
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', (route) => route.fulfill({ json: { binding: { key: { kind: 'unbound' }, threadId: 'thread-test', created: true, replaced: false } } }))
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/events\?threadId=.*/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"method":"turn/completed","params":{"threadId":"thread-test","turn":{"status":"completed"}}}\n\n' })
  })
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?.*/, (route) => {
    if (new URL(route.request().url()).searchParams.get('mailbox') === 'drafts') draftLists += 1
    return route.fulfill({ json: { source: 'demo', conversations: [], nextCursor: null, total: 0 } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await expect.poll(() => draftLists).toBeGreaterThanOrEqual(1)
  const before = draftLists
  await expect.poll(() => draftLists, { timeout: 5000 }).toBeGreaterThan(before)
})

test('collapses thread attachments and opens repeated filenames from their exact parent email', async ({ page }) => {
  let opened = ''
  const attachment = { id: 'same-id', name: 'arrival.pdf', mediaType: 'application/pdf', sizeLabel: '12 KB' }
  const newer = { ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Latest email' }, attachments: [attachment] }
  const older = { ...newer, id: 'older-email', receivedAt: '2026-09-03T07:30:00+12:00', receivedFullLabel: 'September 3, 2026 at 7:30 AM', attachments: [attachment] }
  await page.route(/8411\/v1\/conversations\/t1/, (route) => route.fulfill({ json: { conversation: { ...conversations[0]!, accountId: 'link-one', source: 'gmail', messages: [older, newer] } } }))
  await page.route(/8411\/v1\/messages\/.+\/attachments\/.+\/cache/, (route) => route.fulfill({ json: { cached: true } }))
  await page.route(/8411\/v1\/messages\/.+\/attachments\/.+\/open/, (route) => {
    opened = route.request().url()
    return route.fulfill({ json: { opened: true } })
  })
  await page.goto('/')
  const toggle = page.locator('[data-thread-files-toggle]')
  const files = page.getByRole('region', { name: 'All attachments in this thread' })
  await expect(toggle).toHaveText('2 attachments')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(files).toBeHidden()
  await expect(page.locator('[data-conversation-id="demo:t1"] .dispatch-attachment-indicator')).toHaveText('2')
  await toggle.click()
  await expect(files).toBeVisible()
  await expect(files.locator('.dispatch-thread-file')).toHaveCount(2)
  await expect(files.locator('.dispatch-thread-file').first()).toContainText('September 4')
  await files.locator('.dispatch-thread-file-open').nth(1).click()
  await expect.poll(() => opened).toBe('http://127.0.0.1:8411/v1/messages/older-email/attachments/same-id/open?filename=arrival.pdf&account=link-one')
  await files.getByRole('button', { name: /Go to email.*September 3/ }).click()
  await expect(page.locator('[data-message-id="older-email"]')).not.toHaveClass(/dispatch-thread-collapsed/)
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(files).toBeHidden()
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(toggle).toBeHidden()
})

test('clears an earlier thread attachment before asking about another account', async ({page}) => {
  await stubAgent(page)
  let sent: any
  await page.route(/8411\/v1\/conversations\/t1/,route=>route.fulfill({json:{conversation:{...conversations[0],accountId:'account-A',source:'gmail',messages:[{...messages[0],accountId:'account-A',source:'gmail',body:{kind:'plain-text',content:'Thread A'},attachments:[{id:'file-A',name:'only-in-A.pdf',mediaType:'application/pdf',sizeLabel:'1 KB'}]}]}}}))
  await page.route(/8411\/v1\/conversations\/t2/, route => route.fulfill({ json: { conversation: { ...conversations[1], accountId: 'account-B', source: 'gmail', messages: [{ ...messages[1], accountId: 'account-B', source: 'gmail', body: { kind: 'plain-text', content: 'Hello from B' }, attachments: [] }] } } }))
  await page.route(/8411\/v1\/messages\/.+\/attachments\/.+/,route=>route.fulfill({json:{opened:true,cached:true}}))
  await page.route(/8412\/v1\/threads\/.+\/turns/,async route=>{sent=route.request().postDataJSON();await route.fulfill({json:{turn:{id:'turn-1'}}})})
  await page.goto('/')
  await page.getByRole('button',{name:'PDF only-in-A.pdf 1 KB',exact:true}).click()
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.locator('[data-body]')).toContainText('Hello')
  await expect(page.getByText('History for thread-conversation%3Aaccount-B%3At2', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Codex' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Summarize the selected thread')
  await page.locator('[data-send]').click()
  await expect.poll(()=>sent?.mailContext?.threadId).toBe('t2')
  expect(sent.mailContext.attachment).toBeUndefined()
  expect(sent.mailContext.accountId).toBe('account-B')
})

test('keeps local draft edits when an AI completion refresh returns late', async ({page})=>{
  await page.addInitScript(()=>{
    class FakeEvents {
      static CLOSED=2;readyState=1;onopen:any;onmessage:any;onerror:any;
      constructor(){(window as any).auditEvents=this;setTimeout(()=>this.onopen?.({}),0)}
      close(){this.readyState=2}
    }
    ;(window as any).EventSource=FakeEvents
  })
  await stubAgent(page)
  const draft={id:'audit-draft',inReplyToMessageId:'m1',accountId:'account-A',to:[messages[0]!.sender],subject:'Draft',bodyMarkdown:'Saved older text',bodyHtml:'<p>Saved older text</p>',bodyText:'Saved older text',attachments:[],state:'draft'}
  await page.route('http://127.0.0.1:8411/v1/drafts',route=>route.fulfill({json:{draft}}))
  let pending:any
  await page.route(/8411\/v1\/drafts\/audit-draft/,async route=>{if(route.request().method()==='GET'){pending=route;return new Promise(()=>{})}return route.fulfill({json:{draft}})})
  await page.goto('/')
  await expect(page.getByText('History for thread-conversation%3Ademo%3At1', { exact: true })).toBeVisible()
  await expect(page.locator('[data-agent-status]')).toHaveAttribute('data-status', 'Connected')
  await page.getByRole('button',{name:'Reply',exact:true}).click()
  await expect(page.locator('[data-draft-body]')).toHaveValue('Saved older text')
  await page.evaluate(()=>{(window as any).auditEvents.onmessage({data:JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}})})})
  await expect.poll(()=>Boolean(pending)).toBe(true)
  await page.locator('[data-draft-body]').fill('My newer unsaved edit')
  await pending.fulfill({json:{draft}})
  await expect(page.locator('[data-draft-body]')).toHaveValue('My newer unsaved edit')
})


for (const intervening of ['edit', 'switch', 'none'] as const) {
  test(`handles a newly created AI draft with an intervening ${intervening}`, async ({ page }) => {
    await page.addInitScript(() => {
      class FakeEvents {
        static CLOSED = 2; readyState = 1; onopen: any; onmessage: any; onerror: any
        constructor() { (window as any).auditEvents = this; setTimeout(() => this.onopen?.({}), 0) }
        close() { this.readyState = 2 }
      }
      ;(window as any).EventSource = FakeEvents
    })
    await stubAgent(page)
    const draft = { id: 'new-ai-draft', accountId: 'account-A', inReplyToMessageId: 'm1', to: [messages[0]!.sender], subject: 'AI draft', bodyMarkdown: 'AI saved text', bodyHtml: '<p>AI saved text</p>', bodyText: 'AI saved text', attachments: [], state: 'draft' }
    let pending: import('@playwright/test').Route | undefined
    await page.route(/8411\/v1\/drafts\/new-ai-draft/, async (route) => { pending = route; await new Promise(() => {}) })
    await page.goto('/')
    await expect(page.getByText('History for thread-conversation%3Ademo%3At1', { exact: true })).toBeVisible()
    await expect(page.locator('[data-agent-status]')).toHaveAttribute('data-status', 'Connected')
    if (intervening === 'edit') await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await page.evaluate(() => (window as any).auditEvents.onmessage({ data: JSON.stringify({ method: 'item/completed', params: { item: { type: 'mcpToolCall', status: 'completed', tool: 'gmail.create_draft', arguments: { link_id: 'account-A' }, result: { structuredContent: { id: 'new-ai-draft', message: { id: 'new-message' } } } } } }) }))
    await expect.poll(() => Boolean(pending)).toBe(true)
    if (intervening === 'edit') await page.locator('[data-draft-body]').fill('My local draft')
    if (intervening === 'switch') await page.locator('[data-conversation-id="demo:t2"]').click()
    await pending!.fulfill({ json: { draft } })
    if (intervening === 'none') await expect(page.locator('[data-draft-body]')).toHaveValue('AI saved text')
    if (intervening === 'edit') await expect(page.locator('[data-draft-body]')).toHaveValue('My local draft')
    if (intervening === 'switch') await expect(page.locator('[data-draft]')).toBeHidden()
  })
}

for (const hasRecipient of [true, false]) {
  test(`Send ${hasRecipient ? 'uses an unchanged Gmail draft without rewriting it' : 'blocks an empty recipient list before any write'}`, async ({ page }) => {
    const writes: string[] = []
    const draft = { id: 'send-existing', accountId: 'account-A', inReplyToMessageId: 'm1', to: hasRecipient ? [messages[0]!.sender] : [], cc: '', bcc: '', subject: 'Existing draft', bodyMarkdown: 'Read-only projection', bodyHtml: '<p>Original HTML</p>', bodyText: 'Read-only projection', attachments: [], state: 'draft' }
    await page.route('http://127.0.0.1:8411/v1/drafts', route => route.fulfill({ json: { draft } }))
    await page.route(/8411\/v1\/drafts\/send-existing/, route => {
      writes.push(route.request().method() + ':' + new URL(route.request().url()).searchParams.get('action'))
      return route.fulfill({ json: route.request().method() === 'PUT' ? { draft } : { delivery: { id: 'sent-message' } } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(page.locator('[data-draft-body]')).toHaveValue('Read-only projection')
    await page.locator('[data-send-draft]').click()
    if (hasRecipient) {
      await page.locator('[data-send-confirm-go]').click()
      await expect.poll(() => writes).toEqual(['POST:send'])
    } else {
      await expect(page.locator('[data-draft-error]')).toContainText('Add a recipient')
      await expect(page.locator('[data-send-confirm]')).toBeHidden()
      expect(writes).toEqual([])
    }
  })
}

async function searchEvents(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    class Events {
      static CLOSED = 2; readyState = 1; onopen: any; onmessage: any; onerror: any
      constructor() { (window as any).searchEvents = this; setTimeout(() => this.onopen?.({}), 0) }
      close() { this.readyState = 2 }
    }
    ;(window as any).EventSource = Events
  })
  await stubAgent(page)
}
async function publishSearch(page: import('@playwright/test').Page, searchResults: unknown) {
  await page.evaluate(searchResults => (window as any).searchEvents.onmessage({ data: JSON.stringify({ method: 'item/completed', params: { item: { type: 'mcpToolCall', server: 'dispatch_mail', tool: 'show_search_results', status: 'completed', result: { structuredContent: { searchResults } } } } }) }), searchResults)
}

test('natural-language search renders a selectable source list and highlights the matching older email', async ({ page }) => {
  await searchEvents(page)
  let prompt = ''
  let searchTurnPayload: any
  await page.route(/8412\/v1\/threads\/.+\/turns/, async route => { searchTurnPayload = route.request().postDataJSON(); prompt = searchTurnPayload.text; await route.fulfill({ json: { turn: { id: 'search-turn' } } }) })
  const summary = { ...conversations[0]!, id: 'account-A:outside-thread', accountId: 'account-A', accountLabel: 'work@example.com', threadId: 'outside-thread', latestMessageId: 'old-hit', subject: 'Delivery commitment', unread: false }
  const older = { ...messages[0]!, id: 'old-hit', threadId: 'outside-thread', accountId: 'account-A', source: 'gmail', unread: false, receivedAt: '2026-09-02T08:00:00Z', body: { kind: 'sanitized-html', content: '<p>We agreed to <strong>September</strong> delivery.</p>' }, attachments: [] }
  await page.route(/8411\/v1\/conversations\/outside-thread/, route => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...older, id: 'new-hit', receivedAt: '2026-09-03T08:00:00Z', body: { kind: 'plain-text', content: 'Thanks, noted.' } }, older] } } }))
  await page.route('http://127.0.0.1:8411/v1/sync', route => route.fulfill({ json: { sync: { state: 'ready', completedAt: '2026-09-08T08:00:00Z' } } }))
  await page.goto('/')
  await expect(page.getByText('History for thread-conversation%3Ademo%3At1', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search mail' }).fill('Find the email where we agreed to September delivery')
  await page.getByRole('textbox', { name: 'Search mail' }).press('Enter')
  await expect.poll(() => prompt).toContain('show_search_results')
  const requestId = /using requestId ([\w-]+)/.exec(prompt)![1]
  expect(prompt).toContain('all connected Gmail accounts')
  const quote = 'We agreed to September delivery.'
  await publishSearch(page, { query: 'September delivery', requestId, results: [{ conversation: summary, hits: [{ messageId: 'old-hit', quote, excerpt: quote, matchStart: 0, matchEnd: quote.length, reason: 'The customer confirms the delivery month.' }] }] })
  await expect(page.locator('[data-search-summary]')).toHaveText('1 matching thread · Codex search')
  await expect(page.locator('[data-message-list] .dispatch-message')).toHaveCount(1)
  await expect(page.locator('[data-message-list] mark')).toHaveText(quote)
  await page.locator('[data-conversation-id="account-A:outside-thread"]').click()
  await expect(page.locator('[data-message-id="old-hit"]')).not.toHaveClass(/dispatch-thread-collapsed/)
  await expect.poll(async () => (await page.locator('[data-message-id="old-hit"] .dispatch-thread-content mark').allTextContents()).join('')).toBe(quote)
  await expect(page.getByText('History for thread-conversation%3Aaccount-A%3Aoutside-thread', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Explain this commitment')
  await page.locator('[data-send]').click()
  await expect.poll(() => searchTurnPayload?.mailContext?.searchMatch?.hits?.[0]?.messageId).toBe('old-hit')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await expect(page.locator('[data-message-list] .dispatch-message')).toHaveCount(1)
  await page.getByRole('button', { name: 'Return to mailbox' }).click()
  await expect(page.locator('[data-message-list] .dispatch-message')).toHaveCount(2)
  await expect(page.locator('[data-search-status]')).toBeHidden()
  await publishSearch(page, { query: 'Late result after Clear', results: [] })
  await expect(page.locator('[data-search-status]')).toBeHidden()
  await expect(page.locator('[data-message-list] .dispatch-message')).toHaveCount(2)
})

test('a superseded search cannot replace newer results and empty results are explicit', async ({ page }) => {
  await searchEvents(page)
  const prompts: string[] = []
  await page.route(/8412\/v1\/threads\/.+\/turns/, async route => { prompts.push(route.request().postDataJSON().text); await route.fulfill({ json: { turn: { id: 'search-turn' } } }) })
  await page.goto('/')
  await expect(page.getByText('History for thread-conversation%3Ademo%3At1', { exact: true })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Search mail' })
  await input.fill('first search'); await input.press('Enter')
  await expect.poll(() => prompts.length).toBe(1)
  await input.fill('second search'); await input.press('Enter')
  await expect.poll(() => prompts.length).toBe(2)
  const first = /using requestId ([\w-]+)/.exec(prompts[0]!)![1]
  const second = /using requestId ([\w-]+)/.exec(prompts[1]!)![1]
  await publishSearch(page, { query: 'first search', requestId: first, results: [] })
  await expect(page.locator('[data-search-summary]')).toHaveText('Searching with Codex…')
  await publishSearch(page, { query: 'second search', requestId: second, results: [] })
  await expect(page.locator('[data-search-summary]')).toHaveText('0 matching threads · Codex search')
  await expect(page.getByText('No matching conversations.', { exact: true })).toBeVisible()
})

test('a search requested in ordinary Codex chat can also publish the mail list', async ({ page }) => {
  await searchEvents(page)
  await page.goto('/')
  await expect(page.getByText('History for thread-conversation%3Ademo%3At1', { exact: true })).toBeVisible()
  await publishSearch(page, { query: 'Related correspondence', results: [] })
  await expect(page.locator('[data-search-summary]')).toHaveText('0 matching threads · Codex search')
  await expect(page.getByRole('textbox', { name: 'Search mail' })).toHaveValue('Related correspondence')
})

test('recovers unsaved recipients, text and file bytes after a reload without sending', async ({ page }) => {
  const writes: string[] = []
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/drafts(?:$|\/[^p])/, route => { writes.push(route.request().method()); return route.fulfill({ status: 503, json: { error: 'Gmail unavailable' } }) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.locator('[data-draft-to]').fill('ana@example.com')
  await page.locator('[data-draft-cc]').fill('cc@example.com')
  await page.locator('[data-draft-bcc]').fill('bcc@example.com')
  await page.locator('[data-draft-subject]').fill('Unsaved recovery proof')
  await page.locator('[data-draft-body]').fill('Text entered before Gmail can save it.')
  await page.locator('[data-draft-files]').setInputFiles({ name: 'proof.txt', mimeType: 'text/plain', buffer: Buffer.from('Persist these bytes') })
  await expect(page.locator('[data-draft-attachments]')).toContainText('proof.txt')
  await expect(page.locator('[data-recovery-status]')).toContainText('waiting to sync')
  await expect(page.locator('[data-draft-error]')).toBeHidden()
  await page.reload()
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await page.locator('[data-local-draft-key]').filter({ hasText: 'Unsaved recovery proof' }).click()
  await expect(page.locator('[data-draft-body]')).toHaveValue('Text entered before Gmail can save it.')
  await expect(page.locator('[data-draft-subject]')).toHaveValue('Unsaved recovery proof')
  await expect(page.locator('[data-draft]')).toContainText('cc@example.com')
  await expect(page.locator('[data-draft]')).toContainText('bcc@example.com')
  await expect(page.locator('[data-draft-account]')).toHaveValue('one')
  const bytes = await page.evaluate(async () => {
    const modulePath = '/src/draft-recovery.ts'; const { DraftRecovery } = await import(modulePath)
    const recovery = new DraftRecovery(); return (await recovery.restore(recovery.list()[0]!.key)).attachments[0]?.contentBase64
  })
  expect(Buffer.from(bytes!, 'base64').toString()).toBe('Persist these bytes')
  expect(writes).toEqual(['POST'])
  await page.locator('[data-discard-draft]').click()
  await expect(page.locator('[data-recovery-open]')).toBeHidden()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dispatch.editor-recovery.v1')!))).toEqual([])
})

test('autosaves a new draft and keeps recovery out of the Inbox', async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  let saved = false
  await page.route('http://127.0.0.1:8411/v1/drafts', route => {
    saved = true
    const fields = route.request().postDataJSON()
    return route.fulfill({ json: { draft: { ...fields, id: 'autosaved', accountId: 'one', inReplyToMessageId: '', to: [], bodyHtml: '<p>New draft text</p>', attachments: [], state: 'draft' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByLabel('Draft body').fill('New draft text')
  await expect.poll(() => saved).toBe(true)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('dispatch.editor-recovery.v1') ?? '[]').length)).toBe(0)
  await expect(page.locator('.dispatch-recovery-banner, [data-recovery-open]')).toHaveCount(0)
})

test('retries an unsent draft from a previous session without opening its editor', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dispatch.editor-recovery.v1', JSON.stringify([{ key: 'queued-draft', updatedAt: '2026-09-11T00:00:00Z', revision: 1, accountId: 'one', gmailDraftId: '', inReplyToMessageId: '', to: 'work@example.com', cc: '', bcc: '', subject: 'Queued draft', bodyMarkdown: 'Keep this text', attachments: [] }])))
  const writes: any[] = []
  await page.route('http://127.0.0.1:8411/v1/drafts', route => {
    const fields = route.request().postDataJSON(); writes.push(fields)
    if (writes.length === 1) return route.fulfill({ status: 503, json: { error: 'temporarily unavailable' } })
    return route.fulfill({ json: { draft: { ...fields, id: 'saved', gmailThreadId: 'saved-thread', accountId: 'one', inReplyToMessageId: '', to: [], bodyHtml: '<p>Keep this text</p>', attachments: [], state: 'draft' } } })
  })
  await page.goto('/')
  await expect.poll(() => writes.length, { timeout: 20_000 }).toBe(2)
  expect(writes.map(write => write.clientDraftId)).toEqual(['queued-draft', 'queued-draft'])
  expect(writes[1].bodyMarkdown).toBe('Keep this text')
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('dispatch.editor-recovery.v1') ?? '[]').length)).toBe(0)
  await expect(page.getByText('Saved on this Mac', { exact: true })).toHaveCount(0)
})

test('keeps a newer recovery copy while an older Gmail save is pending', async ({ page }) => {
  let pending: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', route => { pending = route })
  await page.goto('/'); await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.locator('[data-draft-body]').fill('Older text')
  await page.locator('[data-save-draft]').click(); await expect.poll(() => Boolean(pending)).toBe(true)
  await page.locator('[data-draft-body]').fill('Newer text')
  await pending!.fulfill({ json: { draft: { id: 'saved', accountId: 'one', inReplyToMessageId: '', to: [], subject: '', bodyMarkdown: 'Older text', bodyText: 'Older text', bodyHtml: '<p>Older text</p>', attachments: [], state: 'draft' } } })
  await expect(page.locator('[data-draft-body]')).toHaveValue('Newer text')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dispatch.editor-recovery.v1')!)[0].bodyMarkdown)).toBe('Newer text')
})

test('keeps sending quiet and locks edits until Gmail responds', async ({ page }) => {
  const draft = { id: 'd-receipt', accountId: 'one', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Delivery', bodyMarkdown: 'Hello', bodyText: 'Hello', bodyHtml: '<p>Hello</p>', attachments: [], state: 'draft' }
  let pending: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/drafts', route => route.fulfill({ json: { draft } }))
  await page.route(/8411\/v1\/drafts\/d-receipt/, route => { pending = route })
  await page.goto('/'); await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await page.locator('[data-send-draft]').click(); await page.locator('[data-send-confirm-go]').click()
  await expect(page.locator('[data-draft-body]')).toBeDisabled()
  await expect.poll(() => Boolean(pending)).toBe(true)
  await pending!.fulfill({ json: { receipt: { id: 'receipt-proof', accountId: 'one', accountLabel: 'work@example.com', draftId: draft.id, messageId: 'provider-id', status: 'verified', requestedAt: '2026-09-08T01:00:00Z', detailsSource: 'sent-message', details: { to: ['ana@example.com'], cc: ['cc@example.com'], bcc: ['audit@example.com'], subject: 'Delivery', attachments: [{ name: 'contract.pdf', mediaType: 'application/pdf', sizeLabel: '10 KB' }] } } } })
  await expect(page.locator('[data-receipts-dialog]')).toHaveCount(0)
  await expect(page.locator('[data-draft]')).toBeHidden()
})

test('reads downloaded mail with a visible timestamp and blocks remote images', async ({ page }) => {
  const requests: string[] = []
  await page.addInitScript(() => { localStorage.setItem('dispatch.offline-mode', 'true'); localStorage.setItem('dispatch.offline-mode-source', 'manual') })
  await page.route(/8411\/v1\/accounts/, route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/conversations\?/, route => { requests.push(route.request().url()); return route.fulfill({ json: { source: 'gmail', coverage: 'downloaded', conversations: [{ ...conversations[0], accountId: 'one', downloaded: true }] } }) })
  await page.route(/8411\/v1\/conversations\/t1/, route => { requests.push(route.request().url()); return route.fulfill({ json: { conversation: { ...conversations[0], accountId: 'one', source: 'gmail', availability: { mode: 'downloaded', cachedAt: '2026-09-08T01:00:00Z' }, messages: [{ ...messages[0], accountId: 'one', source: 'gmail', body: { kind: 'sanitized-html', content: '<p>Full downloaded body</p><img src="https://tracker.example/pixel" srcset="https://tracker.example/high 2x"><div style="background-image:url(https://tracker.example/bg)">No remote background</div>' }, attachments: [] }] } } }) })
  await page.goto('/')
  await expect(page.locator('[data-body]')).toContainText('Full downloaded body')
  await expect(page.locator('[data-copy-status]')).toContainText('Downloaded copy')
  await expect(page.locator('[data-body] img')).not.toHaveAttribute('src')
  await expect(page.locator('[data-body] img')).not.toHaveAttribute('srcset')
  await expect(page.locator('[data-body] [style*=tracker]')).toHaveCount(0)
  expect(requests.length).toBeGreaterThanOrEqual(2)
  expect(requests.every(url => new URL(url).searchParams.get('offline') === 'true')).toBe(true)
  await page.locator('[data-activity-toggle]').click()
  await page.locator('[data-offline-open]').click()
  await expect(page.locator('[data-download-mailbox]')).toBeDisabled()
})

test('trial sidebar and density persist while utilities stay out of mailbox navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Mail folders' })).toBeVisible()
  await expect(page.locator('.dispatch-rail')).toHaveAttribute('data-style', 'compact')
  await expect(page.locator('.dispatch-message small').first()).toBeHidden()
  await page.locator('[data-density]').click()
  await expect(page.locator('.dispatch-message small').first()).toBeVisible()
  await page.locator('[data-mailboxes-toggle]').click()
  await expect(page.getByRole('navigation', { name: 'Mail folders' })).toBeHidden()
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Mail folders' })).toBeHidden()
  await page.locator('[data-mailboxes-toggle]').click()
  await expect(page.getByRole('navigation', { name: 'Mail folders' })).toBeVisible()
  await page.locator('[data-sidebar-options]').click()
  await page.getByRole('menuitemradio', { name: 'Expanded' }).click()
  await expect(page.locator('.dispatch-rail')).toHaveAttribute('data-style', 'expanded')
  await expect(page.locator('.dispatch-rail [data-offline-open]')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Mail folders' })).toBeVisible()
  await expect(page.locator('[data-density]')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.dispatch-rail')).toHaveAttribute('data-style', 'expanded')
  await page.setViewportSize({ width: 900, height: 800 })
  await expect(page.locator('.dispatch-rail')).toBeVisible()
  await expect(page.locator('.dispatch-rail')).toHaveAttribute('data-style', 'compact')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900)
  await page.locator('[data-activity-toggle]').click()
  await page.locator('[data-offline-open]').click()
  await expect(page.locator('[data-offline-dialog]')).toBeVisible()
  expect(await page.locator('[data-offline-dialog]').evaluate(node => node.matches(':modal'))).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-offline-dialog]')).toBeHidden()
  await expect(page.locator('[data-activity-toggle]')).toBeFocused()
})

test('sent mail has no receipt controls or background receipt requests', async ({ page }) => {
  let receiptRequests = 0
  await page.route(/8411\/v1\/send-receipts/, route => { receiptRequests++; return route.fulfill({ json: { receipts: [] } }) })
  await page.route(/8411\/v1\/conversations\/t1/, route => route.fulfill({ json: { conversation: { ...conversations[0], accountId: 'one', source: 'gmail', messages: [{ ...messages[0], accountId: 'one', labels: ['SENT'], body: { kind: 'plain-text', content: 'Sent message content' }, attachments: [] }] } } }))
  await page.goto('/')
  await expect(page.locator('[data-body]')).toContainText('Sent message content')
  await expect(page.locator('[data-receipts-open], [data-receipts-dialog], .dispatch-message-receipt')).toHaveCount(0)
  expect(receiptRequests).toBe(0)
})

test('email web links open through native controls and never replace the mail view', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { isTauri: boolean; __links: unknown[]; __TAURI__: unknown }
    w.isTauri = true; w.__links = []
    w.__TAURI__ = { core: { invoke: async (command: string, args: unknown) => { if (command !== 'set_appearance') w.__links.push({ command, args }); return null } } }
  })
  await page.route(/8411\/v1\/conversations\/t1/, route => route.fulfill({ json: { conversation: { ...conversations[0], source: 'demo', messages: [{ ...messages[0], source: 'demo', body: { kind: 'sanitized-html', content: '<p><a href="https://example.com/page?source=mail">Read the website</a> <a target="_blank" href="https://example.com/other">Another page</a></p>' }, attachments: [] }] } } }))
  await page.goto('/')
  await page.getByRole('link', { name: 'Read the website' }).click()
  await page.getByRole('link', { name: 'Another page' }).click()
  expect(await page.evaluate(() => (window as unknown as { __links: unknown[] }).__links)).toEqual([
    { command: 'open_web_link', args: { url: 'https://example.com/page?source=mail' } },
    { command: 'open_web_link', args: { url: 'https://example.com/other' } },
  ])
  expect(new URL(page.url()).pathname).toBe('/')
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
})

test('a failed native link open keeps mail visible and reports the failure', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { isTauri: boolean; __TAURI__: unknown }; w.isTauri = true
    w.__TAURI__ = { core: { invoke: async () => { throw new Error('Web window unavailable') } } }
  })
  await page.route(/8411\/v1\/conversations\/t1/, route => route.fulfill({ json: { conversation: { ...conversations[0], source: 'demo', messages: [{ ...messages[0], source: 'demo', body: { kind: 'sanitized-html', content: '<a href="https://example.com">Website</a>' }, attachments: [] }] } } }))
  await page.goto('/'); await page.getByRole('link', { name: 'Website', exact: true }).click()
  await expect(page.locator('[data-mail-error]')).toContainText('Web window unavailable')
  await expect(page.locator('[data-subject]')).toHaveText('Opua berth confirmation')
})

test('web toolbar uses native history and its close action returns to mail', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __actions: string[]; __TAURI__: unknown }; w.__actions = []
    w.__TAURI__ = { core: { invoke: async (command: string, args?: { action: string }) => {
      if (command === 'web_link_state') return { url: 'https://example.com/article', canGoBack: true, canGoForward: false }
      if (command === 'web_link_action') { w.__actions.push(args!.action); return null }
      throw new Error('Unexpected command')
    } } }
  })
  await page.goto('/browser.html')
  await expect(page.locator('[data-address]')).toHaveText('example.com')
  await expect(page.getByRole('button', { name: 'Forward', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Return to Mail' }).click()
  expect(await page.evaluate(() => (window as unknown as { __actions: string[] }).__actions)).toEqual(['back', 'close'])
})

for (const action of ['reply', 'forward']) test(`${action} opens before Gmail responds, keeps typing, and prevents duplicate creation`, async ({ page }) => {
  let pending: import('@playwright/test').Route | undefined
  let creates = 0
  const updates: Record<string, unknown>[] = []
  const draft = { id: 'fast-reply', accountId: 'one', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Re: Opua berth confirmation', bodyMarkdown: '> Original', bodyHtml: '<p>Original</p>', bodyText: '> Original', attachments: [], state: 'draft' }
  await page.route(/8411\/v1\/conversations\/t1/, route => route.fulfill({ json: { conversation: { ...conversations[0], accountId: 'one', source: 'gmail', messages: [{ ...messages[0], accountId: 'one', source: 'gmail', body: { kind: 'plain-text', content: 'Original' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', route => { creates++; pending = route })
  await page.route(/8411\/v1\/drafts\/fast-reply$/, route => { const body = route.request().postDataJSON(); updates.push(body); return route.fulfill({ json: { draft: { ...draft, bodyMarkdown: body.bodyMarkdown, bodyText: body.bodyMarkdown } } }) })
  await page.goto('/'); await expect(page.locator('[data-body]')).toContainText('Original')
  await page.locator(`[data-${action}]`).click()
  await expect(page.locator('[data-draft-body]')).toBeVisible()
  await expect.poll(() => Boolean(pending)).toBe(true)
  await page.locator('[data-draft-body]').fill('My immediate edit')
  await page.locator(`[data-${action}]`).click()
  expect(creates).toBe(1)
  await expect(page.locator('[data-draft-body]')).toHaveValue('My immediate edit')
  await pending!.fulfill({ json: { draft } })
  await expect(page.locator('[data-draft-body]')).toHaveValue('My immediate edit')
  await expect.poll(() => updates.at(-1)?.bodyMarkdown).toBe('My immediate edit')
  await expect(page.locator('[data-recovery-open]')).toBeHidden()
})

test('switching away from a pending reply keeps its recovery identity without replacing the new thread', async ({ page }) => {
  let pending: import('@playwright/test').Route | undefined
  await page.route(/8411\/v1\/conversations\/t1/, route => route.fulfill({ json: { conversation: { ...conversations[0], accountId: 'one', source: 'gmail', messages: [{ ...messages[0], accountId: 'one', source: 'gmail', body: { kind: 'plain-text', content: 'Original' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', route => { pending = route })
  await page.goto('/'); await expect(page.locator('[data-body]')).toContainText('Original')
  await page.locator('[data-reply]').click(); await expect.poll(() => Boolean(pending)).toBe(true)
  await page.locator('[data-draft-body]').fill('Keep my unsaved words')
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.locator('[data-subject]')).toHaveText('Services agreement')
  await pending!.fulfill({ json: { draft: { id: 'late-reply', accountId: 'one', inReplyToMessageId: 'm1', to: [], cc: '', bcc: '', subject: 'Reply', bodyMarkdown: 'Original', bodyText: 'Original', bodyHtml: '', attachments: [], state: 'draft' } } })
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('dispatch.editor-recovery.v1')!)[0]?.gmailDraftId)).toBe('late-reply')
  await expect(page.locator('[data-subject]')).toHaveText('Services agreement')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dispatch.editor-recovery.v1')!)[0]?.bodyMarkdown)).toBe('Keep my unsaved words')
})

test('Word mail shows new paragraphs normally and folds only the actual quote', async ({ page }) => {
  const html = '<div class="WordSection1"><p>Hi Steve,</p><p>I will ask the guys and get more feedback soon.</p><blockquote><div>Earlier email<blockquote>Even older</blockquote></div></blockquote><p>A new inline closing note.</p></div>'
  await page.route(/8411\/v1\/conversations\/t1/, route => route.fulfill({ json: { conversation: { ...conversations[0], source: 'demo', messages: [{ ...messages[0], source: 'demo', body: { kind: 'sanitized-html', content: html }, attachments: [] }] } } }))
  await page.goto('/')
  await expect(page.getByText('I will ask the guys and get more feedback soon.', { exact: true })).toBeVisible()
  await expect(page.getByText('A new inline closing note.', { exact: true })).toBeVisible()
  const history = page.locator('.dispatch-quoted-history')
  await expect(history).toHaveCount(1)
  await expect(history).not.toContainText('I will ask the guys')
  await expect(page.getByText('Even older', { exact: true })).toBeHidden()
  await history.locator('summary').click()
  await expect(page.getByText('Even older', { exact: true })).toBeVisible()
  const sourceText = await page.evaluate(async (html) => {
    const path = '/src/email-renderer.ts'; const { emailPlainText } = await import(path)
    return emailPlainText('sanitized-html', html)
  }, html)
  expect(sourceText).toContain('I will ask the guys')
  expect(sourceText).toContain('Earlier email')
  expect(sourceText).not.toContain('Quoted history')
})

test('an Outlook reply header does not hide new text in its shared wrapper', async ({ page }) => {
  const html = '<div><p>Newest message</p><div id="divRplyFwdMsg">From: Earlier sender</div><p>Old message body</p></div>'
  await page.route(/8411\/v1\/conversations\/t1/, route => route.fulfill({ json: { conversation: { ...conversations[0], source: 'demo', messages: [{ ...messages[0], source: 'demo', body: { kind: 'sanitized-html', content: html }, attachments: [] }] } } }))
  await page.goto('/')
  await expect(page.getByText('Newest message', { exact: true })).toBeVisible()
  await expect(page.getByText('Old message body', { exact: true })).toBeHidden()
  await page.locator('.dispatch-quoted-history summary').click()
  await expect(page.getByText('Old message body', { exact: true })).toBeVisible()
})

test('changing folders does not reuse another folder’s thread projection', async ({ page }) => {
  const reads: string[] = []
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [{ ...conversations[0], accountId: 'one' }] } }))
  await page.route(/8411\/v1\/conversations\/t1/, route => {
    const mailbox = new URL(route.request().url()).searchParams.get('mailbox') ?? 'inbox'; reads.push(mailbox)
    return route.fulfill({ json: { conversation: { ...conversations[0], accountId: 'one', source: 'gmail', messages: [{ ...messages[0], accountId: 'one', source: 'gmail', body: { kind: 'plain-text', content: `${mailbox} body` }, attachments: [] }] } } })
  })
  await page.goto('/'); await expect(page.locator('[data-body]')).toContainText('inbox body')
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(page.locator('[data-body]')).toContainText('trash body')
  expect(reads).toEqual(['inbox', 'trash'])
})


test('clears the previous chat immediately while the next email body loads', async ({ page }) => {
  await stubAgent(page, { 'conversation:demo:t1': { threadId: 'only-A' }, 'conversation:demo:t2': { threadId: 'only-B' } })
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  await page.route(/8411\/v1\/conversations\/t2/, async route => {
    await delayed
    await route.fulfill({ json: { conversation: { ...conversations[1], source: 'demo', messages: [{ ...messages[1], source: 'demo', body: { kind: 'plain-text', content: 'B' }, attachments: [] }] } } })
  })
  await page.goto('/')
  await expect(page.getByText('History for only-A')).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Unsent question for A')
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.getByText('History for only-A')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Ask Codex' })).toHaveValue('')
  release()
  await expect(page.getByText('History for only-B')).toBeVisible()
})

test('failed email binding never shows general or previous chat during reconnect', async ({ page }) => {
  await stubAgent(page)
  let failures = 0
  const keys: string[] = []
  await page.route('http://127.0.0.1:8412/v1/threads/bindings', async route => {
    const key = route.request().postDataJSON()
    keys.push(key.gmailThreadId ?? 'unbound')
    if (key.gmailThreadId === 't2') {
      failures++
      await route.fulfill({ status: 502, json: { error: 'codex_binding_failed', detail: 'The selected task is archived' } })
    } else await route.fulfill({ json: { binding: { key, threadId: key.gmailThreadId === 't1' ? 'only-A' : 'general', created: false, replaced: false } } })
  })
  await page.goto('/')
  await expect(page.getByText('History for only-A')).toBeVisible()
  keys.length = 0
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect.poll(() => failures).toBeGreaterThanOrEqual(2)
  await expect(page.getByText('History for only-A')).toHaveCount(0)
  await expect(page.getByText('History for general')).toHaveCount(0)
  expect(keys.every(key => key === 't2')).toBe(true)
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await expect(page.getByText('History for only-A')).toBeVisible()
})


test('restores an ongoing compose turn after working on another email', async ({ page }) => {
  await stubAgent(page, { draft: { threadId: 'compose-task' } })
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route('http://127.0.0.1:8412/v1/threads/compose-task', route => route.fulfill({ json: {
    thread: { turns: [{ id: 'running-turn', status: 'inProgress', items: [{ type: 'agentMessage', text: 'Still preparing the draft' }] }] },
    dispatchActivity: { threadId: 'compose-task', status: 'Working', turnId: 'running-turn', requests: [] },
  } }))
  let interruptions = 0
  let steering: unknown
  await page.route(/8412\/v1\/threads\/.+\/interrupt/, route => { interruptions++; return route.fulfill({ json: {} }) })
  await page.route(/8412\/v1\/threads\/compose-task\/steer/, route => { steering = route.request().postDataJSON(); return route.fulfill({ json: {} }) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.getByText('Still preparing the draft')).toBeVisible()
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.getByText('Still preparing the draft')).toHaveCount(0)
  await page.getByRole('button', { name: 'Working · New email / general chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Use the shorter version')
  await page.locator('[data-send]').click()
  await expect.poll(() => steering).toEqual({ expectedTurnId: 'running-turn', text: 'Use the shorter version' })
  expect(interruptions).toBe(0)
})

test('opens a draft completed in the background when returning to compose', async ({ page }) => {
  await stubAgent(page, { draft: { threadId: 'compose-task' } })
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  let completed = false
  await page.route('http://127.0.0.1:8412/v1/threads/compose-task', route => route.fulfill({ json: {
    thread: { turns: [{ id: 'turn', status: completed ? 'completed' : 'inProgress', items: completed ? [{ type: 'mcpToolCall', status: 'completed', tool: 'gmail.create_draft', arguments: { link_id: 'one' }, result: { structuredContent: { draft_id: 'background-draft' } } }] : [] }] },
  } }))
  await page.route(/8411\/v1\/drafts\/background-draft/, route => route.fulfill({ json: { draft: { id: 'background-draft', accountId: 'one', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Background result', bodyMarkdown: 'Finished while away', bodyText: 'Finished while away', bodyHtml: '<p>Finished while away</p>', attachments: [], state: 'draft' } } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.locator('[data-conversation-id="demo:t2"]').click()
  completed = true
  await page.getByRole('button', { name: 'Working · New email / general chat', exact: true }).click()
  await expect(page.getByLabel('Draft subject')).toHaveValue('Background result')
  await expect(page.getByLabel('Draft body')).toHaveValue('Finished while away')
})

test('late history from a previous selection cannot replace the current chat', async ({ page }) => {
  await stubAgent(page, { 'conversation:demo:t1': { threadId: 'slow-A' }, 'conversation:demo:t2': { threadId: 'fast-B' } })
  let release!: () => void
  let requested = false
  const delayed = new Promise<void>(resolve => { release = resolve })
  await page.route('http://127.0.0.1:8412/v1/threads/slow-A', async route => {
    requested = true
    await delayed
    await route.fulfill({ json: { thread: { turns: [{ items: [{ type: 'agentMessage', text: 'Late private history A' }] }] } } })
  })
  await page.goto('/')
  await expect.poll(() => requested).toBe(true)
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.getByText('History for fast-B')).toBeVisible()
  release()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dispatch.codex.threadId'))).toBe('fast-B')
  await expect(page.getByText('Late private history A')).toHaveCount(0)
})

test('appearance follows the OS by default and takes the native View menu choice', async ({ page }) => {
  await stubAgent(page)
  await page.addInitScript(() => {
    const listeners: Record<string, (event: { payload: unknown }) => void> = {}
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    Object.assign(window, {
      isTauri: true,
      __appearance: { listeners, calls },
      __TAURI__: {
        core: { invoke: async (command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return {} } },
        event: { listen: async (name: string, handler: (event: { payload: unknown }) => void) => { listeners[name] = handler; return () => {} } },
      },
    })
  })
  type Bridge = { __appearance: { listeners: Record<string, (event: { payload: unknown }) => void>; calls: Array<{ command: string; args?: Record<string, unknown> }> } }
  const calls = () => page.evaluate(() => (window as unknown as Bridge).__appearance.calls)
  const choose = (preference: string) => page.evaluate((value) => (window as unknown as Bridge).__appearance.listeners['dispatch://appearance']!({ payload: value }), preference)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark')
  await expect.poll(calls).toContainEqual({ command: 'set_appearance', args: { preference: 'system' } })
  await expect(page.getByRole('menuitemradio', { name: 'Light' })).toHaveCount(0)
  await choose('light')
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light')
  await expect.poll(calls).toContainEqual({ command: 'set_appearance', args: { preference: 'light' } })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light')
  await expect.poll(calls).toContainEqual({ command: 'set_appearance', args: { preference: 'light' } })
  await choose('system')
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light')
})

test('provider HTML follows the dark theme with rewritten colours, layouts keep paper, and each message can flip', async ({ page }) => {
  await stubAgent(page)
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(.+)/)
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(.+)/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split('/').pop()
    const index = threadId === 't2' ? 1 : 0
    const content = index === 1
      ? '<table bgcolor="#e4002b"><tr><td><p>Big sale.</p></td></tr></table>'
      : '<div style="color:#1F497D"><p>Comments added.</p><span style="color:#333">Grey sign-off</span><b style="color:#e4002b">NOV</b></div>'
    const message = { ...messages[index]!, source: 'demo', body: { kind: 'sanitized-html', content }, attachments: [] }
    return route.fulfill({ json: { conversation: { ...conversations[index]!, source: 'demo', messages: [message] } } })
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await page.getByText('Opua berth confirmation').first().click()
  const body = page.locator('.dispatch-thread-body').first()
  await expect(body).toContainText('Comments added.')
  await expect(body).toHaveAttribute('data-surface', 'theme')
  await expect(body).toHaveAttribute('data-paper', 'false')
  await expect(body.locator('span')).toHaveAttribute('style', '')
  await expect(body.locator('b')).toHaveAttribute('style', 'color:#e4002b')
  const navy = await body.locator('div').first().getAttribute('style')
  expect(navy).toMatch(/^color: #[0-9a-f]{6}$/)
  expect(navy).not.toContain('#1F497D')
  const toggle = page.locator('[data-surface-toggle]').first()
  await expect(toggle).toHaveText('Show in light')
  await toggle.click()
  await expect(body).toHaveAttribute('data-paper', 'true')
  await expect(body.locator('div').first()).toHaveAttribute('style', 'color:#1F497D')
  await expect(toggle).toHaveText('Show in dark')
  await page.getByText('Services agreement').first().click()
  const layout = page.locator('.dispatch-thread-body').first()
  await expect(layout).toContainText('Big sale.')
  await expect(layout).toHaveAttribute('data-surface', 'paper')
  await expect(layout).toHaveAttribute('data-paper', 'true')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(layout).toHaveAttribute('data-paper', 'false')
})
