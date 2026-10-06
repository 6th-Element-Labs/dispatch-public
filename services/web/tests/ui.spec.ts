import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RecoveryDraft } from '../src/draft-recovery.js'

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

async function stubPrinting(page: Page) {
  await page.addInitScript(() => {
    const state = { calls: 0, fail: false, listeners: {} as Record<string, () => void> }
    Object.assign(window, {
      isTauri: true, __printing: state,
      __TAURI__: {
        core: { invoke: async (command: string) => {
          if (command === 'print_email') {
            if (state.fail) throw new Error('Could not open the print dialog')
            state.calls++
          }
          return {}
        } },
        event: { listen: async (name: string, handler: () => void) => { state.listeners[name] = handler; return () => {} } },
      },
    })
    window.print = () => { throw new Error('Native printing must use the shell') }
  })
}
type PrintBridge = { __printing: { calls: number; fail: boolean; listeners: Record<string, () => void> } }

test('native print menu and both shortcuts snapshot only the selected newest email', async ({ page }) => {
  await stubPrinting(page)
  await page.goto('/')
  await expect(page.locator('[data-message-id="m1"]')).toBeVisible()
  const count = () => page.evaluate(() => (window as unknown as PrintBridge).__printing.calls)
  await page.evaluate(() => (window as unknown as PrintBridge).__printing.listeners['dispatch://print-email']!())
  await expect.poll(count).toBe(1)
  const print = page.locator('#dispatch-email-print')
  await expect(print).toHaveAttribute('data-message-id', 'm1')
  await expect(print).toContainText('Ana Morales <ana@example.com>')
  await expect(print).toContainText('September 4, 2026 at 9:42 AM')
  await expect(print).toContainText('Hello Steve.')
  await expect(print).not.toContainText('Earlier message')
  await expect(print.locator('script')).toHaveCount(0)
  // Native invoke returns before the print sheet closes: the snapshot must survive.
  await expect(print).toHaveCount(1)
  await page.getByRole('button', { name: 'James Liu, Services agreement, unread', exact: true }).click()
  await expect(page.locator('[data-message-id="m2"]')).toBeVisible()
  await expect(print).toHaveAttribute('data-message-id', 'm1')
  await page.keyboard.press('Control+p')
  await expect.poll(count).toBe(2)
  await expect(print).toHaveAttribute('data-message-id', 'm2')
  await page.keyboard.press('Meta+p')
  await expect.poll(count).toBe(3)
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('#app')).toBeHidden()
  await expect(print).toBeVisible()
})

test('print button chooses the older email and includes only expanded quoted history', async ({ page }) => {
  await stubPrinting(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Expand message from Ana Morales', exact: true }).click()
  const older = page.locator('[data-message-id="m0"]')
  await older.locator('summary').click()
  await older.getByRole('button', { name: 'Print this email', exact: true }).click()
  await expect(page.locator('#dispatch-email-print')).toHaveAttribute('data-message-id', 'm0')
  await expect(page.locator('#dispatch-email-print')).toContainText('September 3, 2026 at 7:30 AM')
  await expect(page.locator('#dispatch-email-print')).toContainText('Earlier message')
  await expect(older.locator('details')).toHaveAttribute('open', '')
  await expect(page.locator('#dispatch-email-print summary')).toHaveCount(0)
})

test('print dialog failure is visible and no print occurs while another email is loading', async ({ page }) => {
  await stubPrinting(page)
  let releaseRead!: () => void
  const blockedRead = new Promise<void>(resolve => { releaseRead = resolve })
  // Install before navigation: Dispatch prefetches adjacent messages.
  await page.route(/8411\/v1\/conversations\/.*t2/, async route => { await blockedRead; await route.abort() })
  await page.goto('/')
  await expect(page.locator('[data-message-id="m1"]')).toBeVisible()
  await page.evaluate(() => { (window as unknown as PrintBridge).__printing.fail = true })
  await page.keyboard.press('Control+p')
  await expect(page.locator('[data-mail-error]')).toContainText('Could not open the print dialog')
  await page.getByRole('button', { name: 'James Liu, Services agreement, unread', exact: true }).click()
  await expect(page.getByText('Loading conversation…', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+p')
  await expect(page.locator('[data-mail-error]')).toContainText('Select an email and wait for it to load')
  await expect.poll(() => page.evaluate(() => (window as unknown as PrintBridge).__printing.calls)).toBe(0)
  releaseRead()
})

test('print layout keeps long formatted emails and escaped headers without client controls', async ({ page }) => {
  await stubPrinting(page)
  await page.route(/8411\/v1\/conversations\/.*t1/, route => route.fulfill({ json: { conversation: {
    ...conversations[0], source: 'demo', messages: [{ ...messages[0], source: 'demo', subject: '<img src=x onerror=alert(1)>',
      to: [{ name: 'Steve', address: 'steve@example.com', initials: 'SR' }], cc: [{ name: 'Copy', address: 'copy@example.com', initials: 'C' }],
      body: { kind: 'sanitized-html', content: `<style>@media print {body{display:none}}</style><p><strong>Formatted mail</strong></p>${'<p>Long email paragraph.</p>'.repeat(150)}` },
      attachments: [{ id: 'a1', name: 'Proposal & figures.pdf', mediaType: 'application/pdf', sizeLabel: '25 KB' }],
    }],
  } } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Print this email', exact: true }).click()
  await expect(page.locator('#dispatch-email-print h1')).toHaveText('<img src=x onerror=alert(1)>')
  await expect(page.locator('#dispatch-email-print h1 img')).toHaveCount(0)
  await expect(page.locator('#dispatch-email-print style')).toHaveCount(0)
  await expect(page.locator('#dispatch-email-print strong').first()).toHaveText('Formatted mail')
  await expect(page.locator('#dispatch-email-print')).toContainText('Proposal & figures.pdf (25 KB)')
  await expect(page.locator('#dispatch-email-print')).toContainText('Copy <copy@example.com>')
  await expect(page.locator('#dispatch-email-print button')).toHaveCount(0)
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('#app')).toBeHidden()
  const metrics = await page.locator('#dispatch-email-print').evaluate(node => ({ height: node.getBoundingClientRect().height, left: node.getBoundingClientRect().left, width: node.getBoundingClientRect().width, viewport: window.innerWidth, overflow: getComputedStyle(node).overflow }))
  expect(metrics.height).toBeGreaterThan(900)
  expect(metrics.left).toBe(0)
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport)
  expect(metrics.overflow).toBe('visible')
})

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

test.beforeEach(async ({ page }) => { await routeMailFixtures(page) })

async function routeMailFixtures(page: Page) {
  // Unrouted calls fail as they do in CI, so a run never reaches the mail or agent service installed on this Mac.
  await page.route(/^http:\/\/127\.0\.0\.1:(8411|8412|8413)\//, route => route.abort('connectionrefused'))
  await page.addInitScript(() => { localStorage.setItem('dispatch.setup.seen', '1') })
  await page.route(/8411\/v1\/mailboxes\/counts/, (route) => route.fulfill({ json: { source: 'demo', counts: { inbox: 0, drafts: 0, spam: 0 } } }))
  await page.route('http://127.0.0.1:8412/v1/activity', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: []\n\n' }))
  let executionMode = 'full-access'
  await page.route('http://127.0.0.1:8412/v1/execution-preferences', async route => {
    if (route.request().method() === 'PUT') executionMode = (await route.request().postDataJSON()).mode
    await route.fulfill({ json: { preferences: { version: 1, mode: executionMode } } })
  })
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
  await page.route('http://127.0.0.1:8411/v1/drafts', (route) => route.fulfill({ status: 201, json: { draft: {
    id: 'd1', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Re: Opua berth confirmation',
    bodyMarkdown: 'Thanks.', bodyHtml: '<p>Thanks.</p>', bodyText: 'Thanks.', attachments: [], state: 'draft',
  } } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    const bodyMarkdown = String(fields.bodyMarkdown ?? '')
    await route.fulfill({ status: 202, json: { draft: draftProjectionFromCommand(fields, String(fields.draftId ?? 'd1'), bodyMarkdown || (fields.messageId ? 'Thanks.' : '')) } })
  })
  await page.route('http://127.0.0.1:8411/v1/draft-sends', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sends: [] } })
    const fields = route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { receipt: { id: 'send-default', accountId: fields.accountId, draftId: fields.draftId ?? 'd1', status: 'accepted', messageId: 'sent-default' } } })
  })
  await page.route('http://127.0.0.1:8411/v1/drafts/preview', async (route) => {
    const request = await route.request().postDataJSON() as { bodyMarkdown: string }
    await route.fulfill({ json: { bodyHtml: `<p>${request.bodyMarkdown}</p>` } })
  })
  await page.route('http://127.0.0.1:8412/ready', (route) => route.fulfill({ status: 503, json: { status: 'not_ready' } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/recipients/, (route) => route.fulfill({ json: { recipients: [] } }))
}

function draftProjectionFromCommand(fields: Record<string, unknown>, id: string, body = String(fields.bodyMarkdown ?? '')) {
  const recipients = typeof fields.to === 'string'
    ? fields.to.split(',').map(value => value.trim()).filter(Boolean).map(address => ({ name: address, address, initials: address.slice(0, 1).toUpperCase() }))
    : Array.isArray(fields.to) ? fields.to : []
  return {
    id,
    accountId: String(fields.accountId ?? 'demo'),
    inReplyToMessageId: String(fields.messageId ?? ''),
    to: recipients,
    cc: String(fields.cc ?? ''),
    bcc: String(fields.bcc ?? ''),
    subject: String(fields.subject ?? ''),
    bodyMarkdown: body,
    bodyHtml: '',
    bodyText: body,
    attachments: Array.isArray(fields.attachments) ? fields.attachments : [],
    state: 'draft',
  }
}

async function localRecovery(page: Page): Promise<RecoveryDraft[]> {
  return page.evaluate(async () => {
    const modulePath = '/src/draft-recovery.ts'
    const { DraftRecovery } = await import(modulePath)
    return new DraftRecovery().list() as RecoveryDraft[]
  })
}

async function checkpointInWindow(page: Page, key: string, revision: number, bodyMarkdown: string) {
  await page.evaluate(async ({ key, revision, bodyMarkdown }) => {
    const modulePath = '/src/draft-recovery.ts'
    const { DraftRecovery } = await import(modulePath)
    new DraftRecovery().save({
      key, updatedAt: new Date().toISOString(), revision, gmailDraftId: '', inReplyToMessageId: '',
      to: '', cc: '', bcc: '', subject: key, bodyMarkdown,
    }, [])
  }, { key, revision, bodyMarkdown })
}

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
  await expect(page.locator('.dispatch-agent > header').getByRole('button', { name: 'Codex settings' })).toBeVisible()
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
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText('Thanks.')
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
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    draftRequest = await route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { draft: {
      id: 'compose-1', inReplyToMessageId: '', to: [{ name: 'Client', address: 'client@example.com', initials: '@' }], cc: 'cc@example.com', bcc: 'audit@example.com',
      subject: 'Project update', bodyMarkdown: 'Draft preview', bodyHtml: '<p>Draft preview</p>', bodyText: 'Draft preview', attachments: [], state: 'draft', accountId: 'link-one',
    } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await expect(page.getByRole('heading', { name: 'New message' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Draft account' })).toHaveValue('link-one')
  await page.getByRole('textbox', { name: 'Draft recipient' }).fill('client@example.com')
  await page.getByRole('button', { name: 'Add Cc', exact: true }).click()
  await page.getByRole('textbox', { name: 'Draft Cc' }).fill('cc@example.com')
  await page.getByRole('button', { name: 'Add Bcc', exact: true }).click()
  await page.getByRole('textbox', { name: 'Draft Bcc' }).fill('audit@example.com')
  await page.getByRole('textbox', { name: 'Draft subject' }).fill('Project update')
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Draft preview')
  await expect.poll(() => draftRequest).toEqual({ messageId: '', clientDraftId: expect.any(String), accountId: 'link-one', to: 'client@example.com', cc: 'cc@example.com', bcc: 'audit@example.com', subject: 'Project update', bodyMarkdown: 'Draft preview', attachments: [] })
})

test('sanitizes provider HTML in initial, refreshed, and saved draft previews', async ({ page }) => {
  const summary = { ...conversations[0]!, id: 'link-one:t1', accountId: 'link-one', accountLabel: 'work@example.com' }
  const unsafeHtml = '<p>Draft preview</p><img src="x" onerror="window.__draftPreviewPwned=true"><a href="javascript:window.__draftPreviewPwned=true">unsafe link</a>'
  const draft = { id: 'provider-draft', accountId: 'link-one', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Re: Opua berth confirmation', bodyMarkdown: 'Provider body', bodyText: 'Provider body', bodyHtml: unsafeHtml, attachments: [], state: 'draft' }
  await stubGmailInbox(page, summary)
  await page.route('http://127.0.0.1:8411/v1/drafts/open', route => route.fulfill({ json: { draft } }))
  let previewRequests = 0
  await page.route('http://127.0.0.1:8411/v1/drafts/preview', route => {
    previewRequests += 1
    return route.fulfill({ json: { bodyHtml: unsafeHtml } })
  })
  let saves = 0
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    saves += 1
    return route.fulfill({ status: 202, json: { draft: { ...draftProjectionFromCommand(fields, 'provider-draft'), bodyHtml: unsafeHtml, draftRevision: 2 } } })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await page.locator('[data-conversation-id="link-one:t1"]').click()
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText('Provider body')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.locator('[data-draft-preview]')
  const expectSanitized = async () => {
    const result = await preview.evaluate(node => ({
      onerror: node.querySelector('img')?.getAttribute('onerror') ?? null,
      href: node.querySelector('a')?.getAttribute('href') ?? null,
      executed: (window as unknown as { __draftPreviewPwned?: boolean }).__draftPreviewPwned ?? false,
    }))
    expect(result).toEqual({ onerror: null, href: null, executed: false })
  }
  await expect(preview).toContainText('Draft preview')
  await expectSanitized()

  await page.getByRole('textbox', { name: 'Draft body' }).fill('Edited provider body')
  await expect.poll(() => previewRequests).toBe(1)
  await expectSanitized()
  await expect.poll(() => saves, { timeout: 5000 }).toBe(1)
  await expectSanitized()
})

test('autosaves each saved-draft header and keeps the account locked', async ({ page }) => {
  const updates: Record<string, unknown>[] = []
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    if (fields.draftId) updates.push(fields)
    await route.fulfill({ status: 202, json: { draft: {
      id: 'autosave-1', inReplyToMessageId: '', to: [], cc: fields.cc ?? '', bcc: fields.bcc ?? '', subject: String(fields.subject ?? ''),
      bodyMarkdown: String(fields.bodyMarkdown ?? ''), bodyHtml: '<p></p>', bodyText: String(fields.bodyMarkdown ?? ''), attachments: [], state: 'draft', accountId: 'link-one',
    } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Initial saved text')
  await expect(page.getByRole('combobox', { name: 'Draft account' })).toBeDisabled()

  const changes: Array<[string, string, string]> = [
    ['Draft recipient', 'client@example.com', 'to'],
    ['Draft Cc', 'copy@example.com', 'cc'],
    ['Draft Bcc', 'audit@example.com', 'bcc'],
    ['Draft subject', 'Updated subject', 'subject'],
  ]
  for (const [name, value, field] of changes) {
    const count = updates.length
    if (name === 'Draft Cc' || name === 'Draft Bcc') await page.getByRole('button', { name: name.replace('Draft', 'Add'), exact: true }).click()
    await page.getByRole('textbox', { name }).fill(value)
    await expect.poll(() => updates.length).toBe(count + 1)
    expect(updates.at(-1)?.[field]).toBe(value)
  }
})

test('saves a new draft before asking Codex to revise its real Gmail draft ID', async ({ page }) => {
  let turnRequest: Record<string, unknown> | undefined
  const operationOrder: string[] = []
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    operationOrder.push(fields.draftId ? 'update' : 'create')
    await route.fulfill({ status: 202, json: { draft: {
      id: 'gmail-draft-42', inReplyToMessageId: '', to: [], cc: String(fields.cc ?? ''), bcc: String(fields.bcc ?? ''), subject: String(fields.subject ?? 'Plan'),
      bodyMarkdown: String(fields.bodyMarkdown ?? ''), bodyHtml: '<p>Revised locally</p>', bodyText: String(fields.bodyMarkdown ?? ''),
      attachments: Array.isArray(fields.attachments) ? fields.attachments : [], state: 'draft', accountId: 'link-one',
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
  await expect(toggle).toHaveAttribute('data-exhausted', 'true')
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
  await expect(toggle).toHaveAttribute('data-exhausted', 'false')
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
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
  await page.unroute('http://127.0.0.1:8412/ready')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', (route) => route.fulfill({ status: 202, json: { draft: {
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
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=(all|read|unread)/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all.*/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', to: [{ name: 'Work', address: 'work@example.com', initials: 'W' }, { name: 'Colleague', address: 'colleague@example.com', initials: 'C' }], cc: [{ name: 'Manager', address: 'manager@example.com', initials: 'M' }], body: { kind: 'plain-text', content: 'Body' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    draftRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { draft: { id: 'reply-all-1', inReplyToMessageId: 'm1', to: [], cc: String(draftRequest.cc ?? ''), bcc: '', subject: 'Re: Opua berth confirmation', bodyMarkdown: '', bodyHtml: '', bodyText: '', attachments: [], state: 'draft', accountId: 'link-one' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Reply all' }).click()
  await expect.poll(() => draftRequest).toMatchObject({ messageId: 'm1', accountId: 'link-one', to: 'ana@example.com, colleague@example.com', cc: 'manager@example.com', bcc: '' })
})

test('uses the newest message for a reply-all draft', async ({ page }) => {
  let draftRequest: Record<string, unknown> | undefined
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
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
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    draftRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { draft: { id: 'newest-reply-all', inReplyToMessageId: newest.id, to: [newest.sender], cc: '', bcc: '', subject: 'Re: Opua berth confirmation', bodyMarkdown: '', bodyHtml: '', bodyText: '', attachments: [], state: 'draft', accountId: 'link-one' } } })
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
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText('Saved words')
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
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    const projection = draftProjectionFromCommand(fields, String(fields.draftId ?? 'draft-1'))
    await route.fulfill({ status: 202, json: { draft: { ...projection, inReplyToMessageId: 'm1', to: [messages[0]!.sender] } } })
  })
  await page.route('http://127.0.0.1:8411/v1/draft-sends', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sends: [] } })
    expect(route.request().postDataJSON()).toMatchObject({ to: 'ana@example.com', cc: 'manager@example.com', bcc: 'audit@example.com', bodyMarkdown: String.raw`\*\*Approved reply\*\*` })
    sendCount += 1
    await route.fulfill({ json: { receipt: { id: 'receipt-1', draftId: 'draft-1', accountId: 'link-one', accountLabel: 'work@example.com', messageId: 'sent-1', status: 'accepted', requestedAt: '2026-09-08T01:00:00Z', detailsSource: 'draft', details: { to: ['ana@example.com'], cc: ['manager@example.com'], bcc: ['audit@example.com'], subject: 'Re: Opua berth confirmation', attachments: [] } } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await page.route(/http:\/\/127\.0\.0\.1:8412\/v1\/threads\/[^/]+\/turns/, () => {
    throw new Error('Send must not call the agent service')
  })
  await page.getByRole('textbox', { name: 'Draft body' }).fill('**Approved reply**')
  await page.getByRole('button', { name: 'Add Cc', exact: true }).click()
  await page.getByRole('textbox', { name: 'Draft Cc' }).fill('manager@example.com')
  await page.getByRole('button', { name: 'Add Bcc', exact: true }).click()
  await page.getByRole('textbox', { name: 'Draft Bcc' }).fill('audit@example.com')
  await page.locator('[data-send-draft]').click()
  await expect(page.locator('[data-send-confirm]')).toHaveCount(0)
  await expect(page.locator('[data-draft]')).toBeHidden()
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

test('hiding Email lets Codex fill the right side and restores saved widths', async ({ page }) => {
  await page.goto('/')
  const agent = page.locator('.dispatch-agent')
  const savedWidth = (await agent.boundingBox())!.width
  await page.getByRole('button', { name: 'Email', exact: true }).click()
  const fillsWorkspace = async () => {
    const workspace = (await page.locator('.dispatch-workspace').boundingBox())!
    const box = (await agent.boundingBox())!
    expect(box.x + box.width).toBeCloseTo(workspace.x + workspace.width, 0)
    expect(box.width).toBeGreaterThan(savedWidth)
  }
  await fillsWorkspace()
  await expect(page.locator('[data-divider="messages"]')).toBeVisible()
  await expect(page.locator('[data-divider="agent"]')).toBeHidden()
  await page.reload()
  await fillsWorkspace()
  await page.setViewportSize({ width: 1000, height: 800 })
  await fillsWorkspace()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Messages', exact: true }).click()
  await fillsWorkspace()
  await page.getByRole('button', { name: 'Messages', exact: true }).click()
  await page.getByRole('button', { name: 'Email', exact: true }).click()
  expect((await agent.boundingBox())!.width).toBeCloseTo(savedWidth, 0)
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
    await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText('Keep my draft edits')
  } else {
    await expect(page.getByText('Received thanks from Jacob!', { exact: true })).toBeVisible({ timeout: 8000 })
    await expect.poll(() => page.locator('[data-body]').evaluate(element => element.scrollTop)).toBe(0)
    await expect(page.getByRole('textbox', { name: 'Ask Codex' })).toHaveValue('Keep this unsent prompt')
  }
})

test('keeps Cc and Bcc folded until a draft uses them', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('dispatch.editor-recovery.v1', JSON.stringify([{ key: 'with-cc', updatedAt: '2026-09-23T19:47:07Z', revision: 1, accountId: 'one', accountLabel: 'work@example.com', to: 'andy@example.com', cc: 'copy@example.com', bcc: '', subject: 'Copied', bodyMarkdown: 'Hi', attachments: [] }]))
  })
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/drafts/, route => route.fulfill({ status: 502, json: { error: 'gmail_backoff', detail: 'Gmail is rate limiting this account. Retry after 2099-01-01T00:00:00.000Z' } }))
  await page.goto('/')
  // A draft that already copies someone opens with that row showing.
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await page.locator('[data-local-draft-key="with-cc"]').click()
  await expect(page.locator('[data-copy-row="cc"] [data-recipient-address="copy@example.com"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add Cc', exact: true })).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Draft Bcc' })).toBeHidden()
  await page.getByRole('button', { name: 'Add Bcc', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Draft Bcc' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Add Bcc', exact: true })).toBeHidden()
  // A new message starts folded again.
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Draft recipient' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Draft Cc' })).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Draft Bcc' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Add Cc', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add Bcc', exact: true })).toBeVisible()
})

