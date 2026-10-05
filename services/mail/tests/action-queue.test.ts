import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { GmailIndex, type IndexedGmailMessage } from '../src/gmail-index.js'
import { GmailConnectorProvider } from '../src/gmail-provider.js'
import { LocalMailStore } from '../src/local-mail-store.js'

it('indexes draft-list metadata without fetching a rotating MIME message id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-draft-metadata-'))
  const path = join(dir, 'index.sqlite')
  const index = new GmailIndex(path)
  index.replaceAccount('one', [{ id: 'old', threadId: 'thread', accountId: 'one', accountLabel: 'Test', sender: { name: 'Test', address: 'test@example.com', initials: 'T' }, subject: 'Old draft', receivedAt: '2026-09-11T00:00:00Z', receivedLabel: 'Today', receivedFullLabel: 'Today', preview: '', unread: false, inInbox: false, inArchive: false, inSent: false, inDrafts: true, inSpam: false, inTrash: false }], 'seed', true)
  index.close()
  let reads = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    if (req.url === '/v1/connectors/gmail/drafts/list') { res.end(JSON.stringify({ structuredContent: { drafts: [{ draft_id: 'draft', message_id: 'new-message', thread_id: 'thread', from_: 'test@example.com', to: ['test@example.com'], subject: 'Current draft', labels: ['DRAFT'], email_ts: '2026-09-11T01:00:00Z', has_attachment: true }] } })); return }
    reads++; res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: path })
  try {
    await provider.refreshDrafts(undefined, true)
    expect(await provider.listMailboxConversations('drafts', 'all')).toMatchObject([{ latestMessageId: 'new-message', subject: 'Current draft', hasAttachment: true }])
    expect(reads).toBe(0)
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) }
})

it('honors a Gmail Retry-After deadline across app restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-rate-limit-'))
  let calls = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    calls++
    res.statusCode = 429
    res.end(JSON.stringify({ error: `RATE_LIMITED Retry after ${new Date(Date.now() + 900_000).toISOString()}` }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const open = () => new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, localPath: join(dir, 'local.sqlite') })
  let provider = open()
  try {
    await expect(provider.createGmailDraft('one', '', 'test@example.com', '', '', 'Test', 'Body')).rejects.toThrow()
    provider.stopBackgroundSync(); provider = open()
    await expect(provider.createGmailDraft('one', '', 'test@example.com', '', '', 'Test', 'Body', [], 'fresh-key')).rejects.toThrow('Retry after')
    expect(calls).toBe(1)
    const disk = new LocalMailStore(join(dir, 'local.sqlite'))
    expect(disk.draftCreate('one', 'fresh-key')).toBeUndefined()
    disk.close()
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) }
})