test('collapses an unsent draft without losing edits and gives space back to the email', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Draft body' })
  await body.fill('Keep these unsent words')
  const before = await page.locator('[data-body]').boundingBox()
  await page.getByRole('button', { name: 'Collapse draft', exact: true }).click()
  await expect(page.getByText('Unsent draft', { exact: true })).toBeVisible()
  // Save state lives in the header, so it stays in view while the draft is collapsed.
  await expect(page.locator('[data-draft] .card-header [data-recovery-status]')).toBeAttached()
  await expect(body).toBeHidden()
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeHidden()
  await expect(page.locator('[data-send-draft]')).toBeHidden()
  expect((await page.locator('[data-body]').boundingBox())!.height).toBeGreaterThan(before!.height)
  const expand = page.getByRole('button', { name: 'Expand draft', exact: true })
  await expand.focus(); await page.keyboard.press('Enter')
  await expect(body).toHaveText('Keep these unsent words')
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeVisible()
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
    await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText('Do not replace this draft')
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

test('names the account Gmail is rate limiting instead of calling all mail stale', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.unroute('http://127.0.0.1:8411/v1/sync/status')
  await page.route('http://127.0.0.1:8411/v1/sync/status', route => route.fulfill({ json: { sync: { state: 'failed', startedAt: '2026-09-24T10:42:00.425Z', completedAt: '2026-09-24T05:48:12.687Z', error: 'Error: steve@6elementlabs.com: Error: Gmail is rate limiting this account. Retry after 2026-09-24T11:05:01.424Z', messageCount: 2 } } }))
  await page.goto('/')
  await expect(page.locator('[data-mail-source]')).toHaveText('Waiting for Gmail · steve@6elementlabs.com')
  await expect(page.locator('[data-mail-error]')).toBeHidden()
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
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText('See you in Opua.')
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
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  const attachment = { id: 'a1', name: 'arrival.pdf', mediaType: 'application/pdf', sizeLabel: '824 KB' }
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\?state=all/, (route) => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/t1\?account=link-one/, (route) => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Body' }, attachments: [attachment] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    draftRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { draft: { ...draftProjectionFromCommand(draftRequest, String(draftRequest.draftId ?? 'fwd-1')), attachments: draftRequest.attachments, subject: 'Fwd: Opua berth confirmation' } } })
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
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    saved = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { draft: { id: 'attach-1', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: '', bodyMarkdown: '', bodyHtml: '<p></p>', bodyText: '', attachments: saved.attachments, state: 'draft', accountId: 'link-one' } } })
  })
  await page.route('http://127.0.0.1:8411/v1/drafts/attachments/open', async (route) => {
    opened = route.request().postDataJSON()
    await route.fulfill({ json: { opened: true, filename: 'notes.txt' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.locator('[data-draft-files]').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
  ])
  await expect.poll(() => saved?.attachments).toEqual([
    expect.objectContaining({ name: 'notes.txt', mediaType: 'text/plain', contentBase64: 'aGVsbG8=' }),
    expect.objectContaining({ name: 'empty.txt', mediaType: 'text/plain', contentBase64: '' }),
  ])
  await expect(page.getByLabel('Draft attachments')).toContainText('notes.txt')
  await expect(page.getByLabel('Draft attachments')).toContainText('empty.txt')
  await page.getByRole('button', { name: 'Open notes.txt' }).click()
  await expect.poll(() => opened).toEqual({ filename: 'notes.txt', contentBase64: 'aGVsbG8=', accountId: 'link-one' })
  await page.getByRole('button', { name: 'Open empty.txt' }).click()
  await expect.poll(() => opened).toEqual({ filename: 'empty.txt', contentBase64: '', accountId: 'link-one' })
})

test('adds a recipient chip from mail autocomplete', async ({ page }) => {
  let draftRequest: Record<string, unknown> | undefined
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
  await page.unroute(/http:\/\/127\.0\.0\.1:8411\/v1\/recipients/)
  await page.route('http://127.0.0.1:8411/v1/accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'link-one', connectorId: 'gmail-app', name: 'Work', email: 'work@example.com' }] } }))
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/recipients/, (route) => route.fulfill({ json: { recipients: [{ name: 'Ana Morales', address: 'ana@example.com', initials: 'AM' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    draftRequest = await route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { draft: { ...draftProjectionFromCommand(draftRequest, String(draftRequest.draftId ?? 'chip-1')), to: [{ name: 'Ana Morales', address: 'ana@example.com', initials: 'AM' }] } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByRole('textbox', { name: 'Draft recipient' }).fill('ana')
  await page.getByRole('option', { name: 'Ana Morales <ana@example.com>' }).click()
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
  let statusUrl = ''
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/messages\/m1\/attachments\/att-9\/status\?/, async (route) => {
    statusUrl = route.request().url()
    await route.fulfill({ json: { cached: false } })
  })
  const warmed: string[] = []
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/messages\/m1\/attachments\/att-9\/cache/, async (route) => {
    warmed.push(route.request().url())
    await route.fulfill({ json: { cached: true, reused: false, filename: 'arrival.pdf', mediaType: 'application/pdf' } })
  })
  await page.goto('/')
  await expect.poll(() => statusUrl).toBe('http://127.0.0.1:8411/v1/messages/m1/attachments/att-9/status?filename=arrival.pdf&account=link-one')
  expect(warmed).toEqual([])
  await page.getByRole('button', { name: '1 attachment' }).click()
  const files = page.locator('[data-thread-files]')
  await files.getByRole('button', { name: 'Download attachments' }).click()
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

test('marks a capped thread as partial and refreshes it without hiding the loaded messages', async ({ page }) => {
  const summary = { ...conversations[0]!, id: 'gmail:one:t1', accountId: 'one', accountLabel: 'work@example.com' }
  const message = { ...messages[0]!, id: 'm1', accountId: 'one', source: 'gmail' as const, body: { kind: 'plain-text' as const, content: 'Loaded first message' }, attachments: [] }
  const partial = { ...summary, source: 'gmail' as const, completeness: { complete: false, knownCount: 12, loadedCount: 1, reason: 'provider limit' }, messages: [message] }
  let reads = 0
  let pendingRefresh: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/8411\/v1\/conversations\/t1\?account=one(?:&.*)?$/, async route => {
    reads += 1
    if (reads === 1) return route.fulfill({ json: { conversation: partial } })
    pendingRefresh = route
  })
  await page.goto('/')
  await expect(page.locator('[data-account] option[value="one"]')).toHaveCount(1)
  await expect(page.locator('[data-conversation-id="gmail:one:t1"]')).toBeVisible()
  await expect.poll(() => reads).toBe(1)
  await expect(page.locator('[data-thread-completeness]')).toContainText('Showing 1 of at least 12 messages')
  await page.getByRole('button', { name: 'Refresh thread' }).click()
  await expect.poll(() => reads).toBe(2)
  await expect.poll(() => Boolean(pendingRefresh)).toBe(true)
  await expect(page.locator('[data-body]')).toContainText('Loaded first message')
  await pendingRefresh!.fulfill({ json: { conversation: { ...partial, completeness: { complete: true, knownCount: 2, loadedCount: 2 }, messages: [message, {
    ...message, id: 'm-new', receivedAt: '2026-09-05T09:42:00+12:00', receivedLabel: 'Sep 5, 9:42 AM', receivedFullLabel: 'September 5, 2026 at 9:42 AM',
    preview: 'Loaded after refresh', body: { kind: 'plain-text', content: 'Loaded after refresh' },
  }] } } })
  await expect(page.locator('[data-thread-completeness]')).toBeHidden()
  await expect(page.locator('[data-body]')).toContainText('Loaded after refresh')
})

test('keeps an unsaved reply visible when refreshing a partial thread fails', async ({ page }) => {
  const summary = { ...conversations[0]!, id: 'gmail:one:t1', accountId: 'one', accountLabel: 'work@example.com' }
  const message = { ...messages[0]!, id: 'm1', accountId: 'one', source: 'gmail' as const, body: { kind: 'plain-text' as const, content: 'Loaded first message' }, attachments: [] }
  const partial = { ...summary, source: 'gmail' as const, completeness: { complete: false, knownCount: 12, loadedCount: 1 }, messages: [message] }
  let reads = 0
  let pendingRefresh: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route(/8411\/v1\/conversations\/t1\?account=one(?:&.*)?$/, async route => {
    reads += 1
    if (reads === 1) return route.fulfill({ json: { conversation: partial } })
    pendingRefresh = route
  })
  await page.route('http://127.0.0.1:8411/v1/drafts/open', route => route.fulfill({ json: { draft: {
    id: 'reply-draft', accountId: 'one', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Re: Thread', bodyMarkdown: '', bodyText: '', bodyHtml: '', attachments: [], state: 'draft',
  } } }))
  await page.goto('/')
  await expect(page.locator('[data-account] option[value="one"]')).toHaveCount(1)
  await expect(page.locator('[data-conversation-id="gmail:one:t1"]')).toBeVisible()
  await expect.poll(() => reads).toBe(1)
  await expect(page.locator('[data-thread-completeness]')).toBeVisible()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(page.locator('[data-draft]')).toBeVisible()
  await page.locator('[data-draft-body]').fill('Unsaved reply remains visible')
  await page.getByRole('button', { name: 'Refresh thread' }).click()
  await expect.poll(() => Boolean(pendingRefresh)).toBe(true)
  await pendingRefresh!.fulfill({ status: 503, json: { error: 'temporary read failure' } })
  await expect(page.locator('[data-thread-completeness]')).toContainText('More messages could not be loaded')
  await expect(page.locator('[data-draft]')).toBeVisible()
  await expect(page.locator('[data-draft-body]')).toHaveText('Unsaved reply remains visible')
})

test('checks exact file identities and downloads thread attachments only on request', async ({ page }) => {
  const summary = { ...conversations[0]!, id: 'gmail:one:t1', accountId: 'one', accountLabel: 'work@example.com' }
  const message = { ...messages[0]!, id: 'm1', accountId: 'one', source: 'gmail' as const, body: { kind: 'plain-text' as const, content: 'Files attached' }, attachments: [
    { id: 'empty-file', name: 'empty.txt', mediaType: 'text/plain', sizeLabel: '0 B' },
    { id: 'report-file', name: 'report.pdf', mediaType: 'application/pdf', sizeLabel: '1 KB' },
  ] }
  const statusRequests: string[] = []
  const downloads: string[] = []
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [summary], nextCursor: null, total: 1 } }))
  await page.route('http://127.0.0.1:8411/v1/conversations/t1?account=one', route => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [message] } } }))
  await page.route(/8411\/v1\/messages\/m1\/attachments\/(empty-file|report-file)\/status\?/, async route => {
    statusRequests.push(route.request().url())
    const id = new URL(route.request().url()).pathname.split('/').at(-2)
    await route.fulfill({ json: { cached: id === 'empty-file' } })
  })
  await page.route(/8411\/v1\/messages\/m1\/attachments\/(empty-file|report-file)\/cache\?/, async route => {
    downloads.push(route.request().url())
    if (downloads.length === 1) return route.fulfill({ status: 503, json: { error: 'temporary cache failure' } })
    return route.fulfill({ json: { cached: true, reused: false } })
  })
  await page.goto('/')
  await expect.poll(() => statusRequests.length).toBe(2)
  await expect(downloads).toHaveLength(0)
  await page.getByRole('button', { name: '2 attachments' }).click()
  const files = page.locator('[data-thread-files]')
  await expect(files).toContainText('0 B')
  await expect(files).toContainText('Available offline')
  await expect(files).toContainText('Not downloaded')
  await files.getByRole('button', { name: 'Download attachments' }).click()
  await expect(files).toContainText('Download failed')
  await files.getByRole('button', { name: 'Retry download' }).click()
  await expect.poll(() => downloads.length).toBe(2)
  await expect(files).toContainText('All attachments available offline')
  expect(statusRequests.every(url => new URL(url).searchParams.get('account') === 'one')).toBe(true)
  expect(downloads.every(url => new URL(url).searchParams.get('account') === 'one')).toBe(true)
  expect(downloads.every(url => url.includes('/report-file/'))).toBe(true)
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
  let draftRequest: Record<string, unknown> | undefined
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com' }
  await stubGmailInbox(page, summary)
  await page.unroute('http://127.0.0.1:8411/v1/draft-saves')
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    draftRequest = fields
    await route.fulfill({ status: 202, json: { draft: { ...draftProjectionFromCommand(fields, String(fields.draftId ?? 'ctx-reply')), inReplyToMessageId: 'm1', to: [messages[0]!.sender] } } })
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

test('keeps a context-menu mark-unread row unread after a later click on that thread', async ({ page }) => {
  await page.clock.install()
  const commands: unknown[] = []
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: false }
  await stubGmailInbox(page, summary)
  await page.route('http://127.0.0.1:8411/v1/conversations/t1/read-state', async (route) => {
    const body = await route.request().postDataJSON()
    commands.push(body)
    await route.fulfill({ json: { accepted: true, result: { unread: body.unread } } })
  })
  await page.goto('/')
  await chooseThreadMenu(page, 'Mark as Unread')
  await expect.poll(() => commands.at(-1)).toEqual({ accountId: 'link-one', messageIds: ['m1'], unread: true })
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveClass(/dispatch-message-unread/)
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeVisible()
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.clock.fastForward(5000)
  expect(commands).toEqual([{ accountId: 'link-one', messageIds: ['m1'], unread: true }])
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveClass(/dispatch-message-unread/)
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeVisible()
})

test('stale cached unread labels cannot reverse the toolbar or row styling', async ({ page }) => {
  const summary = { ...conversations[0]!, accountId: 'link-one', accountLabel: 'work@example.com', unread: false }
  await stubGmailInbox(page, summary)
  await page.route(/8411\/v1\/conversations\/t1\?account=link-one/, route => route.fulfill({ json: { conversation: {
    ...summary, latestMessageId: 'sent-reply', unread: true, source: 'gmail', availability: { mode: 'downloaded', cachedAt: '2026-09-20T00:00:00Z' },
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
  await page.locator('[data-conversation-id="demo:t1"]').click()
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
    await page.route('http://127.0.0.1:8411/v1/draft-saves', async (route) => {
      saves += 1
      if (saveOutcome === 'pending') { pendingSave = route; return }
      if (saveOutcome === 'fails') return route.fulfill({ status: 502, json: { error: 'gmail_draft_update_failed', detail: 'connector refused' } })
      const fields = await route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ status: 202, json: { draft: { ...draft, bodyMarkdown: fields.bodyMarkdown, bodyText: fields.bodyMarkdown } } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Drafts', exact: true }).click()
    await page.locator('[data-conversation-id="link-one:t9"]').click()
    const body = page.getByRole('textbox', { name: 'Draft body' })
    await expect(body).toHaveText('Hi Ana')
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
    if (saveOutcome !== 'succeeds') expect((await localRecovery(page)).some(record => record.bodyMarkdown === 'Hi Ana, edited')).toBe(true)
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
  await expect(page.getByLabel('Draft body')).toHaveText('Stored content')
  await expect(page.locator('[data-send-draft]')).toBeEnabled()
  await expect.poll(() => Boolean(refreshing)).toBe(true)
  await page.getByLabel('Draft body').fill('My newer edit')
  await refreshing!.fulfill({ json: { draft: { ...draft, cachedAt: undefined, bodyMarkdown: 'Remote older version' } } })
  await expect(page.getByLabel('Draft body')).toHaveText('My newer edit')
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
  await expect(page.locator('[data-draft-body]')).toHaveText('Saved older text')
  await page.evaluate(()=>{(window as any).auditEvents.onmessage({data:JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}})})})
  await expect.poll(()=>Boolean(pending)).toBe(true)
  await page.locator('[data-draft-body]').fill('My newer unsaved edit')
  await pending.fulfill({json:{draft}})
  await expect(page.locator('[data-draft-body]')).toHaveText('My newer unsaved edit')
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
    if (intervening === 'none') await expect(page.locator('[data-draft-body]')).toHaveText('AI saved text')
    if (intervening === 'edit') await expect(page.locator('[data-draft-body]')).toHaveText('My local draft')
    if (intervening === 'switch') await expect(page.locator('[data-draft]')).toBeHidden()
  })
}

for (const hasRecipient of [true, false]) {
  test(`Send ${hasRecipient ? 'uses an unchanged Gmail draft without rewriting it' : 'blocks an empty recipient list before any write'}`, async ({ page }) => {
    const writes: string[] = []
    const draft = { id: 'send-existing', accountId: 'account-A', inReplyToMessageId: 'm1', to: hasRecipient ? [messages[0]!.sender] : [], cc: '', bcc: '', subject: 'Existing draft', bodyMarkdown: 'Read-only projection', bodyHtml: '<p>Original HTML</p>', bodyText: 'Read-only projection', attachments: [], state: 'draft' }
    await page.route('http://127.0.0.1:8411/v1/drafts', route => route.fulfill({ json: { draft } }))
    await page.route('http://127.0.0.1:8411/v1/draft-sends', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { sends: [] } })
      writes.push(route.request().method() + ':send')
      expect(route.request().postDataJSON()).not.toHaveProperty('bodyMarkdown')
      return route.fulfill({ json: route.request().method() === 'PUT' ? { draft } : { delivery: { id: 'sent-message' } } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(page.locator('[data-draft-body]')).toHaveText('Read-only projection')
    await page.locator('[data-send-draft]').click()
    if (hasRecipient) {
      await expect.poll(() => writes).toEqual(['POST:send'])
    } else {
      await expect(page.locator('[data-draft-error]')).toContainText('Add a recipient')
      await expect(page.locator('[data-send-confirm]')).toHaveCount(0)
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

test('shows a local-only draft as a draft, not as an unread thread with another thread\'s actions', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('dispatch.editor-recovery.v1', JSON.stringify([{ key: 'local-only', updatedAt: '2026-09-23T19:47:07Z', revision: 3, accountId: 'one', accountLabel: 'work@example.com', gmailDraftId: 'gone-draft', gmailThreadId: 'gone-thread', inReplyToMessageId: 'gone-thread', to: 'andy@example.com', cc: '', bcc: '', subject: 'Forwarded notes', bodyMarkdown: 'Notes', attachments: [] }]))
  })
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  // Keep background saves of the local draft off any real mail service.
  await page.route(/8411\/v1\/drafts/, route => route.fulfill({ status: 502, json: { error: 'gmail_backoff', detail: 'Gmail is rate limiting this account. Retry after 2099-01-01T00:00:00.000Z' } }))
  await page.goto('/')
  await page.locator('[data-conversation-id]').first().click()
  await expect(page.locator('[data-reply]')).toBeVisible()
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  // Drawn like any draft row, never as unread mail.
  const row = page.locator('[data-local-draft-key="local-only"]')
  await expect(row).toContainText('To: andy@example.com')
  await expect(row).toContainText('Forwarded notes')
  await expect(row).toContainText('Not synced to Gmail')
  await expect(row).not.toHaveClass(/dispatch-message-unread/)
  await row.click()
  await expect(page.locator('[data-draft-body]')).toHaveText('Notes')
  await expect(page.locator('[data-thread-mailbox]')).toHaveText('Drafts')
  await expect(page.locator('[data-message-count]')).toBeHidden()
  await expect(page.locator('[data-account-dot]')).toBeHidden()
  // A draft with no thread above it has no thread to reply to, forward, or mark read.
  for (const control of ['[data-read-state]', '[data-reply]', '[data-reply-all]', '[data-forward]']) await expect(page.locator(control)).toBeHidden()
  await expect(page.locator('[data-draft] .card-header [data-recovery-status]')).toBeVisible()
  // The rendered preview is on request, not a second copy of the message.
  await expect(page.locator('[data-draft-preview]')).toBeHidden()
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.locator('[data-draft-preview]')).toBeVisible()
  await page.getByRole('button', { name: 'Inbox', exact: true }).click()
  await page.locator('[data-conversation-id]').first().click()
  await expect(page.locator('[data-reply]')).toBeVisible()
  await expect(page.locator('[data-forward]')).toBeVisible()
})

test('recovers unsaved recipients, text and file bytes after a reload without sending', async ({ page }) => {
  const writes: string[] = []
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route(/8411\/v1\/draft-saves$/, route => { writes.push(route.request().method()); return route.fulfill({ status: 503, json: { error: 'Gmail unavailable' } }) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.locator('[data-draft-to]').fill('ana@example.com')
  await page.getByRole('button', { name: 'Add Cc', exact: true }).click()
  await page.locator('[data-draft-cc]').fill('cc@example.com')
  await page.getByRole('button', { name: 'Add Bcc', exact: true }).click()
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
  await expect(page.locator('[data-draft-body]')).toHaveText('Text entered before Gmail can save it.')
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
  expect(await localRecovery(page)).toEqual([])
})

test('separate browser windows preserve independent checkpoints and a revision saved during cleanup', async ({ page }) => {
  const second = await page.context().newPage()
  try {
    await routeMailFixtures(second)
    await Promise.all([page.goto('/'), second.goto('/')])
    await Promise.all([
      checkpointInWindow(page, 'window-a', 1, 'A text'),
      checkpointInWindow(second, 'window-b', 1, 'B text'),
    ])
    expect(new Set((await localRecovery(page)).map(record => record.key))).toEqual(new Set(['window-a', 'window-b']))

    await checkpointInWindow(page, 'shared-draft', 1, 'Older text')
    await Promise.all([
      page.evaluate(async () => {
        const modulePath = '/src/draft-recovery.ts'
        const { DraftRecovery } = await import(modulePath)
        new DraftRecovery().removeSavedRevision('shared-draft', 1)
      }),
      checkpointInWindow(second, 'shared-draft', 2, 'Newer text'),
    ])
    expect((await localRecovery(page)).find(record => record.key === 'shared-draft')).toMatchObject({ revision: 2, bodyMarkdown: 'Newer text' })
  } finally { await second.close() }
})

test('resolves only the affected draft inline and keeps typing made while choosing a version', async ({ page }) => {
  const remote = { id: 'gmail-draft-conflict', accountId: 'one', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Remote subject', bodyMarkdown: 'Remote Gmail text', bodyText: 'Remote Gmail text', bodyHtml: '', attachments: [], state: 'draft' as const }
  const writes: Record<string, unknown>[] = []
  let resolution: import('@playwright/test').Route | undefined
  let nextSave: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    writes.push(await route.request().postDataJSON() as Record<string, unknown>)
    if (writes.length === 1) {
      await route.fulfill({ status: 202, json: { draft: {
        ...remote, id: 'queued-conflict', subject: 'Local subject', bodyMarkdown: 'Local version', bodyText: 'Local version',
        draftRevision: 7, syncState: 'failed', conflict: { fields: ['subject', 'bodyMarkdown'], remote },
      } } })
    } else { nextSave = route }
  })
  await page.route('http://127.0.0.1:8411/v1/draft-saves/queued-conflict/conflict', route => { resolution = route })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('textbox', { name: 'Draft subject' }).fill('Local subject')
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Local version')
  await expect(page.locator('[data-draft-conflict]')).toBeVisible()
  await expect(page.locator('[data-draft-conflict-summary]')).toContainText('subject, message')
  await expect(page.locator('[data-draft-conflict-remote]')).toContainText('Remote Gmail text')
  await expect(page.getByRole('button', { name: 'Use Gmail version' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep my edits' })).toBeVisible()

  await page.getByRole('button', { name: 'Use Gmail version' }).click()
  await expect.poll(() => Boolean(resolution)).toBe(true)
  const resolutionBody = await resolution!.request().postDataJSON() as Record<string, unknown>
  expect(resolutionBody).toEqual({ accountId: 'one', choice: 'use-remote', expectedRevision: 7 })
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Newer words typed while the choice was pending')
  await resolution!.fulfill({ json: { draft: { ...remote, resolvedFromDraftId: 'queued-conflict', draftRevision: 8 } } })
  await expect(page.locator('[data-draft-conflict]')).toBeHidden()
  await expect(page.locator('[data-draft-body]')).toHaveText('Newer words typed while the choice was pending')
  await expect.poll(() => Boolean(nextSave), { timeout: 20_000 }).toBe(true)
  expect(writes[1]).toMatchObject({
    accountId: 'one', draftId: 'gmail-draft-conflict', bodyMarkdown: 'Newer words typed while the choice was pending',
    base: { id: 'gmail-draft-conflict', bodyMarkdown: 'Remote Gmail text' },
  })
  const pendingRecovery = (await localRecovery(page)).find(item => item.bodyMarkdown === 'Newer words typed while the choice was pending')
  expect(pendingRecovery).toMatchObject({ bodyMarkdown: 'Newer words typed while the choice was pending', base: { bodyMarkdown: 'Remote Gmail text' } })
  await nextSave!.fulfill({ status: 503, json: { error: 'temporarily unavailable' } })
  await expect(page.locator('[data-draft-body]')).toHaveText('Newer words typed while the choice was pending')
})

test('keeps typing made during Keep my edits and accepts a follow-up save', async ({ page }) => {
  const remote = { id: 'gmail-draft-keep', accountId: 'one', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Remote', bodyMarkdown: 'Gmail version', bodyText: 'Gmail version', bodyHtml: '', attachments: [], state: 'draft' as const }
  let saves = 0
  let resolution: import('@playwright/test').Route | undefined
  let followUp: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    saves += 1
    const payload = await route.request().postDataJSON() as Record<string, unknown>
    if (saves === 1) return route.fulfill({ status: 202, json: { draft: { ...remote, id: 'queued-keep', bodyMarkdown: 'My edits', bodyText: 'My edits', draftRevision: 4, syncState: 'failed', conflict: { fields: ['bodyMarkdown'], remote } } } })
    if (saves === 2) { followUp = route; return }
    return route.fulfill({ status: 202, json: { draft: { ...remote, id: 'queued-keep', bodyMarkdown: payload.bodyMarkdown, bodyText: payload.bodyMarkdown, draftRevision: 6, syncState: 'pending' } } })
  })
  await page.route('http://127.0.0.1:8411/v1/draft-saves/queued-keep/conflict', route => { resolution = route })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('textbox', { name: 'Draft body' }).fill('My edits')
  await expect(page.locator('[data-draft-conflict]')).toBeVisible()
  await page.getByRole('button', { name: 'Keep my edits' }).click()
  await expect.poll(() => Boolean(resolution)).toBe(true)
  expect(await resolution!.request().postDataJSON()).toEqual({ accountId: 'one', choice: 'keep-local', expectedRevision: 4 })
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Typing during Keep my edits')
  await resolution!.fulfill({ json: { draft: { ...remote, id: 'queued-keep', bodyMarkdown: 'My edits', bodyText: 'My edits', draftRevision: 5, syncState: 'pending' } } })
  await expect.poll(() => Boolean(followUp), { timeout: 20_000 }).toBe(true)
  expect(await followUp!.request().postDataJSON()).toMatchObject({ draftId: 'queued-keep', bodyMarkdown: 'Typing during Keep my edits' })
  await followUp!.fulfill({ status: 202, json: { draft: { ...remote, id: 'queued-keep', bodyMarkdown: 'Typing during Keep my edits', bodyText: 'Typing during Keep my edits', draftRevision: 6, syncState: 'pending' } } })
  await expect(page.locator('[data-draft-body]')).toHaveText('Typing during Keep my edits')
})

test('keeps a saved Codex attachment during stale queued-editor saves and permits removal after refresh', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  const queued = { id: 'queued-append-race', accountId: 'one', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: '', bodyMarkdown: 'Before append', bodyText: 'Before append', bodyHtml: '', attachments: [], state: 'draft' as const, draftRevision: 1, syncState: 'pending' as const }
  const confirmed = { ...queued, syncState: undefined }
  const appended = { id: 'codex-file', name: 'added-by-codex.txt', mediaType: 'text/plain', sizeLabel: '4 B' }
  const commands: { body: Record<string, unknown>; route?: import('@playwright/test').Route }[] = []
  let remoteAppendReady = false
  let draftReads = 0
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    const body = await route.request().postDataJSON() as Record<string, unknown>
    commands.push({ body })
    const current = commands.length
    if (current === 1) return route.fulfill({ status: 202, json: { draft: queued } })
    if (current === 2) { commands[current - 1]!.route = route; return }
    if (current === 3) { commands[current - 1]!.route = route; return }
    return route.fulfill({ status: 202, json: { draft: { ...queued, draftRevision: current, bodyMarkdown: String(body.bodyMarkdown ?? ''), bodyText: String(body.bodyMarkdown ?? ''), attachments: Array.isArray(body.attachments) ? body.attachments : remoteAppendReady ? [appended] : [] } } })
  })
  await page.route('http://127.0.0.1:8411/v1/drafts/queued-append-race?account=one', async route => {
    draftReads += 1
    await route.fulfill({ json: { draft: remoteAppendReady
      ? { ...confirmed, bodyMarkdown: 'After append', bodyText: 'After append', attachments: [appended], draftRevision: 3 }
      : queued } })
  })
  await page.goto('/')
  await expect(page.locator('[data-account] option[value="one"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.locator('[data-draft]')).toBeVisible()
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Before append')
  await expect.poll(() => commands.length).toBe(1)
  expect(commands[0]?.body).toMatchObject({ bodyMarkdown: 'Before append', attachments: [] })

  // The Codex attachment append completes remotely while this editor still has the older file list.
  remoteAppendReady = true
  await page.getByRole('textbox', { name: 'Draft body' }).fill('After append')
  await expect.poll(() => Boolean(commands[1]?.route)).toBe(true)
  expect(commands[1]?.body).toMatchObject({
    draftId: 'queued-append-race', bodyMarkdown: 'After append',
    base: { id: 'queued-append-race', bodyMarkdown: 'Before append', attachments: [] },
  })
  expect(commands[1]?.body).not.toHaveProperty('attachments')
  await commands[1]!.route!.fulfill({ status: 202, json: { draft: { ...queued, bodyMarkdown: 'After append', bodyText: 'After append', draftRevision: 2 } } })

  const readsBeforeAppendRefresh = draftReads
  await expect.poll(() => draftReads, { timeout: 12_000 }).toBeGreaterThan(readsBeforeAppendRefresh)
  await expect(page.getByLabel('Draft attachments')).toContainText('added-by-codex.txt', { timeout: 12_000 })
  await page.getByRole('button', { name: 'Remove attachment added-by-codex.txt' }).click()
  await expect.poll(() => Boolean(commands[2]?.route)).toBe(true)
  expect(commands[2]?.body).toMatchObject({
    draftId: 'queued-append-race', attachments: [],
    base: { id: 'queued-append-race', attachments: [{ id: 'codex-file' }] },
  })
  await commands[2]!.route!.fulfill({ status: 202, json: { draft: { ...queued, bodyMarkdown: 'After append', bodyText: 'After append', attachments: [], draftRevision: 4 } } })
  await expect(page.getByLabel('Draft attachments')).toBeHidden()
})

test('removing a visible pending append uses only the observed attachment baseline', async ({ page }) => {
  await page.unroute('http://127.0.0.1:8411/v1/accounts')
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  const queued = { id: 'queued-pending-append', accountId: 'one', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: '', bodyMarkdown: 'Before append', bodyText: 'Before append', bodyHtml: '', attachments: [], state: 'draft' as const, draftRevision: 1, syncState: 'pending' as const }
  const commands: { body: Record<string, unknown>; route?: import('@playwright/test').Route }[] = []
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    const body = await route.request().postDataJSON() as Record<string, unknown>
    commands.push({ body })
    if (commands.length === 3) { commands[2]!.route = route; return }
    return route.fulfill({ status: 202, json: { draft: {
      ...queued,
      bodyMarkdown: String(body.bodyMarkdown ?? ''),
      bodyText: String(body.bodyMarkdown ?? ''),
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      draftRevision: commands.length,
    } } })
  })
  await page.goto('/')
  await expect(page.locator('[data-account] option[value="one"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.locator('[data-draft]')).toBeVisible()
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Before append')
  await expect.poll(() => commands.length).toBe(1)

  await page.locator('[data-draft-files]').setInputFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('file bytes') })
  await expect.poll(() => commands.length).toBe(2)
  await expect(page.getByLabel('Draft attachments')).toContainText('pending.txt')
  expect(commands[1]?.body).toMatchObject({ attachments: [expect.objectContaining({ name: 'pending.txt' })] })
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Text edited while append is pending')

  await page.getByRole('button', { name: 'Remove attachment pending.txt' }).click()
  await expect.poll(() => Boolean(commands[2]?.route)).toBe(true)
  expect(commands[2]?.body).toMatchObject({
    draftId: 'queued-pending-append',
    bodyMarkdown: 'Text edited while append is pending',
    attachments: [],
    base: {
      id: 'queued-pending-append',
      bodyMarkdown: 'Before append',
      attachments: [expect.objectContaining({ name: 'pending.txt', mediaType: 'text/plain' })],
    },
  })
  expect((commands[2]?.body.base as Record<string, unknown>).attachments).not.toContainEqual(expect.objectContaining({ contentBase64: expect.any(String) }))
  await commands[2]!.route!.fulfill({ status: 202, json: { draft: { ...queued, bodyMarkdown: 'Text edited while append is pending', bodyText: 'Text edited while append is pending', attachments: [], draftRevision: 3 } } })
  await expect(page.getByLabel('Draft attachments')).toBeHidden()
})

test('discards an unsent local draft while its Gmail save is still failing', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('dispatch.editor-recovery.v1', JSON.stringify([{ key: 'stuck-draft', updatedAt: '2026-09-23T19:47:07Z', revision: 66, accountId: 'one', accountLabel: 'work@example.com', gmailDraftId: 'gone-draft', gmailThreadId: 'gone-thread', inReplyToMessageId: 'gone-thread', to: 'andy@example.com', cc: '', bcc: '', subject: 'Fwd: Meeting Summary', bodyMarkdown: 'Forwarded notes', attachments: [] }]))
  })
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  const limited = { status: 502, json: { error: 'gmail_backoff', detail: 'Gmail is rate limiting this account. Retry after 2026-09-24T10:54:58.101Z' } }
  let pendingSave: import('@playwright/test').Route | undefined
  const discards: string[] = []
  await page.route(/8411\/v1\/draft-saves$/, route => {
    if (route.request().method() === 'POST' && !pendingSave) { pendingSave = route; return }
    return route.fulfill(limited)
  })
  await page.route(/8411\/v1\/drafts\/gone-draft(\?.*)?$/, route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('action') === 'discard') { discards.push(url.search); return route.fulfill({ json: { discarded: true } }) }
    return route.fulfill(limited)
  })
  await page.goto('/')
  await expect.poll(() => Boolean(pendingSave), { timeout: 20_000 }).toBe(true)
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await page.locator('[data-local-draft-key="stuck-draft"]').click()
  await expect(page.locator('[data-draft-body]')).toHaveText('Forwarded notes')
  await page.locator('[data-discard-draft]').click()
  await pendingSave!.fulfill(limited)
  await expect.poll(() => discards).toEqual(['?action=discard&account=one'])
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveCount(0)
  expect(await localRecovery(page)).toEqual([])
})