it('reads a Gmail rate limit only from a failed call, never from message text', async () => {
  let searches = 0
  let limited = false
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    searches++
    if (limited) { res.end(JSON.stringify({ isError: true, structuredContent: { error: 'GmailApiError: Failed to search emails', error_code: 'RATE_LIMITED', error_data: { reason: 'rateLimitExceeded' } } })); return }
    // An alert email quoting a rate limit, like a Google Cloud quota notice.
    res.end(JSON.stringify({ structuredContent: { emails: [{ id: 'alert', thread_id: 'alert', from_: 'alerts@example.com', subject: 'Quota alert: rateLimitExceeded (RATE_LIMITED)', snippet: 'HTTP status: 429. Retry after 2099-01-01T00:00:00.000Z', labels: ['INBOX'], email_ts: '2026-09-12T00:00:00Z' }], next_page_token: '' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: ':memory:' })
  try {
    await provider.refreshNow()
    expect(provider.syncStatus()?.state).toBe('ready')
    expect(searches).toBe(7)
    limited = true
    await expect(provider.refreshNow({ details: true })).rejects.toMatchObject({ message: expect.stringMatching(/^test@example\.com: Error: Gmail is rate limiting this account\. Retry after \S+Z: .*RATE_LIMITED/) })
    expect(searches).toBe(8)
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('reads a rate limit from error fields only, whatever their spelling, and survives a bad date', async () => {
  let reply: { status: number; body: unknown } = { status: 200, body: {} }
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    res.statusCode = reply.status; res.end(JSON.stringify(reply.body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const open = () => new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
  const alert = { id: 'alert', thread_id: 'alert', from_: 'alerts@example.com', subject: 'rateLimitExceeded RESOURCE_EXHAUSTED', snippet: 'Retry after 2099-01-01T00:00:00.000Z', labels: ['INBOX'], email_ts: '2026-09-12T00:00:00Z' }
  try {
    // A successful page that carries an empty error field is still a successful page.
    reply = { status: 200, body: { structuredContent: { emails: [alert], error: null } } }
    let p = open()
    await expect(p.listMessages('one')).resolves.toHaveLength(1)
    await expect(p.listMessages('one')).resolves.toHaveLength(1)
    p.stopBackgroundSync()
    for (const error_data of [{ reason: 'userRateLimitExceeded' }, { status: 'RESOURCE_EXHAUSTED' }, { message: 'User-rate limit exceeded. Retry after 2026-13-45T99:99:99Z', reason: 'rateLimitExceeded' }]) {
      reply = { status: 200, body: { isError: true, structuredContent: { error: 'GmailApiError: Failed to search emails', error_data } } }
      p = open()
      const started = Date.now()
      await expect(p.listMessages('one')).rejects.toMatchObject({ code: 'gmail_backoff' })
      const until = Date.parse(/Retry after (\S+?Z)/.exec(String(await p.listMessages('one').catch(error => error)))![1]!)
      expect(until - started).toBeGreaterThanOrEqual(59_000)
      expect(until - started).toBeLessThan(120_000)
      p.stopBackgroundSync()
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('pauses the account when Gmail rate limits individual messages in a label change', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-batch-limit-'))
  let modifies = 0
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    if (req.url === '/v1/connectors/gmail/modify') { modifies++; res.end(JSON.stringify({ structuredContent: { responses: input.messageIds.map((id: string) => ({ message_id: id, success: false, error: 'RATE_LIMITED: Retry after 2099-01-01T00:00:00.000Z' })) } })); return }
    res.end(JSON.stringify({ structuredContent: { emails: [{ id: 'm1', thread_id: 't1', from_: 'a@example.com', subject: 'Hi', snippet: '', labels: ['INBOX', 'UNREAD'], email_ts: '2026-09-12T00:00:00Z' }], next_page_token: '' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: join(directory, 'gmail.sqlite') })
  try {
    await provider.refreshNow()
    await provider.setConversationUnread('one', 't1', false, ['m1'])
    await provider.flushActions()
    expect(provider.syncStatus()).toMatchObject({ state: 'partial', error: 'Waiting for Gmail to sync mail changes' })
    await provider.flushActions(); await provider.flushActions()
    expect(modifies).toBe(1)
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }) }
})

it('waits longer each time Gmail keeps rate limiting an account, and starts over after a success', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  let limited = true
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    res.end(JSON.stringify(limited
      ? { isError: true, structuredContent: { error: 'GmailApiError: Failed to search emails', error_code: 'RATE_LIMITED', error_data: { reason: 'rateLimitExceeded' } } }
      : { structuredContent: { emails: [], next_page_token: '' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const p = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
  const pause = async () => {
    const started = Date.now()
    await expect(p.listMessages('one')).rejects.toMatchObject({ code: 'gmail_backoff' })
    const until = Date.parse(/Retry after (\S+?Z)/.exec(String(await p.listMessages('one').catch(error => error)))![1]!)
    vi.setSystemTime(until + 1)
    return Math.round((until - started) / 60_000)
  }
  try {
    expect([await pause(), await pause(), await pause(), await pause()]).toEqual([1, 2, 4, 8])
    for (let i = 0; i < 4; i += 1) await pause()
    expect(await pause()).toBe(30)
    limited = false
    await expect(p.listMessages('one')).resolves.toEqual([])
    limited = true
    expect(await pause()).toBe(1)
  } finally { vi.useRealTimers(); p.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('keeps doubling the wait when Gmail rate limits label changes message by message', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-batch-backoff-'))
  let modifies = 0
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    if (req.url === '/v1/connectors/gmail/modify') { modifies++; res.end(JSON.stringify({ structuredContent: { responses: input.messageIds.map((id: string) => ({ message_id: id, success: false, error: 'RATE_LIMITED' })) } })); return }
    res.end(JSON.stringify({ structuredContent: { emails: [{ id: 'm1', thread_id: 't1', from_: 'a@example.com', subject: 'Hi', snippet: '', labels: ['INBOX', 'UNREAD'], email_ts: '2026-09-12T00:00:00Z' }], next_page_token: '' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: join(directory, 'gmail.sqlite') })
  const waited: number[] = []
  try {
    await provider.refreshNow()
    await provider.setConversationUnread('one', 't1', false, ['m1'])
    for (let i = 0; i < 3; i += 1) {
      const before = modifies; const started = Date.now()
      await provider.flushActions()
      expect(modifies).toBe(before + 1)
      const until = Date.parse(/Retry after (\S+?Z)/.exec(String(await provider.readMessage('one', 'm1').catch(error => error)))![1]!)
      waited.push(Math.round((until - started) / 60_000))
      vi.setSystemTime(until + 1)
    }
    expect(waited).toEqual([1, 2, 4])
  } finally { vi.useRealTimers(); provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }) }
})

it('tells the web about drafts only when Gmail\'s drafts list changed', async () => {
  let drafts = [{ draft_id: 'd1', message_id: 'm1', thread_id: 't1', from_: 'test@example.com', subject: 'One', labels: ['DRAFT'], email_ts: '2026-09-11T01:00:00Z' }]
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    if (req.url === '/v1/connectors/gmail/drafts/list') { res.end(JSON.stringify({ structuredContent: { drafts } })); return }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: ':memory:' })
  try {
    await provider.refreshDrafts(undefined, true)
    const first = provider.syncStatus()?.draftsRevision
    await provider.refreshDrafts(undefined, true)
    expect(provider.syncStatus()?.draftsRevision).toBe(first)
    drafts = [...drafts, { ...drafts[0]!, draft_id: 'd2', message_id: 'm2', subject: 'Two' }]
    await provider.refreshDrafts(undefined, true)
    expect(provider.syncStatus()?.draftsRevision).toBeGreaterThan(first!)
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('accepts folder changes during a provider failure and replays them in order after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-queue-'))
  const path = join(directory, 'gmail.sqlite')
  const index = new GmailIndex(path)
  index.replaceAccount('one', [{ id: 'm', threadId: 't', accountId: 'one', accountLabel: 'Test', sender: { name: 'Test', address: 'test@example.com', initials: 'T' }, subject: 'Synthetic', receivedAt: '2026-09-11T00:00:00Z', receivedLabel: 'Today', receivedFullLabel: 'Today', preview: '', unread: true, inInbox: true, inArchive: false, inSent: false, inDrafts: false, inSpam: false, inTrash: false } satisfies IndexedGmailMessage], 'seed', true)
  index.close()
  let failing = true
  const accepted: unknown[] = []
  const server = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/modify')) {
      if (failing) { res.statusCode = 503; res.end(JSON.stringify({ error: 'temporarily unavailable' })); return }
      accepted.push(JSON.parse(input)); res.end(JSON.stringify({ structuredContent: { success: true } })); return
    }
    res.end(JSON.stringify({ accounts: [] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let provider = new GmailConnectorProvider(base, { indexPath: path })
  try {
    await provider.mutateConversation('one', 't', ['m'], 'archive')
    await provider.flushActions()
    await provider.setConversationUnread('one', 't', false)
    await provider.flushActions()
    await provider.mutateConversation('one', 't', ['m'], 'trash')
    await provider.flushActions()
    expect(provider.syncStatus()?.error).toContain('Waiting for Gmail')
    provider.stopBackgroundSync()
    const disk = new GmailIndex(path)
    expect(disk.pendingActions().map(job => job.action)).toEqual(['archive', 'read', 'trash'])
    expect(disk.conversations('all')).toEqual([])
    disk.close()
    failing = false
    provider = new GmailConnectorProvider(base, { indexPath: path })
    await provider.flushActions()
    expect(accepted).toMatchObject([{ removeLabels: ['INBOX'], addLabels: [] }, { removeLabels: ['UNREAD'], addLabels: [] }, { removeLabels: ['INBOX', 'SPAM'], addLabels: ['TRASH'] }])
    provider.stopBackgroundSync()
    const final = new GmailIndex(path)
    expect(final.pendingActions()).toEqual([])
    expect(final.mailboxConversations('trash', 'all')).toHaveLength(1)
    expect(final.mailboxConversations('trash', 'unread')).toHaveLength(0)
    final.close()
  } finally {
    provider.stopBackgroundSync()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

it('keeps same-account action order while another account progresses and drain pauses later claims', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-action-workers-'))
  const path = join(directory, 'gmail.sqlite')
  const index = new GmailIndex(path)
  const message = (accountId: string, id: string, threadId: string): IndexedGmailMessage => ({
    id, threadId, accountId, accountLabel: accountId,
    sender: { name: accountId, address: `${accountId}@example.com`, initials: accountId[0]! },
    subject: 'Synthetic', receivedAt: '2026-09-11T00:00:00Z', receivedLabel: 'Today', receivedFullLabel: 'Today',
    preview: '', unread: false, inInbox: true, inArchive: false, inSent: false, inDrafts: false, inSpam: false, inTrash: false,
  })
  index.replaceAccount('A', [message('A', 'mA', 'tA')], 'seed-A', true)
  index.replaceAccount('B', [message('B', 'mB', 'tB')], 'seed-B', true)
  index.close()

  let releaseA!: () => void
  let firstAStarted!: () => void
  let bStarted!: () => void
  const gateA = new Promise<void>(resolve => { releaseA = resolve })
  const firstA = new Promise<void>(resolve => { firstAStarted = resolve })
  const bRequest = new Promise<void>(resolve => { bStarted = resolve })
  const calls: Array<{ account: string; addLabels: string[]; removeLabels: string[] }> = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail/modify') {
      const call = { account: input.linkId as string, addLabels: input.addLabels as string[], removeLabels: input.removeLabels as string[] }
      calls.push(call)
      if (call.account === 'A' && calls.filter(item => item.account === 'A').length === 1) { firstAStarted(); await gateA }
      if (call.account === 'B') bStarted()
      res.end(JSON.stringify({ structuredContent: { success: true } })); return
    }
    res.end(JSON.stringify({ accounts: [] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: path })
  try {
    await provider.mutateConversation('A', 'tA', ['mA'], 'archive')
    await firstA
    await provider.mutateConversation('A', 'tA', ['mA'], 'trash')
    await provider.mutateConversation('B', 'tB', ['mB'], 'archive')
    await bRequest
    await vi.waitFor(() => expect(provider.runtimeStatus().activeOperations).toBe(1))
    expect(calls.map(call => call.account)).toEqual(['A', 'B'])

    // The runtime drain can now wait on exactly the outstanding provider claim. A's later
    // action remains durable and cannot start until the runtime resumes.
    provider.setRuntimeDraining(true)
    expect(provider.runtimeStatus().activeOperations).toBe(1)
    releaseA()
    await vi.waitFor(() => expect(provider.runtimeStatus().activeOperations).toBe(0))
    expect(calls.map(call => call.account)).toEqual(['A', 'B'])

    provider.setRuntimeDraining(false)
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls.map(call => [call.account, call.addLabels, call.removeLabels])).toEqual([
      ['A', [], ['INBOX']],
      ['B', [], ['INBOX']],
      ['A', ['TRASH'], ['INBOX', 'SPAM']],
    ])
    expect(provider.runtimeStatus().activeOperations).toBe(0)
  } finally {
    releaseA()
    provider.stopBackgroundSync()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

it('deletes every indexed message in a Spam thread even when the reader supplies an older subset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-spam-trash-'))
  const path = join(dir, 'index.sqlite')
  const seed = new GmailIndex(path)
  const original: IndexedGmailMessage = { id: 'old', threadId: 'thread', accountId: 'one', accountLabel: 'Test', sender: { name: 'Test', address: 'test@example.com', initials: 'T' }, subject: 'Disposable Spam', receivedAt: '2026-10-05T01:00:00Z', receivedLabel: 'Today', receivedFullLabel: 'Today', preview: '', unread: true, inInbox: false, inArchive: false, inSent: false, inDrafts: false, inSpam: true, inTrash: false }
  seed.replaceAccount('one', [original, { ...original, id: 'new' }], 'seed', true); seed.close()
  let command: Record<string, unknown> | undefined
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    command = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    res.setHeader('content-type', 'application/json'); res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: path, localPath: ':memory:' })
  try {
    await provider.mutateConversation('one', 'thread', ['old'], 'trash')
    expect(await provider.listMailboxConversations('spam', 'all')).toEqual([])
    expect((await provider.mailboxCounts()).spam).toBe(0)
    await provider.flushActions()
    expect(command).toEqual({ linkId: 'one', messageIds: ['old', 'new'], addLabels: ['TRASH'], removeLabels: ['INBOX', 'SPAM'] })
    expect(await provider.listMailboxConversations('trash', 'all')).toHaveLength(1)
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) }
})