test('says why Discard could not reach Gmail and keeps the draft', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('dispatch.editor-recovery.v1', JSON.stringify([{ key: 'limited-draft', updatedAt: '2026-09-23T19:47:07Z', revision: 3, accountId: 'one', accountLabel: 'work@example.com', gmailDraftId: 'limited', gmailThreadId: 'limited-thread', inReplyToMessageId: 'limited-thread', to: 'andy@example.com', cc: '', bcc: '', subject: 'Rate limited draft', bodyMarkdown: 'Keep me', attachments: [] }]))
  })
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  const limited = { status: 502, json: { error: 'gmail_backoff', detail: `Gmail is rate limiting this account. Retry after ${new Date(Date.now() + 10 * 60_000).toISOString()}` } }
  await page.route(/8411\/v1\/drafts\/limited(\?.*)?$/, route => route.fulfill(limited))
  await page.goto('/')
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await page.locator('[data-local-draft-key="limited-draft"]').click()
  await expect(page.locator('[data-draft-body]')).toHaveText('Keep me')
  await page.locator('[data-discard-draft]').click()
  await expect(page.locator('[data-draft-error]')).toHaveText(/^Gmail is limiting requests from this account until .+\. Try again then\.$/)
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText('Keep me')
  expect((await localRecovery(page)).map(item => item.key)).toEqual(['limited-draft'])
})

test('keeps a new draft and says so when Discard follows a save Gmail may have completed', async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  let pendingCreate: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/draft-saves', route => { pendingCreate = route })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.locator('[data-draft-body]').fill('Maybe saved')
  await expect.poll(() => Boolean(pendingCreate)).toBe(true)
  await page.locator('[data-discard-draft]').click()
  await pendingCreate!.fulfill({ status: 504, json: { error: 'gmail_draft_create_failed', detail: 'Timed out waiting for Gmail.' } })
  await expect(page.locator('[data-draft-error]')).toHaveText('Timed out waiting for Gmail.')
  expect(await localRecovery(page)).toHaveLength(1)
})

test('autosaves a new draft and keeps recovery out of the Inbox', async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  let saved = false
  await page.route('http://127.0.0.1:8411/v1/draft-saves', route => {
    saved = true
    const fields = route.request().postDataJSON()
    return route.fulfill({ json: { draft: { ...fields, id: 'autosaved', accountId: 'one', inReplyToMessageId: '', to: [], bodyHtml: '<p>New draft text</p>', attachments: [], state: 'draft' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByLabel('Draft body').fill('New draft text')
  await expect.poll(() => saved).toBe(true)
  await expect.poll(async () => (await localRecovery(page)).length).toBe(0)
  await expect(page.locator('.dispatch-recovery-banner, [data-recovery-open]')).toHaveCount(0)
})

test('retries an unsent draft from a previous session without opening its editor', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dispatch.editor-recovery.v1', JSON.stringify([{ key: 'queued-draft', updatedAt: '2026-09-11T00:00:00Z', revision: 1, accountId: 'one', gmailDraftId: '', inReplyToMessageId: '', to: 'work@example.com', cc: '', bcc: '', subject: 'Queued draft', bodyMarkdown: 'Keep this text', attachments: [] }])))
  const writes: any[] = []
  await page.route('http://127.0.0.1:8411/v1/draft-saves', route => {
    const fields = route.request().postDataJSON(); writes.push(fields)
    if (writes.length === 1) return route.fulfill({ status: 503, json: { error: 'temporarily unavailable' } })
    return route.fulfill({ json: { draft: { ...fields, id: 'saved', gmailThreadId: 'saved-thread', accountId: 'one', inReplyToMessageId: '', to: [], bodyHtml: '<p>Keep this text</p>', attachments: [], state: 'draft' } } })
  })
  await page.goto('/')
  await expect.poll(() => writes.length, { timeout: 20_000 }).toBe(2)
  expect(writes.map(write => write.clientDraftId)).toEqual(['queued-draft', 'queued-draft'])
  expect(writes[1].bodyMarkdown).toBe('Keep this text')
  await expect(page.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await expect.poll(async () => (await localRecovery(page)).length).toBe(0)
  await expect(page.getByText('Saved on this Mac', { exact: true })).toHaveCount(0)
})

test('keeps a newer recovery copy while an older Gmail save is pending', async ({ page }) => {
  let pending: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', route => { pending = route })
  await page.goto('/'); await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.locator('[data-draft-body]').fill('Older text')
  await expect.poll(() => Boolean(pending)).toBe(true)
  await page.locator('[data-draft-body]').fill('Newer text')
  await pending!.fulfill({ json: { draft: { id: 'saved', accountId: 'one', inReplyToMessageId: '', to: [], subject: '', bodyMarkdown: 'Older text', bodyText: 'Older text', bodyHtml: '<p>Older text</p>', attachments: [], state: 'draft' } } })
  await expect(page.locator('[data-draft-body]')).toHaveText('Newer text')
  expect((await localRecovery(page))[0]?.bodyMarkdown).toBe('Newer text')
})

test('Send closes the editor immediately while Gmail is still responding', async ({ page }) => {
  const draft = { id: 'd-receipt', accountId: 'one', inReplyToMessageId: 'm1', to: [messages[0]!.sender], cc: '', bcc: '', subject: 'Delivery', bodyMarkdown: 'Hello', bodyText: 'Hello', bodyHtml: '<p>Hello</p>', attachments: [], state: 'draft' }
  let pending: import('@playwright/test').Route | undefined
  await page.route('http://127.0.0.1:8411/v1/drafts', route => route.fulfill({ json: { draft } }))
  await page.route('http://127.0.0.1:8411/v1/draft-sends', route => { if (route.request().method() === 'GET') return route.fulfill({ json: { sends: [] } }); pending = route })
  await page.goto('/'); await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await page.locator('[data-send-draft]').click()
  await expect(page.locator('[data-draft]')).toBeHidden()
  await expect(page.locator('[data-send-status]')).toContainText('Sending')
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
  await page.route('http://127.0.0.1:8411/v1/draft-saves', route => {
    const fields = route.request().postDataJSON() as Record<string, unknown>
    if (!fields.draftId) { creates++; pending = route; return }
    updates.push(fields)
    return route.fulfill({ status: 202, json: { draft: { ...draft, id: String(fields.draftId), bodyMarkdown: fields.bodyMarkdown, bodyText: fields.bodyMarkdown } } })
  })
  await page.goto('/'); await expect(page.locator('[data-body]')).toContainText('Original')
  await page.locator(`[data-${action}]`).click()
  await expect(page.locator('[data-draft-body]')).toBeVisible()
  await expect.poll(() => Boolean(pending)).toBe(true)
  await page.locator('[data-draft-body]').fill('My immediate edit')
  await page.locator(`[data-${action}]`).click()
  expect(creates).toBe(1)
  await expect(page.locator('[data-draft-body]')).toHaveText('My immediate edit')
  await pending!.fulfill({ status: 202, json: { draft } })
  await expect(page.locator('[data-draft-body]')).toHaveText('My immediate edit')
  await expect.poll(() => updates.at(-1)?.bodyMarkdown).toBe('My immediate edit')
  await expect(page.locator('[data-recovery-open]')).toBeHidden()
})

for (const action of ['reply', 'forward'] as const) test(`${action} reuses its locally acknowledged pending draft after typing`, async ({ page }) => {
  const summary = { ...conversations[0]!, id: 'link-one:t1', accountId: 'link-one', accountLabel: 'work@example.com' }
  const sourceAttachment = { id: 'a1', name: 'arrival.pdf', mediaType: 'application/pdf', sizeLabel: '824 KB' }
  await stubGmailInbox(page, summary)
  await page.route(/8411\/v1\/conversations\/t1\?account=link-one/, route => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Original' }, attachments: [sourceAttachment] }] } } }))
  const creates: Record<string, unknown>[] = []
  const updates: Record<string, unknown>[] = []
  const queuedId = `queued-${action}`
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    if (fields.draftId) updates.push(fields)
    else creates.push(fields)
    const id = String(fields.draftId ?? queuedId)
    return route.fulfill({ status: 202, json: { draft: { ...draftProjectionFromCommand(fields, id), syncState: 'pending', syncError: 'Waiting for Gmail' } } })
  })

  await page.goto('/')
  await expect(page.locator('[data-body]')).toContainText('Original')
  await page.locator(`[data-${action}]`).click()
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toBeVisible()
  await expect(page.locator('[data-recovery-status]')).toHaveText('Waiting for Gmail')
  await expect.poll(() => creates.length).toBe(1)
  if (action === 'forward') {
    await expect(page.getByLabel('Draft attachments')).toContainText('arrival.pdf')
    expect(creates[0]?.attachments).toEqual([expect.objectContaining({ id: 'a1', sourceMessageId: 'm1' })])
    await page.getByRole('textbox', { name: 'Draft subject' }).fill('Edited forwarded subject')
  }
  await page.getByRole('textbox', { name: 'Draft body' }).fill(`My pending ${action} edit`)
  const recoveryBefore = await localRecovery(page)
  const recoveryKey = recoveryBefore.find(record => record.gmailDraftId === queuedId)?.key
  expect(recoveryKey).toBeTruthy()
  await page.getByRole('button', { name: 'Collapse draft', exact: true }).click()
  await page.locator(`[data-${action}]`).click()
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText(`My pending ${action} edit`)
  if (action === 'forward') await expect(page.getByRole('textbox', { name: 'Draft subject' })).toHaveValue('Edited forwarded subject')
  expect(creates).toHaveLength(1)
  expect((await localRecovery(page)).find(record => record.gmailDraftId === queuedId)?.key).toBe(recoveryKey)
  if (action === 'forward') await expect(page.getByLabel('Draft attachments')).toContainText('arrival.pdf')
  expect(updates.every(fields => fields.draftId === queuedId)).toBe(true)
})

test('Reply all changes recipients on the pending reply without replacing its edits or files', async ({ page }) => {
  const summary = { ...conversations[0]!, id: 'link-one:t1', accountId: 'link-one', accountLabel: 'work@example.com' }
  const copiedRecipient = { name: 'Blake Chen', address: 'blake@example.com', initials: 'BC' }
  const ccRecipient = { name: 'Cara Singh', address: 'cara@example.com', initials: 'CS' }
  await stubGmailInbox(page, summary)
  await page.route(/8411\/v1\/conversations\/t1\?account=link-one/, route => route.fulfill({ json: { conversation: { ...summary, source: 'gmail', messages: [{ ...messages[0]!, accountId: 'link-one', source: 'gmail', to: [copiedRecipient], cc: [ccRecipient], body: { kind: 'plain-text', content: 'Original' }, attachments: [] }] } } }))
  const creates: Record<string, unknown>[] = []
  const updates: Record<string, unknown>[] = []
  let remoteAttachments: unknown[] = []
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    if (fields.draftId) updates.push(fields)
    else creates.push(fields)
    if (Array.isArray(fields.attachments)) remoteAttachments = fields.attachments
    return route.fulfill({ status: 202, json: { draft: { ...draftProjectionFromCommand(fields, String(fields.draftId ?? 'queued-reply-mode')), attachments: remoteAttachments, syncState: 'pending', syncError: 'Waiting for Gmail' } } })
  })

  await page.goto('/')
  await expect(page.locator('[data-body]')).toContainText('Original')
  await page.locator('[data-reply]').click()
  await expect(page.locator('[data-recovery-status]')).toHaveText('Waiting for Gmail')
  await page.locator('[data-draft-body]').fill('Keep my manual reply text')
  await page.locator('[data-draft-files]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this file') })
  await expect(page.getByLabel('Draft attachments')).toContainText('notes.txt')
  await expect.poll(() => updates.length).toBe(1)
  const recoveryKey = creates[0]?.clientDraftId
  expect(typeof recoveryKey).toBe('string')
  expect(recoveryKey).toBeTruthy()

  const priorUpdates = updates.length
  await page.locator('[data-reply-all]').click()
  await expect(page.locator('[data-draft-body]')).toHaveText('Keep my manual reply text')
  await expect(page.getByLabel('Draft attachments')).toContainText('notes.txt')
  await expect.poll(() => updates.length).toBeGreaterThan(priorUpdates)
  expect(creates).toHaveLength(1)
  expect(updates.at(-1)).toMatchObject({ draftId: 'queued-reply-mode', cc: 'cara@example.com', bodyMarkdown: 'Keep my manual reply text' })
  expect(String(updates.at(-1)?.to)).toContain('blake@example.com')
  expect(updates.at(-1)?.clientDraftId).toBeTruthy()
})

test('switching away from a pending reply keeps its recovery identity without replacing the new thread', async ({ page }) => {
  let pending: import('@playwright/test').Route | undefined
  await page.route(/8411\/v1\/conversations\/t1/, route => route.fulfill({ json: { conversation: { ...conversations[0], accountId: 'one', source: 'gmail', messages: [{ ...messages[0], accountId: 'one', source: 'gmail', body: { kind: 'plain-text', content: 'Original' }, attachments: [] }] } } }))
  await page.route('http://127.0.0.1:8411/v1/draft-saves', route => { pending = route })
  await page.goto('/'); await expect(page.locator('[data-body]')).toContainText('Original')
  await page.locator('[data-reply]').click(); await expect.poll(() => Boolean(pending)).toBe(true)
  await page.locator('[data-draft-body]').fill('Keep my unsaved words')
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.locator('[data-subject]')).toHaveText('Services agreement')
  await pending!.fulfill({ status: 202, json: { draft: { id: 'late-reply', accountId: 'one', inReplyToMessageId: 'm1', to: [], cc: '', bcc: '', subject: 'Reply', bodyMarkdown: 'Original', bodyText: 'Original', bodyHtml: '', attachments: [], state: 'draft' } } })
  await expect.poll(async () => (await localRecovery(page))[0]?.gmailDraftId).toBe('late-reply')
  await expect(page.locator('[data-subject]')).toHaveText('Services agreement')
  expect((await localRecovery(page))[0]?.bodyMarkdown).toBe('Keep my unsaved words')
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
  await expect(page.getByLabel('Draft body')).toHaveText('Finished while away')
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

/** A second window in the same browser context, with the same fixtures. `window.close()` is recorded, not performed. */
async function openMessageWindowPage(page: Page, query: string, routes?: (target: Page) => Promise<void>): Promise<Page> {
  const popup = await page.context().newPage()
  await routeMailFixtures(popup)
  if (routes) await routes(popup)
  await popup.addInitScript(() => { const win = window as unknown as { __closed: boolean }; win.__closed = false; window.close = () => { win.__closed = true } })
  await popup.goto(`/?${query}`)
  return popup
}

/** Gmail-shaped rows for the demo messages, so moves and drafts have an account. */
function gmailMail(state: { archived?: boolean; draftStatus?: number } = {}) {
  const gmail = conversations.map((conversation) => ({ ...conversation, id: `gmail:one:${conversation.threadId}`, accountId: 'one', unread: false }))
  return async (target: Page) => {
    await target.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
    await target.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: state.archived ? gmail.slice(1) : gmail, nextCursor: null, total: gmail.length } }))
    await target.route(/8411\/v1\/conversations\/[^/?]+\/actions/, async route => { state.archived = true; await route.fulfill({ status: 202, json: {} }) })
    await target.route(/8411\/v1\/conversations\/[^/?]+(\?|$)/, route => route.fulfill({ json: { conversation: { ...gmail[0]!, source: 'gmail', messages: [{ ...messages[0]!, source: 'gmail', body: { kind: 'sanitized-html', content: '<p>Berth confirmed.</p>' }, attachments: [] }] } } }))
    await target.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
      if (state.draftStatus) return route.fulfill({ status: state.draftStatus, json: { error: 'gmail_backoff', detail: 'Gmail is rate limiting this account. Retry after 2099-01-01T00:00:00.000Z' } })
      const fields = await route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ status: 202, json: { draft: draftProjectionFromCommand(fields, String(fields.draftId ?? 'd-main')) } })
    })
  }
}

test('double-click or Open in New Window opens a conversation in its own window', async ({ page }) => {
  await page.addInitScript(() => {
    const opened: unknown[] = []
    ;(window as unknown as { __opened: unknown[] }).__opened = opened
    window.open = ((url?: string | URL, target?: string, features?: string) => { opened.push({ url: String(url), target, features }); return {} as Window }) as typeof window.open
  })
  await page.goto('/')
  await page.locator('[data-conversation-id="demo:t1"]').dblclick()
  const opened = () => page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened)
  await expect.poll(opened).toEqual([{ url: '/?window=message&conversation=demo%3At1&thread=t1&mailbox=inbox', target: 'dispatch-message-demo:t1', features: 'popup,width=960,height=780' }])
  await chooseThreadMenu(page, 'Open in New Window')
  await expect.poll(async () => (await opened()).length).toBe(2)
  // ⌘O opens the selected conversation, like File → Open in New Window in the app.
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await page.locator('[data-conversation-id="demo:t2"]').press('Meta+o')
  await expect.poll(async () => (await opened()).at(-1)).toMatchObject({ url: '/?window=message&conversation=demo%3At2&thread=t2&mailbox=inbox' })
  // Drafts are edited where they are listed.
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await page.locator('[data-conversation-id="demo:t2"]').dblclick()
  await page.waitForTimeout(300)
  expect((await opened()).length).toBe(3)
})

test('a message window shows only its conversation, with the reader tools and Codex on demand', async ({ page }) => {
  const popup = await openMessageWindowPage(page, 'window=message&conversation=demo%3At1&thread=t1&mailbox=inbox')
  await expect(popup.getByRole('heading', { name: 'Opua berth confirmation' })).toBeVisible()
  await expect(popup).toHaveTitle('Opua berth confirmation')
  for (const hidden of ['.dispatch-messages', '.dispatch-rail', '.dispatch-agent', '[data-search]', '[data-compose]']) await expect(popup.locator(hidden)).toBeHidden()
  for (const name of ['Reply', 'Reply all', 'Forward', 'Archive']) await expect(popup.getByRole('button', { name, exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(popup.getByRole('textbox', { name: 'Draft body' })).toBeVisible()
  await popup.locator('[data-ask]').click()
  await expect(popup.locator('.dispatch-agent')).toBeVisible()
  // The main window's layout is its own.
  expect(await popup.evaluate(() => localStorage.getItem('dispatch.panels.v1'))).toBeNull()
})

test('a message window with an incomplete address says so instead of opening mail', async ({ page }) => {
  const popup = await openMessageWindowPage(page, 'window=message&conversation=demo%3At1&mailbox=inbox')
  await expect(popup.locator('[data-reader-empty]')).toHaveText('This message window does not name a conversation.')
  await expect(popup.getByRole('heading', { name: 'Opua berth confirmation' })).toHaveCount(0)
})

test('archiving in a message window closes it, and the main window drops the row and offers Undo', async ({ page }) => {
  const state = { archived: false }
  await gmailMail(state)(page)
  await page.goto('/')
  await expect(page.locator('[data-conversation-id="gmail:one:t1"]')).toBeVisible()
  const popup = await openMessageWindowPage(page, 'window=message&conversation=gmail%3Aone%3At1&thread=t1&mailbox=inbox&account=one', gmailMail(state))
  await expect(popup.getByText('Berth confirmed.')).toBeVisible()
  await popup.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect.poll(() => popup.evaluate(() => (window as unknown as { __closed: boolean }).__closed)).toBe(true)
  expect(state.archived).toBe(true)
  await expect(page.locator('[data-conversation-id="gmail:one:t1"]')).toHaveCount(0)
  await expect(page.locator('[data-undo-toast]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
})

test('a draft open in a message window is neither opened nor saved by the main window until that window closes', async ({ page }) => {
  // The message window's own saves wait on Gmail, so its local copy stays pending.
  const popup = await openMessageWindowPage(page, 'window=message&conversation=gmail%3Aone%3At1&thread=t1&mailbox=inbox&account=one', gmailMail({ draftStatus: 502 }))
  await popup.getByRole('button', { name: 'Reply', exact: true }).click()
  await popup.getByRole('textbox', { name: 'Draft body' }).fill('Typed in the message window')
  await expect(popup.locator('[data-recovery-status]')).toHaveText('Saved · waiting to sync')

  const mainSaves: string[] = []
  page.on('request', request => { if (/\/v1\/draft-saves$/.test(new URL(request.url()).pathname) && request.method() === 'POST') mainSaves.push(request.method()) })
  await gmailMail()(page)
  await page.goto('/')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  const row = page.locator('[data-local-draft-key]')
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(page.locator('[data-mail-error]')).toHaveText('This draft is open in another window.')
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toBeHidden()
  expect(mainSaves).toEqual([])

  // Once the message window lets go, the main window saves the local copy.
  await popup.close()
  await expect.poll(() => mainSaves.length, { timeout: 15_000 }).toBeGreaterThan(0)
})

test('a message window shows a new reply once the mailbox index lists it', async ({ page }) => {
  const state = { revision: 1, latest: 'm1' }
  const row = { ...conversations[0]!, id: 'gmail:one:t1', accountId: 'one', unread: false }
  const first = { ...messages[0]!, source: 'gmail', body: { kind: 'sanitized-html', content: '<p>Berth confirmed.</p>' }, attachments: [] }
  const reply = { ...first, id: 'm9', receivedAt: '2026-09-04T10:15:00+12:00', receivedLabel: 'Sep 4, 10:15 AM', receivedFullLabel: 'September 4, 2026 at 10:15 AM', body: { kind: 'sanitized-html', content: '<p>See you on the 4th.</p>' } }
  const popup = await openMessageWindowPage(page, 'window=message&conversation=gmail%3Aone%3At1&thread=t1&mailbox=inbox&account=one', async (target) => {
    await gmailMail()(target)
    await target.route('http://127.0.0.1:8411/v1/sync/status', route => route.fulfill({ json: { sync: { state: 'ready', startedAt: '2026-09-04T09:00:00+12:00', completedAt: '2026-09-04T09:01:00+12:00', error: null, messageCount: 2, mailRevision: state.revision } } }))
    await target.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [{ ...row, latestMessageId: state.latest }], nextCursor: null, total: 1 } }))
    await target.route(/8411\/v1\/conversations\/[^/?]+(\?|$)/, route => route.fulfill({ json: { conversation: { ...row, latestMessageId: state.latest, messageCount: state.latest === 'm1' ? 1 : 2, source: 'gmail', messages: state.latest === 'm1' ? [first] : [first, reply] } } }))
  })
  await expect(popup.getByText('Berth confirmed.')).toBeVisible()
  state.revision = 2
  state.latest = 'm9'
  await expect(popup.getByText('See you on the 4th.')).toBeVisible({ timeout: 10_000 })
})

for (const dirty of [false, true]) test(`Codex's durable draft opens pending and confirms without losing edits (dirty=${dirty})`, async ({ page }) => {
  await page.addInitScript(() => {
    class FakeEvents { static CLOSED = 2; readyState = 1; onopen: any; onmessage: any; onerror: any; constructor() { (window as any).queueEvents = this; setTimeout(() => this.onopen?.({}), 0) } close() { this.readyState = 2 } }
    ;(window as any).EventSource = FakeEvents
  })
  await stubAgent(page)
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', name: 'Test', email: 'test@example.com' }] } }))
  const pendingDraft = { id: 'queued-test', accountId: 'one', inReplyToMessageId: '', to: [{ address: 'test@example.com', name: 'Test', initials: 'T' }], cc: '', bcc: '', subject: 'Durable draft', bodyMarkdown: 'AI draft text', bodyText: 'AI draft text', bodyHtml: '<p>AI draft text</p>', attachments: [], state: 'draft', syncState: 'pending' }
  let confirmed = false; let confirmingRead: import('@playwright/test').Route | undefined
  const updates: Record<string, any>[] = []
  await page.route(/8411\/v1\/drafts\/queued-test/, async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    if (confirmed && dirty) { confirmingRead = route; return new Promise(() => {}) }
    return route.fulfill({ json: { draft: confirmed ? { ...pendingDraft, id: 'gmail-saved', resolvedFromDraftId: 'queued-test', syncState: undefined } : pendingDraft } })
  })
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    updates.push(fields)
    return route.fulfill({ status: 202, json: { draft: { ...pendingDraft, ...fields, id: String(fields.draftId ?? 'gmail-saved'), syncState: undefined, to: pendingDraft.to } } })
  })
  await page.goto('/')
  await expect(page.locator('[data-agent-status]')).toHaveAttribute('data-status', 'Connected')
  await page.evaluate(draft => (window as any).queueEvents.onmessage({ data: JSON.stringify({ method: 'item/completed', params: { item: { type: 'mcpToolCall', server: 'dispatch_mail', tool: 'create_draft', status: 'completed', result: { structuredContent: { draft } } } } }) }), pendingDraft)
  await expect(page.locator('[data-draft-body]')).toHaveText('AI draft text')
  await expect(page.locator('[data-recovery-status]')).toHaveText('Saved · waiting to sync')
  await expect(page.locator('[data-send-draft]')).toBeEnabled()
  confirmed = true
  if (dirty) {
    await expect.poll(() => Boolean(confirmingRead), { timeout: 8000 }).toBe(true)
    await page.locator('[data-draft-body]').fill('My edit during Gmail confirmation')
    await confirmingRead!.fulfill({ json: { draft: { ...pendingDraft, id: 'gmail-saved', resolvedFromDraftId: 'queued-test', syncState: undefined } } })
    await expect(page.locator('[data-draft-body]')).toHaveText('My edit during Gmail confirmation')
    await expect.poll(() => updates.length).toBeGreaterThan(0)
    expect(updates.at(-1)?.bodyMarkdown).toBe('My edit during Gmail confirmation')
  }
  await expect(page.locator('[data-send-draft]')).toBeEnabled({ timeout: 8000 })
})

test('failed login renewal exposes a working reconnect action while keeping mail open', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any; w.isTauri = true; w.opened = []
    w.__TAURI__ = { core: { invoke: async (command: string, args: unknown) => { if (command === 'open_web_link') w.opened.push(args); return null } } }
  })
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', name: 'Test', email: 'test@example.com' }] } }))
  await page.route('http://127.0.0.1:8411/v1/sync/status', route => route.fulfill({ json: { sync: { state: 'failed', error: 'token_revoked', reconnectRequired: true, messageCount: 2 } } }))
  await page.route('http://127.0.0.1:8412/v1/account/reconnect', route => route.fulfill({ json: { authUrl: 'https://auth.openai.com/oauth/authorize?state=test' } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Reconnect Gmail' }).click()
  await expect(page.locator('[data-reconnect-status]')).toContainText('Finish sign-in')
  expect(await page.evaluate(() => (window as any).opened)).toEqual([{ url: 'https://auth.openai.com/oauth/authorize?state=test' }])
  expect(new URL(page.url()).pathname).toBe('/')
})

test('rich draft formatting survives saving and reopening', async ({ page }) => {
  await gmailMail()(page)
  const saved: Record<string, unknown>[] = []
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    const fields = await route.request().postDataJSON() as Record<string, unknown>
    saved.push(fields)
    await route.fulfill({ status: 202, json: { draft: draftProjectionFromCommand(fields, 'rich-one') } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Draft body' })
  await body.fill('Formatted words')
  await body.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'Bold', exact: true }).click()
  await expect(body.locator('b,strong')).toHaveText('Formatted words')
  await page.getByRole('button', { name: 'Insert link', exact: true }).click()
  await page.getByRole('textbox', { name: 'Link URL' }).fill('https://example.com/review')
  await page.getByRole('button', { name: 'Apply link', exact: true }).click()
  await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/review')
  await expect.poll(() => String(saved.at(-1)?.bodyMarkdown)).toBe('**[Formatted words](https://example.com/review)**')
  expect(String(saved.at(-1)?.bodyMarkdown)).toContain('https://example.com/review')
  await page.route('http://127.0.0.1:8411/v1/drafts/open', route => route.fulfill({ json: { draft: draftProjectionFromCommand(saved.at(-1)!, 'rich-one') } }))
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await page.locator('[data-conversation-id="gmail:one:t1"]').click()
  await expect(body.locator('strong')).toHaveText('Formatted words')
  await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/review')
})

test('popping out a draft transfers unsaved formatting, recipients and attachments', async ({ page }) => {
  await gmailMail({ draftStatus: 502 })(page)
  await page.addInitScript(() => {
    ;(window as unknown as { __draftUrl: string }).__draftUrl = ''
    window.open = ((url?: string | URL) => { (window as unknown as { __draftUrl: string }).__draftUrl = String(url); return {} }) as typeof window.open
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('textbox', { name: 'Draft recipient' }).fill('ana@example.com')
  await page.getByRole('textbox', { name: 'Draft subject' }).fill('Pop-out check')
  const body = page.getByRole('textbox', { name: 'Draft body' })
  await body.fill('Keep these words')
  await body.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'Italic', exact: true }).click()
  await page.locator('[data-draft-files]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment bytes') })
  await expect(page.locator('[data-draft-attachments]')).toContainText('note.txt')
  await page.getByRole('button', { name: 'Open draft in new window', exact: true }).click()
  const url = await page.evaluate(() => (window as unknown as { __draftUrl: string }).__draftUrl)
  expect(url).toContain('window=draft')
  await expect(body).toBeHidden()
  const popup = await openMessageWindowPage(page, url.split('?')[1]!, gmailMail({ draftStatus: 502 }))
  await expect(popup.getByRole('textbox', { name: 'Draft subject' })).toHaveValue('Pop-out check')
  await expect(popup.locator('[data-recipient-field]').first()).toContainText('ana@example.com')
  await expect(popup.locator('[data-draft-body] em')).toHaveText('Keep these words')
  await expect(popup.locator('[data-draft-attachments]')).toContainText('note.txt')
  await expect(popup.getByRole('button', { name: 'Open draft in new window', exact: true })).toBeHidden()
  await popup.getByRole('textbox', { name: 'Draft body' }).fill('Edited in its own window')
  await popup.close()
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  await page.locator('[data-local-draft-key]').click()
  await expect(body).toHaveText('Edited in its own window')
})

test('a blocked draft popup restores the original editor', async ({ page }) => {
  await gmailMail({ draftStatus: 502 })(page)
  await page.addInitScript(() => { window.open = () => null })
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('textbox', { name: 'Draft body' }).fill('Keep me here')
  await page.getByRole('button', { name: 'Open draft in new window', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toHaveText('Keep me here')
  await expect(page.locator('[data-draft-error]')).toContainText('browser blocked')
})

test('rich paste keeps lists and inline image references while rejecting active content', async ({ page }) => {
  await gmailMail({ draftStatus: 502 })(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Draft body' })
  await body.focus()
  await body.evaluate(element => {
    const clipboard = new DataTransfer()
    clipboard.setData('text/html', '<p><strong>Notes</strong> <u>review</u></p><ul><li>First</li><li>Second</li></ul><img src="cid:logo" alt="Logo"><script>alert(1)</script><a href="javascript:alert(1)">Unsafe link</a>')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  })
  await expect(body.locator('strong')).toHaveText('Notes')
  await expect(body.locator('u')).toHaveText('review')
  await expect(body.locator('li')).toHaveText(['First', 'Second'])
  await expect(body.locator('script,a,img')).toHaveCount(0)
  await body.press('End')
  await body.press('ArrowRight')
  await body.press('Space')
  await body.press('x')
  const records = await localRecovery(page)
  expect(records[0]?.bodyMarkdown).toContain('**Notes**')
  expect(records[0]?.bodyMarkdown).toContain('<u>review</u>')
  expect(records[0]?.bodyMarkdown).toContain('![Logo](cid:logo)')
  expect(records[0]?.bodyMarkdown).not.toContain('javascript:')
})

for (const action of ['double-click', 'context-menu'] as const) test(`a local draft opens in a new window from its row (${action}) even when the first click refreshes the list`, async ({ page }) => {
  await gmailMail({ draftStatus: 502 })(page)
  await page.addInitScript(() => {
    ;(window as unknown as { __draftUrl: string }).__draftUrl = ''
    window.open = ((url?: string | URL) => { (window as unknown as { __draftUrl: string }).__draftUrl = String(url); return {} }) as typeof window.open
  })
  await page.goto('/')
  await checkpointInWindow(page, 'row-pop', 1, '**Keep the formatting**')
  await page.getByRole('button', { name: 'Drafts', exact: true }).click()
  const row = page.locator('[data-local-draft-key="row-pop"]')
  await expect(row).toBeVisible()
  if (action === 'double-click') {
    // Simulate the native two clicks, with the editor/checkpoint rerender between them.
    await row.click()
    await expect(page.getByRole('textbox', { name: 'Draft body' })).toBeVisible()
    await row.click()
  } else {
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in New Window' }).click()
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { __draftUrl: string }).__draftUrl)).toContain('window=draft')
  await expect(page.getByRole('textbox', { name: 'Draft body' })).toBeHidden()
})

test('Codex permissions stay visible, save across reload and leave failed changes unselected', async ({ page }) => {
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Codex permissions', exact: true })
  await expect(toggle).toContainText('Full access')
  await toggle.click()
  const menu = page.getByRole('menu', { name: 'Codex permissions', exact: true })
  await expect(menu).toBeVisible()
  await menu.locator('[data-execution-mode="workspace"]').click()
  await expect(toggle).toContainText('Workspace')
  await expect(menu.locator('[data-execution-mode="workspace"]')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(toggle).toBeFocused()
  await page.reload()
  await expect(toggle).toContainText('Workspace')
  await page.route('http://127.0.0.1:8412/v1/execution-preferences', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    await route.fulfill({ status: 500, json: { error: 'codex_execution_preference_save_failed', detail: 'Disk is full' } })
  })
  await toggle.click()
  await menu.locator('[data-execution-mode="full-access"]').click()
  await expect(menu.locator('[data-permissions-status]')).toContainText('Disk is full')
  await expect(toggle).toContainText('Workspace')
  await expect(menu.locator('[data-execution-mode="full-access"]')).toHaveAttribute('aria-checked', 'false')
})

async function stubComposerEvents(page: Page) {
  await page.addInitScript(() => {
    const sources: Record<string, unknown> = {}
    class FakeEvents {
      static CLOSED = 2
      readyState = 1
      onopen?: () => void
      onmessage?: (event: { data: string }) => void
      onerror?: () => void
      constructor(url: string) { sources[url] = this; setTimeout(() => this.onopen?.(), 0) }
      close() { this.readyState = 2 }
    }
    Object.assign(window, { EventSource: FakeEvents, composerEvents: sources })
  })
  await stubAgent(page, { 'conversation:demo:t1': { threadId: 'composer-A' }, 'conversation:demo:t2': { threadId: 'composer-B' } })
  await page.route(/8412\/v1\/threads\/composer-[AB]$/, route => {
    const id = route.request().url().split('/').pop()!
    return route.fulfill({ json: { thread: { turns: [{ id: `${id}-turn`, status: 'inProgress', items: [{ type: 'agentMessage', text: `Working on ${id}` }] }] } } })
  })
}

async function composerEvent(page: Page, threadId: string, method: string, turn: Record<string, unknown>) {
  await page.evaluate(({ threadId, method, turn }) => {
    const sources = (window as unknown as { composerEvents: Record<string, { onmessage?: (event: { data: string }) => void }> }).composerEvents
    sources[`http://127.0.0.1:8412/v1/events?threadId=${threadId}`]?.onmessage?.({ data: JSON.stringify({ method, params: { threadId, turn } }) })
  }, { threadId, method, turn })
}

test('Codex Stop waits for completion, preserves typing and never sends while stopping', async ({ page }) => {
  await stubComposerEvents(page)
  let interruptions = 0
  let steering = 0
  await page.route(/8412\/v1\/threads\/composer-A\/interrupt/, async route => {
    expect(route.request().postDataJSON()).toEqual({ turnId: 'composer-A-turn' })
    interruptions++
    await route.fulfill({ json: {} })
  })
  await page.route(/8412\/v1\/threads\/composer-A\/steer/, route => { steering++; return route.fulfill({ json: {} }) })
  await page.goto('/')
  await expect(page.getByText('Working on composer-A')).toBeVisible()
  const prompt = page.getByRole('textbox', { name: 'Ask Codex' })
  const stop = page.locator('[data-stop]')
  const original = await stop.boundingBox()
  await prompt.fill('Keep this unsent follow-up')
  await expect(page.getByRole('button', { name: 'Update Codex direction' })).toBeVisible()
  expect((await stop.boundingBox())?.x).toBe(original?.x)
  await stop.click()
  await expect.poll(() => interruptions).toBe(1)
  await expect(stop).toBeDisabled()
  await expect(page.locator('[data-agent-state-text]')).toHaveText('Stopping…')
  await prompt.press('Enter')
  expect(steering).toBe(0)
  await composerEvent(page, 'composer-A', 'turn/started', { id: 'composer-A-turn' })
  await expect(stop).toBeDisabled()
  await composerEvent(page, 'composer-A', 'turn/completed', { id: 'composer-A-turn', status: 'interrupted' })
  await expect(stop).toBeHidden()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect(prompt).toHaveValue('Keep this unsent follow-up')
  await expect(page.locator('[data-agent-state-text]')).toHaveText('Stopped')
})

test('a late Stop failure remains with its own email and can be retried', async ({ page }) => {
  await stubComposerEvents(page)
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  let attempts = 0
  await page.route(/8412\/v1\/threads\/composer-A\/interrupt/, async route => {
    attempts++
    if (attempts === 1) { await delayed; await route.fulfill({ status: 502, json: { error: 'interrupt_failed', detail: 'Codex temporarily unavailable' } }) }
    else await route.fulfill({ json: {} })
  })
  await page.goto('/')
  await expect(page.getByText('Working on composer-A')).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('A follow-up')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.getByText('Working on composer-B')).toBeVisible()
  release()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  await expect(page.locator('[data-agent-state-text]')).toHaveText('Working…')
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await expect(page.getByText('Working on composer-A')).toBeVisible()
  await expect(page.locator('[data-agent-state-text]')).toContainText('Couldn’t stop:')
  await expect(page.getByRole('textbox', { name: 'Ask Codex' })).toHaveValue('A follow-up')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => attempts).toBe(2)
  await expect(page.locator('[data-agent-state-text]')).toHaveText('Stopping…')
})

test('Codex single-row footer keeps permissions and Stop visible in a narrow panel', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dispatch.panels.v1', JSON.stringify({ messages: true, reader: true, agent: true, messagesWidth: 300, agentWidth: 280 })))
  await stubComposerEvents(page)
  await page.route('http://127.0.0.1:8412/v1/models', route => route.fulfill({ json: {
    defaults: { model: 'gpt-6.1-sol', effort: 'xhigh' }, rateLimitsError: null,
    models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['medium', 'xhigh'], exhausted: false, resetsAt: null }],
  } }))
  await page.goto('/')
  await expect(page.getByText('Working on composer-A')).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Codex' }).fill('Use the newest proposal')
  const bounds = await page.locator('.dispatch-prompt-toolbar').evaluate(element => {
    const toolbar = element.getBoundingClientRect()
    const controls = [...element.querySelectorAll<HTMLElement>('[data-model-toggle],[data-permissions-toggle],[data-send],[data-stop]')].map(control => {
      const rect = control.getBoundingClientRect()
      return { x: rect.x, right: rect.right, y: rect.y, height: rect.height }
    })
    return { width: toolbar.width, left: toolbar.left, right: toolbar.right, controls }
  })
  expect(bounds.width).toBeLessThan(300)
  for (const control of bounds.controls) {
    expect(control.x).toBeGreaterThanOrEqual(bounds.left)
    expect(control.right).toBeLessThanOrEqual(bounds.right + 1)
  }
  expect(Math.max(...bounds.controls.map(control => control.y + control.height / 2)) - Math.min(...bounds.controls.map(control => control.y + control.height / 2))).toBeLessThan(2)
  await expect(page.getByRole('button', { name: 'Codex permissions', exact: true })).toContainText('Full access')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.locator('[data-stop-icon]')).toHaveClass('ti ti-player-stop')
  await expect(page.locator('.dispatch-agent-header').getByRole('button', { name: 'Codex settings' })).toBeVisible()
})

test('To-dos carries work across threads, preserves edits, and keeps mail actions scoped', async ({page}) => {
  await stubAgent(page)
  const bindings:Record<string,unknown>[]=[]
  await page.route('http://127.0.0.1:8412/v1/threads/bindings',async route=>{const body=route.request().postDataJSON();bindings.push(body);await route.fulfill({json:{binding:{threadId:`work-${body.kind}-${body.contextId??body.gmailThreadId??'general'}`,created:false,replaced:false}}})})
  const source={id:'source',kind:'email',accountId:'demo',threadId:'t1',messageId:'m1',title:'Weekly delivery review',at:'2026-10-01T10:00:00Z',author:'jacob@example.com',participants:['jacob@example.com','steve@example.com'],text:''}
  const item={id:'abc123',accountId:'demo',kind:'task',title:'Confirm the revised delivery date',summary:'Jacob is checking the revised delivery date. This remains open from last week.',topic:'September delivery',topicId:'topic123',contacts:['jacob@example.com'],owner:'jacob@example.com',due:'2026-10-05',status:'waiting',certainty:'explicit',snoozedUntil:null,revision:1,reason:'Waiting for Jacob',evidence:[{source,quote:'I will confirm the revised delivery date.'},{source:{...source,id:'discussion',kind:'codex',codexThreadId:'older-chat'},quote:'Keep the agreed delivery window.'}]}
  const decision={...item,id:'decision123',kind:'decision',title:'Keep the agreed delivery window',summary:'The delivery window carries forward into the next weekly review.'}
  await page.route('http://127.0.0.1:8413/**',async route=>{
    const url=new URL(route.request().url())
    if(route.request().method()==='POST'&&url.pathname.endsWith('abc123')){Object.assign(item,route.request().postDataJSON(),{revision:item.revision+1});await route.fulfill({json:{item}});return}
    if(url.pathname.includes('/items/')){await route.fulfill({json:{item,history:[]}});return}
    const filter=url.searchParams.get('filter')??'all'
    const visible=filter==='done'?item.status==='done':filter==='snoozed'?item.status==='snoozed':!['done','snoozed','dismissed'].includes(item.status)
    await route.fulfill({json:{items:visible?[item]:[],decisions:[decision],people:['jacob@example.com'],topics:[{id:'topic123',name:'September delivery',accountId:'demo'}],scan:{enabled:true,running:false,scanned:30,total:30,depth:30,lastScan:'2026-10-02T10:00:00Z',error:null,failures:0}}})
  })
  let mailMutations=0
  page.on('request',request=>{if(request.method()==='POST'&&/8411.*\/actions/.test(request.url()))mailMutations++})
  await page.goto('/')
  await page.locator('.dispatch-rail [data-work-nav="todos"]').click()
  await expect(page.getByRole('heading',{name:'Work that stays with you'})).toBeVisible()
  await expect(page.getByRole('heading',{name:item.title,exact:true})).toBeVisible()
  await expect(page.getByText('Source trail')).toBeVisible()
  await expect.poll(()=>bindings.some(b=>b.kind==='topic'&&b.contextId==='topic123')).toBe(true)
  await page.getByRole('button',{name:'Contact context',exact:true}).click()
  item.summary += ' Latest update from this week.'
  await expect(page.locator('.work-summary')).toContainText('Latest update from this week.',{timeout:7000})
  await expect(page.getByRole('button',{name:'Contact context',exact:true})).toHaveAttribute('aria-pressed','true')
  await page.keyboard.press('Backspace');await page.keyboard.press('e')
  expect(mailMutations).toBe(0)
  await page.locator('[data-work="contact"]').click()
  await expect.poll(()=>bindings.some(b=>b.kind==='contact'&&b.contextId==='jacob@example.com')).toBe(true)
  await page.locator('[data-work="source"]').nth(1).click()
  await expect(page.getByText('History for older-chat')).toBeVisible()
  await page.getByRole('textbox',{name:'Ask Codex'}).fill('Continue this discussion')
  await expect(page.locator('[data-send]')).toBeDisabled()
  await page.getByRole('button',{name:'Contact context',exact:true}).click()
  await expect(page.getByText('History for work-contact-jacob%40example.com')).toBeVisible()
  await expect(page.locator('[data-send]')).toBeEnabled()
  await page.getByText('Edit details',{exact:true}).click()
  await page.locator('[data-work-edit] input[name="title"]').fill('Confirm delivery with Jacob')
  await page.getByRole('button',{name:'Save changes',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Confirm delivery with Jacob',exact:true})).toBeVisible()
  await page.locator('[data-work="status"][data-value="done"]').click()
  await page.locator('[data-work="filter"][data-value="done"]').click()
  await expect(page.getByRole('heading',{name:'Confirm delivery with Jacob',exact:true})).toBeVisible()
  await page.reload()
  await page.locator('.dispatch-rail [data-work-nav="todos"]').click()
  await page.locator('[data-work="filter"][data-value="done"]').click()
  await expect(page.getByRole('heading',{name:'Confirm delivery with Jacob',exact:true})).toBeVisible()
  await page.locator('[data-work="status"][data-value="open"]').click()
  await page.locator('[data-work="filter"][data-value="all"]').click()
  await page.getByRole('button',{name:'Snooze',exact:true}).click()
  await page.locator('[data-work="filter"][data-value="snoozed"]').click()
  await expect(page.getByRole('heading',{name:'Confirm delivery with Jacob',exact:true})).toBeVisible()
  await page.screenshot({path:resolve('test-results','ea-todos.png'),fullPage:true})
  await page.locator('[data-work="source"]').first().click()
  await expect(page.getByRole('button',{name:'← Back to work'})).toBeVisible()
  await expect(page.locator('[data-reader]')).toBeVisible()
  await page.getByRole('button',{name:'← Back to work'}).click()
  await expect(page.getByRole('heading',{name:'Work that stays with you'})).toBeVisible()
  await page.locator('.dispatch-rail [data-mailbox="inbox"]').click()
  await expect(page.locator('.dispatch-work-detail')).toBeHidden()
})

test('work controls stay visible above a long email and Contact follows the latest selection', async ({page}) => {
  await stubAgent(page)
  const bindings: Record<string,unknown>[]=[]
  await page.route('http://127.0.0.1:8412/v1/threads/bindings',async route=>{const body=route.request().postDataJSON();bindings.push(body);await route.fulfill({json:{binding:{threadId:'scoped-chat',created:false,replaced:false}}})})
  await page.route(/http:\/\/127\.0\.0\.1:8411\/v1\/conversations\/(.+)/,route=>{
    const thread=new URL(route.request().url()).pathname.split('/').pop()
    const summary=conversations.find(c=>c.threadId===thread)!
    const message={...messages.find(m=>m.threadId===thread)!,accountId:'demo',source:'demo',body:{kind:'sanitized-html',content:'<p>Long email paragraph.</p>'.repeat(80)},attachments:[]}
    return route.fulfill({json:{conversation:{...summary,accountId:'demo',source:'demo',messages:[message]}}})
  })
  await page.goto('/')
  const review=page.getByRole('button',{name:'Find to-dos in this thread',exact:true})
  await expect(review).toBeVisible()
  await expect(review).toBeInViewport()
  expect(await page.locator('.dispatch-reader-header').getByRole('button',{name:'Find to-dos in this thread'}).count()).toBe(1)
  await page.getByRole('button',{name:'Contact context',exact:true}).click()
  await expect.poll(()=>bindings.some(b=>b.kind==='contact'&&b.contextId==='ana@example.com')).toBe(true)
  await page.locator('[data-conversation-id="demo:t2"]').click()
  await expect(page.locator('.dispatch-reader-subject')).toHaveText('Services agreement')
  await page.getByRole('button',{name:'Contact context',exact:true}).click()
  await expect.poll(()=>bindings.some(b=>b.kind==='contact'&&b.contextId==='james@example.com')).toBe(true)
  await expect(review).toBeInViewport()
})

for (const navigate of [false, true]) {
  test(`failed Send keeps the exact reply${navigate ? ' without replacing a newer compose' : ' and reopens it'}`, async ({ page }) => {
    await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'demo', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
    let resolveStatus!: () => void
    const gate = new Promise<void>(resolve => { resolveStatus = resolve })
    await page.route('http://127.0.0.1:8411/v1/draft-sends', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { sends: [] } })
      expect(route.request().postDataJSON()).toMatchObject({ bodyMarkdown: 'Send exactly this reply' })
      return route.fulfill({ status: 202, json: { receipt: { id: 'pending-send', accountId: 'demo', status: 'preparing' } } })
    })
    await page.route('http://127.0.0.1:8411/v1/draft-sends/pending-send', async route => {
      await gate
      return route.fulfill({ json: { receipt: { id: 'pending-send', accountId: 'demo', status: 'failed', error: 'Gmail unavailable. Nothing was sent.' } } })
    })
    await page.route('http://127.0.0.1:8411/v1/drafts', route => route.fulfill({ json: { draft: { ...draftProjectionFromCommand({ accountId: 'demo', to: 'ana@example.com', subject: 'Reply' }, 'd1') } } }))
    await page.goto('/')
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await page.locator('[data-draft-body]').fill('Send exactly this reply')
    await page.locator('[data-send-draft]').click()
    await expect(page.locator('[data-draft]')).toBeHidden()
    if (navigate) {
      await page.getByRole('button', { name: 'Compose', exact: true }).click()
      await page.locator('[data-draft-body]').fill('A completely different email')
    }
    resolveStatus()
    await expect(page.locator('[data-send-status]')).toBeHidden()
    await expect(page.locator('[data-draft-body]')).toHaveText(navigate ? 'A completely different email' : 'Send exactly this reply')
    await expect(page.locator(navigate ? '[data-mail-error]' : '[data-draft-error]')).toContainText('Nothing was sent')
  })
}

test('reply Send handles a locally queued autosave without requiring Save or a second confirmation', async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/draft-saves', async route => {
    const fields = route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { draft: { ...draftProjectionFromCommand(fields, 'queued-123'), syncState: 'pending' } } })
  })
  let sends = 0
  await page.route('http://127.0.0.1:8411/v1/draft-sends', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sends: [] } })
    sends++
    expect(route.request().postDataJSON()).toMatchObject({ draftId: 'queued-123' })
    return route.fulfill({ status: 202, json: { receipt: { id: 'one-send', accountId: 'demo', status: 'accepted' } } })
  })
  await page.route('http://127.0.0.1:8411/v1/drafts/queued-123?account=demo', route => route.fulfill({ json: { draft: { ...draftProjectionFromCommand({ accountId: 'demo', to: 'ana@example.com', bodyMarkdown: 'Queued reply' }, 'queued-123'), syncState: 'pending', syncError: 'Gmail is saving this reply' } } }))
  await page.route('http://127.0.0.1:8411/v1/drafts', route => route.fulfill({ json: { draft: { ...draftProjectionFromCommand({ accountId: 'demo', to: 'ana@example.com', subject: 'Reply' }, 'd1') } } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await page.locator('[data-draft-body]').fill('Queued reply')
  // Demo saves use their direct path; return a pending projection there too.
  await page.route(/8411\/v1\/drafts\/d1/, route => route.fulfill({ json: { draft: { ...draftProjectionFromCommand({ accountId: 'demo', to: 'ana@example.com', bodyMarkdown: 'Queued reply' }, 'queued-123'), syncState: 'pending', syncError: 'Gmail is saving this reply' } } }))
  await expect(page.locator('[data-recovery-status]')).toHaveText('Gmail is saving this reply')
  await expect(page.locator('[data-send-draft]')).toBeEnabled()
  await expect(page.locator('[data-save-draft], [data-send-confirm]')).toHaveCount(0)
  await page.locator('[data-send-draft]').click()
  await expect(page.locator('[data-draft]')).toBeHidden()
  await expect.poll(() => sends).toBe(1)
})

test('a successfully sent new compose stays closed when there is no selected thread to refresh', async ({ page }) => {
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'demo', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }] } }))
  let sends = 0
  await page.route('http://127.0.0.1:8411/v1/draft-sends', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sends: [] } })
    sends++
    expect(route.request().postDataJSON()).toMatchObject({ to: 'ana@example.com', subject: 'New message', bodyMarkdown: 'Send this new message once' })
    return route.fulfill({ status: 202, json: { receipt: { id: 'compose-send', accountId: 'demo', status: 'preparing' } } })
  })
  await page.route('http://127.0.0.1:8411/v1/draft-sends/compose-send', route => route.fulfill({ json: { receipt: { id: 'compose-send', accountId: 'demo', status: 'accepted', messageId: 'sent-new-message' } } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.locator('[data-draft-to]').fill('ana@example.com')
  await page.locator('[data-draft-subject]').fill('New message')
  await page.locator('[data-draft-body]').fill('Send this new message once')
  await page.locator('[data-send-draft]').click()
  await expect(page.locator('[data-draft]')).toBeHidden()
  await expect(page.locator('[data-send-status]')).toBeHidden()
  await expect(page.locator('[data-draft]')).toBeHidden()
  await expect(page.locator('[data-draft-error]')).toBeHidden()
  expect(await localRecovery(page)).toHaveLength(0)
  expect(sends).toBe(1)
})

test('a new unread message releases the prior read override and agrees with the Inbox badge', async ({ page }) => {
  await page.clock.install()
  let first = { ...conversations[0]!, accountId: 'link-one', unread: true }
  const second = { ...conversations[1]!, accountId: 'link-one', unread: true }
  let count = 2
  await stubGmailInbox(page, first)
  await page.route(/8411\/v1\/conversations\?/, route => route.fulfill({ json: { source: 'gmail', conversations: [first, second] } }))
  await page.route(/8411\/v1\/mailboxes\/counts/, route => route.fulfill({ json: { counts: { inbox: count, drafts: 0, spam: 0 } } }))
  await page.route(/8411\/v1\/conversations\/t1\?/, route => route.fulfill({ json: { conversation: { ...first, source: 'gmail', messages: [{ ...messages[0]!, id: first.latestMessageId, accountId: 'link-one', source: 'gmail', body: { kind: 'plain-text', content: 'Latest body' }, attachments: [] }] } } }))
  await page.route(/8411\/v1\/conversations\/t1\/read-state/, route => { count = 1; return route.fulfill({ json: { accepted: true } }) })
  await page.route('http://127.0.0.1:8411/v1/sync', route => route.fulfill({ json: { sync: { state: 'ready', messageCount: 2 } } }))
  await page.goto('/')
  await expect(page.getByText('Latest body', { exact: true })).toBeVisible()
  await page.locator('[data-conversation-id="demo:t1"]').click()
  await page.clock.fastForward(5000)
  await expect(page.locator('[data-conversation-id="demo:t1"]')).not.toHaveClass(/dispatch-message-unread/)
  await expect(page.locator('[data-mailbox-count="inbox"]').last()).toHaveText('1')
  await page.locator('[data-conversation-id="demo:t2"]').click()
  first = { ...first, latestMessageId: 'new-arrival', unread: true, receivedAt: '2026-10-05T01:00:00Z' }; count = 2
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('[data-conversation-id="demo:t1"]')).toHaveClass(/dispatch-message-unread/)
  await expect(page.locator('.dispatch-message-unread')).toHaveCount(2)
  await expect(page.locator('[data-mailbox-count="inbox"]').last()).toHaveText('2')
})

for (const scenario of ['clean', 'late-edit', 'different-draft', 'without-tool-event']) test(`confirmed agent Send reconciles queued aliases safely (${scenario})`, async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    class FakeEvents { static CLOSED = 2; readyState = 1; onopen: any; onmessage: any; onerror: any; constructor() { (window as any).sendEvents = this; setTimeout(() => this.onopen?.({}), 0) } close() { this.readyState = 2 } }
    ;(window as any).EventSource = FakeEvents
  })
  await stubAgent(page)
  await page.route('http://127.0.0.1:8411/v1/accounts', route => route.fulfill({ json: { accounts: [{ id: 'one', name: 'Test', email: 'test@example.com' }] } }))
  const draft = { id: 'queued-alias', accountId: 'one', inReplyToMessageId: '', to: [{ name: 'Test', address: 'test@example.com', initials: 'T' }], subject: 'Already sent', cc: '', bcc: '', bodyMarkdown: 'Original draft', bodyText: 'Original draft', bodyHtml: '', attachments: [], state: 'draft' }
  await page.route(/8411\/v1\/drafts\/queued-alias\?/, route => route.fulfill({ json: { draft } }))
  let held: import('@playwright/test').Route | undefined
  await page.route(/8411\/v1\/drafts\/queued-alias\/send-status/, route => { held = route })
  await page.goto('/')
  await expect(page.locator('[data-agent-status]')).toHaveAttribute('data-status', 'Connected')
  await page.evaluate(draft => (window as any).sendEvents.onmessage({ data: JSON.stringify({ method: 'item/completed', params: { item: { type: 'mcpToolCall', server: 'dispatch_mail', tool: 'create_draft', status: 'completed', result: { structuredContent: { draft } } } } }) }), draft)
  await expect(page.locator('[data-draft-body]')).toHaveText('Original draft')
  if (scenario === 'without-tool-event') await page.clock.fastForward(5000)
  else await page.evaluate(() => (window as any).sendEvents.onmessage({ data: JSON.stringify({ method: 'item/completed', params: { item: { type: 'mcpToolCall', server: 'gmail', tool: 'gmail.send_draft', arguments: { link_id: 'one', draft_id: 'gmail-remote' }, status: 'completed', result: { structuredContent: { id: 'sent-id' } } } } }) }))
  await expect.poll(() => Boolean(held)).toBe(true)
  if (scenario === 'late-edit') await page.locator('[data-draft-body]').fill('Keep my later edit')
  if (scenario === 'different-draft') { await page.getByRole('button', { name: 'Compose', exact: true }).click(); await page.locator('[data-draft-body]').fill('Different message') }
  await held!.fulfill({ json: { receipt: { id: 'confirmed', accountId: 'one', draftId: 'gmail-remote', status: 'verified', messageId: 'sent-id' } } })
  if (scenario === 'late-edit' || scenario === 'different-draft') await expect(page.locator('[data-draft-body]')).toHaveText(scenario === 'late-edit' ? 'Keep my later edit' : 'Different message')
  else await expect(page.locator('[data-draft]')).toBeHidden()
})

test('EA shows a fixed newspaper with separate later updates and dated history',async({page})=>{
 await stubAgent(page)
 const source={id:'mail-source',kind:'email',accountId:'demo',threadId:'t1',messageId:'m1',title:'Delivery update',at:'2026-10-05T08:00:00Z',author:'jacob@example.com',participants:['jacob@example.com'],text:''}
 const item={id:'ea123',accountId:'demo',accountEmail:'steve@example.com',kind:'task',title:'Confirm delivery',summary:'Delivery needs confirmation.',topic:'Proposal',topicId:'topic123',contacts:['jacob@example.com'],owner:'jacob@example.com',due:'2026-10-09',status:'waiting',certainty:'explicit',snoozedUntil:null,revision:1,updatedAt:'2026-10-05T08:00:00Z',evidence:[{source,quote:'I will confirm delivery.'}]}
 const settings={enabled:true,hour:8,minute:0,days:90,accounts:[],importantContacts:[],importantTopics:[]}
 const coverage={scope:'indexed',from:'2026-07-07T08:00:00Z',discovered:10,reviewed:10,pending:0,failed:0,ingestionAt:'2026-10-05T08:00:00Z',mailSyncAt:'2026-10-05T08:00:00Z',mailState:'ready',caughtUp:true,complete:true}
 const edition={id:'edition1',date:'2026-10-05',revision:1,preparedAt:'2026-10-05T08:00:00Z',cutoff:'2026-10-05T08:00:00Z',timezone:'Pacific/Fiji',items:[structuredClone(item)],coverage,selection:{total:1,included:1},content:{lead:[{text:'Delivery confirmation needs attention before Friday.',itemIds:[item.id]}],entries:[{itemId:item.id,section:'waiting',text:'Jacob owes the delivery confirmation.'}]}}
 await page.route('http://127.0.0.1:8413/**',async route=>{
  const url=new URL(route.request().url());if(url.pathname.includes('/items/'))return route.fulfill({json:{item,history:[]}})
  if(url.pathname==='/v1/work/briefing')return route.fulfill({json:{edition,editions:[{id:edition.id,date:edition.date,revision:1,preparedAt:edition.preparedAt}],since:item.status==='done'?[item]:[],coverage,status:{running:false,error:null}}})
  return route.fulfill({json:{items:item.status==='done'?[]:[item],decisions:[],updates:[],people:item.contacts,topics:[{id:item.topicId,name:item.topic,accountId:'demo'}],accounts:[{id:'demo',email:'steve@example.com'}],transcripts:[],settings,coverage,scan:{enabled:true,running:false,lastScan:edition.preparedAt,error:null,failures:0,scanned:10,total:10,depth:30}}})
 })
 await page.goto('/');await page.locator('.dispatch-rail [data-work-nav="ea"]').click()
 await expect(page.getByRole('heading',{name:'Your morning briefing'})).toBeVisible();await expect(page.getByRole('heading',{name:'At a glance'})).toBeVisible();await expect(page.getByText('Delivery confirmation needs attention before Friday.',{exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Since your briefing'})).toBeVisible()
 item.status='done';item.revision++;item.updatedAt='2026-10-05T10:00:00Z';await expect(page.getByText('Completed since this edition.',{exact:true})).toBeVisible({timeout:7000});await expect(page.getByText('Jacob owes the delivery confirmation.',{exact:true})).toBeVisible()
 await page.getByRole('combobox',{name:'Briefing edition'}).selectOption('edition1');await expect(page.getByText('Delivery confirmation needs attention before Friday.',{exact:true})).toBeVisible();await page.locator('.briefing-entry').first().click();await expect(page.getByRole('button',{name:'Reopen',exact:true})).toBeVisible();await page.getByRole('button',{name:'Back to briefing'}).click();await expect(page.getByRole('heading',{name:'At a glance'})).toBeVisible();await page.screenshot({path:resolve('test-results','ea-newspaper.png'),fullPage:true})
})

test('imports call transcripts, retains inputs on failure, and opens timestamped evidence',async({page})=>{
 await stubAgent(page)
 const source={id:'cue',kind:'transcript',accountId:'demo',threadId:'meeting:weekly',messageId:'',importId:'weekly',title:'Weekly proposal call',at:'2026-10-05T08:00:00Z',author:'jacob@example.com',participants:['jacob@example.com'],text:'I will send the scope.',startSeconds:90}
 const item={id:'call123',accountId:'demo',kind:'task',title:'Send the scope',summary:'Jacob will send the scope.',topic:'Proposal',topicId:'topic123',contacts:['jacob@example.com'],owner:'jacob@example.com',due:null,status:'waiting',certainty:'explicit',snoozedUntil:null,revision:1,updatedAt:source.at,evidence:[{source,quote:source.text}]}
 const settings={enabled:true,hour:8,minute:0,days:90,accounts:[],importantContacts:[],importantTopics:[]},coverage={scope:'indexed',from:'2026-07-07T08:00:00Z',discovered:1,reviewed:1,pending:0,failed:0,ingestionAt:source.at,mailSyncAt:source.at,mailState:'ready',caughtUp:true,complete:true};const imports:Record<string,unknown>[]=[];let failed=true
 await page.route('http://127.0.0.1:8413/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/v1/work/transcripts'){imports.push(route.request().postDataJSON());if(failed){failed=false;return route.fulfill({status:503,json:{error:'temporarily_unavailable',detail:'Transcript import temporarily unavailable.'}})}return route.fulfill({status:202,json:{importId:'weekly'}})}if(url.pathname==='/v1/work/transcript')return route.fulfill({json:{input:{title:source.title,at:source.at},sources:[source]}});if(url.pathname.includes('/items/'))return route.fulfill({json:{item,history:[]}});return route.fulfill({json:{items:[item],decisions:[],updates:[],people:item.contacts,topics:[{id:item.topicId,name:item.topic,accountId:'demo'}],accounts:[{id:'demo',email:'steve@example.com'}],transcripts:[],settings,coverage,scan:{enabled:true,running:false,lastScan:source.at,error:null,failures:0,scanned:1,total:1,depth:30}}})})
 await page.goto('/');await page.locator('.dispatch-rail [data-work-nav="todos"]').click();await page.getByText('Import call transcript',{exact:true}).click();const form=page.locator('[data-work-import]');await form.locator('input[name=file]').setInputFiles({name:'weekly.vtt',mimeType:'text/vtt',buffer:Buffer.from('WEBVTT\n\n00:01:30.000 --> 00:01:35.000\n<v Jacob>I will send the scope.</v>')});await form.locator('input[name=at]').fill('2026-10-05T08:00');await form.locator('textarea[name=speakers]').fill('Jacob=jacob@example.com');await form.getByRole('button',{name:'Import transcript',exact:true}).click();await expect(page.getByRole('alert')).toContainText('temporarily unavailable');await expect(form.locator('input[name=title]')).toHaveValue('weekly');await form.getByRole('button',{name:'Import transcript',exact:true}).click();await expect.poll(()=>imports.length).toBe(2);expect(imports[1]).toMatchObject({format:'vtt',speakers:{Jacob:'jacob@example.com'},accountId:'demo'});await page.locator('[data-work=source]').click();await expect(page.getByRole('heading',{name:source.title})).toBeVisible();await expect(page.locator('[data-selected-transcript]')).toContainText('01:30');await page.waitForTimeout(5500);await expect(page.getByRole('heading',{name:source.title})).toBeVisible();await page.getByRole('button',{name:'Return to work'}).click();await expect(page.getByRole('heading',{name:item.title,exact:true})).toBeVisible()
})
