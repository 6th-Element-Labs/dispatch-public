import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectDraft } from '../src/draft.js'
import { createMailServer } from '../src/server.js'

const servers: ReturnType<typeof createMailServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function start(options: Parameters<typeof createMailServer>[1] = {}, providerOverrides: Partial<NonNullable<Parameters<typeof createMailServer>[0]>> = {}) {
  const server = createMailServer({
    accounts: async () => [],
    listMessages: async () => [],
    listUnifiedMessages: async () => [],
    readMessage: async () => { throw new Error('not configured') },
    listConversations: async () => [],
    listUnifiedConversations: async () => [],
    readConversation: async () => { throw new Error('not configured') },
    ...providerOverrides,
  }, { demoEnabled: true, ...options })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${port}`
}

describe('dispatch-mail', () => {
  it('exposes direct sync connection status and rejects sign-in commands from foreign origins', async () => {
    const connect = vi.fn(async () => ({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' }))
    const base = await start({}, {
      directSyncStatus: async () => ({ configured: true, accounts: [{ accountId: 'one', email: 'work@example.com', state: 'connector' }] }),
      connectDirectSync: connect,
    })
    expect(await (await fetch(`${base}/v1/gmail-sync`)).json()).toMatchObject({ directSync: { configured: true } })
    const foreign = await fetch(`${base}/v1/gmail-sync`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'one' }) })
    expect(foreign.status).toBe(403); expect(connect).not.toHaveBeenCalled()
    expect((await fetch(`${base}/v1/gmail-sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
    const result = await fetch(`${base}/v1/gmail-sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'one' }) })
    expect(result.status).toBe(200); expect(connect).toHaveBeenCalledWith('one')
  })
  it('suggests demo recipients from known senders', async () => {
    const base = await start()
    const value = await (await fetch(`${base}/v1/recipients?q=ana`)).json() as { recipients: Array<{ address: string }> }
    expect(value.recipients).toEqual([expect.objectContaining({ address: 'ana@opuamarina.example' })])
  })

  it('exposes health, readiness, and explicit demo projections', async () => {
    const base = await start()
    expect((await fetch(`${base}/health`)).status).toBe(200)
    const ready = await (await fetch(`${base}/ready`)).json()
    expect(ready).toMatchObject({ status: 'ready', provider: 'demo' })
    const list = await (await fetch(`${base}/v1/messages`)).json()
    expect(list.source).toBe('demo')
    expect(list.messages).toHaveLength(3)
  })

  it('creates a draft owned by the mail service', async () => {
    const base = await start()
    const response = await fetch(`${base}/v1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'demo-message-opua' }),
    })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.draft).toMatchObject({ state: 'draft', inReplyToMessageId: 'demo-message-opua' })
  })

  it('keeps client bodyMarkdown on demo draft create', async () => {
    const base = await start()
    const quote = '\n\n> Please confirm.'
    const response = await fetch(`${base}/v1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'demo-message-opua', bodyMarkdown: quote }),
    })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.draft.bodyMarkdown).toContain('> Please confirm.')
  })

  it('renders draft Markdown through mail', async () => {
    const base = await start()
    const response = await fetch(`${base}/v1/drafts/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bodyMarkdown: '**Hi**' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ bodyHtml: expect.stringContaining('<strong>Hi</strong>') })
  })

  it('opens local draft attachment bytes with the default file handler', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'dispatch-draft-open-'))
    let openedPath = ''
    const base = await start({ attachmentCacheDir: cacheDir, openPath: async (path) => { openedPath = path } })
    const response = await fetch(`${base}/v1/drafts/attachments/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'notes.txt', contentBase64: 'aGVsbG8=' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ opened: true, filename: 'notes.txt' })
    expect(await readFile(openedPath, 'utf8')).toBe('hello')
    const empty = await fetch(`${base}/v1/drafts/attachments/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'empty.bin', contentBase64: '' }),
    })
    expect(empty.status).toBe(200)
    expect(await readFile(openedPath)).toHaveLength(0)
    const malformedAccount = await fetch(`${base}/v1/drafts/attachments/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'empty.bin', contentBase64: '', accountId: 42 }),
    })
    expect(malformedAccount.status).toBe(400)
    const invalid = await fetch(`${base}/v1/drafts/attachments/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'notes.txt', contentBase64: 'not base64!' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('discards a demo draft', async () => {
    const base = await start()
    const created = await (await fetch(`${base}/v1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'demo-message-opua' }),
    })).json()
    const discarded = await fetch(`${base}/v1/drafts/${created.draft.id}?action=discard`, { method: 'POST' })
    expect(discarded.status).toBe(200)
  })

  it('reads an owned demo draft', async () => {
    const base = await start()
    const created = await (await fetch(`${base}/v1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'demo-message-opua' }),
    })).json()
    const response = await fetch(`${base}/v1/drafts/${created.draft.id}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ draft: created.draft })
  })

  it('opens, reads, and discards a Gmail draft through mail', async () => {
    const calls: unknown[] = []
    const draft = projectDraft({ id: 'draft-1', inReplyToMessageId: 'message-1', to: [], subject: 'Re: Hello', bodyMarkdown: 'Hello', accountId: 'one' })
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      openGmailDraft: async (accountId, messageId) => { calls.push({ open: { accountId, messageId } }); return draft },
      readGmailDraft: async (accountId, draftId) => { calls.push({ read: { accountId, draftId } }); return draft },
      discardGmailDraft: async (accountId, draftId) => { calls.push({ discard: { accountId, draftId } }) },
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const opened = await fetch(`${base}/v1/drafts/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'one', messageId: 'message-1' }),
    })
    expect(opened.status).toBe(201)
    await expect(opened.json()).resolves.toEqual({ draft })
    expect((await fetch(`${base}/v1/drafts/draft-1?account=one`)).status).toBe(200)
    expect((await fetch(`${base}/v1/drafts/draft-1?action=discard&account=one`, { method: 'POST' })).status).toBe(200)
    expect(calls).toEqual([
      { open: { accountId: 'one', messageId: 'message-1' } },
      { read: { accountId: 'one', draftId: 'draft-1' } },
      { discard: { accountId: 'one', draftId: 'draft-1' } },
    ])
  })

  it('returns typed Gmail draft connector failures', async () => {
    const htmlError = Object.assign(new Error('HTML draft failed'), { code: 'gmail_html_unsupported' })
    const discardError = Object.assign(new Error('Delete draft unavailable'), { code: 'gmail_draft_discard_unavailable' })
    const notFoundError = Object.assign(new Error('Gmail draft not found'), { code: 'gmail_draft_not_found' })
    const unavailableError = Object.assign(new Error('Gmail draft list unavailable'), { code: 'gmail_draft_open_unavailable' })
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      createGmailDraft: async () => { throw htmlError },
      openGmailDraft: async () => { throw notFoundError },
      readGmailDraft: async () => { throw unavailableError },
      discardGmailDraft: async () => { throw discardError },
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const create = await fetch(`${base}/v1/drafts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'one', bodyMarkdown: 'Hi' }),
    })
    expect(create.status).toBe(502)
    await expect(create.json()).resolves.toEqual({ error: 'gmail_html_unsupported', detail: 'HTML draft failed' })
    const open = await fetch(`${base}/v1/drafts/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'one', messageId: 'missing-message' }),
    })
    expect(open.status).toBe(404)
    await expect(open.json()).resolves.toEqual({ error: 'gmail_draft_not_found', detail: 'Gmail draft not found' })
    const read = await fetch(`${base}/v1/drafts/draft-1?account=one`)
    expect(read.status).toBe(503)
    await expect(read.json()).resolves.toEqual({ error: 'gmail_draft_open_unavailable', detail: 'Gmail draft list unavailable' })
    const discard = await fetch(`${base}/v1/drafts/draft-1?action=discard&account=one`, { method: 'POST' })
    expect(discard.status).toBe(502)
    await expect(discard.json()).resolves.toEqual({ error: 'gmail_draft_discard_unavailable', detail: 'Delete draft unavailable' })
  })

  it('passes bodyMarkdown to Gmail draft create', async () => {
    let bodyArg = ''
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      createGmailDraft: async (_accountId, _messageId, _to, _cc, _bcc, _subject, bodyText) => {
        bodyArg = bodyText
        return projectDraft({ id: 'draft-1', inReplyToMessageId: '', to: [], subject: '', bodyMarkdown: bodyText, accountId: 'one' })
      },
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(`${base}/v1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'one', bodyMarkdown: '**Hi**' }),
    })
    expect(response.status).toBe(201)
    expect(bodyArg).toBe('**Hi**')
    const body = await response.json()
    expect(body.draft).toMatchObject({ bodyMarkdown: '**Hi**', bodyText: '**Hi**' })
  })

  it('persists Gmail draft attachments through the mail owner', async () => {
    const calls: unknown[] = []
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      createGmailDraft: async (accountId, messageId, to, cc, bcc, subject, bodyMarkdown, attachments) => {
        calls.push({ accountId, attachments })
        return projectDraft({ id: 'draft-1', inReplyToMessageId: messageId, to: [], subject, bodyMarkdown, attachments, accountId })
      },
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(`${base}/v1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'one',
        bodyMarkdown: 'Hi',
        attachments: [{ name: 'arrival.pdf', mediaType: 'application/pdf', contentBase64: 'cGRm' }],
      }),
    })
    expect(response.status).toBe(201)
    expect(calls).toEqual([{
      accountId: 'one',
      attachments: [{ name: 'arrival.pdf', mediaType: 'application/pdf', contentBase64: 'cGRm' }],
    }])
  })

  it('rejects non-object JSON on new draft routes', async () => {
    const base = await start()
    for (const path of ['/v1/drafts', '/v1/drafts/preview', '/v1/drafts/open']) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      })
      expect(response.status, path).toBe(400)
      await expect(response.json(), path).resolves.toEqual({ error: 'invalid_json' })
    }
  })

  it('exposes threaded conversations with read-state filters', async () => {
    const base = await start()
    const unread = await (await fetch(`${base}/v1/conversations?state=unread`)).json()
    expect(unread.conversations).toHaveLength(2)
    const read = await (await fetch(`${base}/v1/conversations?state=read`)).json()
    expect(read.conversations).toHaveLength(1)
    const thread = await (await fetch(`${base}/v1/conversations/demo-thread-opua`)).json()
    expect(thread.conversation).toMatchObject({ threadId: 'demo-thread-opua', messageCount: 1 })
  })

  it('paginates indexed conversation responses with an explicit total', async () => {
    const base = await start()
    const first = await (await fetch(`${base}/v1/conversations?state=all&limit=1`)).json()
    expect(first).toMatchObject({ total: 3, nextCursor: '1' })
    expect(first.conversations).toHaveLength(1)
    const second = await (await fetch(`${base}/v1/conversations?state=all&limit=1&cursor=1`)).json()
    expect(second).toMatchObject({ total: 3, nextCursor: '2' })
    expect(second.conversations).toHaveLength(1)
  })

  it('uses the Gmail provider as one unified inbox when accounts are available', async () => {
    const listUnifiedMessages = async () => [{
      id: 'm1', threadId: 't1', sender: { name: 'Ana', address: 'ana@example.com', initials: 'A' },
      subject: 'Hello', receivedAt: '2026-09-04T09:42:00Z', receivedLabel: 'Sep 4, 9:42 AM',
      receivedFullLabel: 'September 4, 2026 at 9:42 AM', preview: 'Hello', unread: true,
      accountId: 'one', accountLabel: 'one@example.com',
    }]
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [],
      listUnifiedMessages,
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [],
      listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const value = await (await fetch(`${base}/v1/messages`)).json()
    expect(value).toMatchObject({ source: 'gmail', scope: 'unified', messages: [{ accountId: 'one' }] })
  })

  it('routes mailbox reads and accepted Gmail actions through the mail owner', async () => {
    const calls: unknown[] = []
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      listMailboxConversations: async (mailbox, state, accountId, query) => { calls.push({ mailbox, state, accountId, query }); return [] },
      mutateConversation: async (accountId, threadId, messageIds, action) => { calls.push({ accountId, threadId, messageIds, action }) },
      readConversation: async () => { throw new Error('not configured') },
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const sent = await (await fetch(`${base}/v1/conversations?state=all&mailbox=sent&account=one&q=invoice`)).json()
    expect(sent).toMatchObject({ mailbox: 'sent', coverage: 'indexed' })
    expect((await fetch(`${base}/v1/conversations/t1/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'one', messageIds: ['m1'], action: 'archive' }) })).status).toBe(202)
    expect(calls).toEqual([
      { mailbox: 'sent', state: 'all', accountId: 'one', query: 'invoice' },
      { accountId: 'one', threadId: 't1', messageIds: ['m1'], action: 'archive' },
    ])
  })

  it('waits for an authoritative Gmail head refresh', async () => {
    let refreshed = false
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      refreshNow: async () => { refreshed = true },
      syncStatus: () => ({ state: 'ready', startedAt: '2026-09-05T09:10:00Z', completedAt: '2026-09-05T09:10:02Z', error: null, messageCount: 1 }),
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(`${base}/v1/sync`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(refreshed).toBe(true)
    await expect(response.json()).resolves.toMatchObject({ sync: { state: 'ready', messageCount: 1 } })
  })

  it('fails visibly instead of substituting demo mail when Gmail is disconnected', async () => {
    const server = createMailServer({
      accounts: async () => [],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
    }, { demoEnabled: false })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/ready`)).status).toBe(503)
    const response = await fetch(`${base}/v1/conversations?state=all`)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: 'gmail_not_connected' })
  })

  it('fails readiness on its deadline when the Gmail dependency stalls', async () => {
    const server = createMailServer({
      accounts: async () => new Promise(() => undefined),
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
    }, { demoEnabled: false, readinessTimeoutMs: 5 })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ready`)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: 'gmail_connection_failed', detail: expect.stringContaining('timed out after 5 ms') })
  })

  it('fails readiness when the durable Gmail synchronization failed', async () => {
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      syncStatus: () => ({ state: 'failed', startedAt: '2026-09-04T09:00:00Z', completedAt: null, error: 'page token repeated', messageCount: 100 }),
    }, { demoEnabled: false })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ready`)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: 'gmail_sync_failed', detail: 'page token repeated' })
  })
  it('allows the browser origin by default and honors DISPATCH_ALLOWED_ORIGIN', async () => {
    const base = await start()
    expect((await fetch(`${base}/health`)).headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8410')
    vi.stubEnv('DISPATCH_ALLOWED_ORIGIN', 'tauri://localhost')
    vi.resetModules()
    try {
      const { createMailServer: fresh } = await import('../src/server.js')
      const server = fresh({
        accounts: async () => [],
        listMessages: async () => [],
        listUnifiedMessages: async () => [],
        readMessage: async () => { throw new Error('not configured') },
        listConversations: async () => [],
        listUnifiedConversations: async () => [],
        readConversation: async () => { throw new Error('not configured') },
      }, { demoEnabled: true })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      expect((await fetch(`http://127.0.0.1:${port}/health`)).headers.get('access-control-allow-origin')).toBe('tauri://localhost')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('opens a Gmail attachment with the default native app', async () => {
    const opened: string[] = []
    const cache = await mkdtemp(join(tmpdir(), 'dispatch-mail-open-'))
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      readAttachment: async (accountId, messageId, attachmentId, filename) => {
        expect({ accountId, messageId, attachmentId, filename }).toEqual({
          accountId: 'one',
          messageId: 'msg/1',
          attachmentId: 'att/9',
          filename: 'arrival.pdf',
        })
        return { data: Buffer.from('%PDF-1.1 gmail').toString('base64') }
      },
    }, {
      demoEnabled: false,
      attachmentCacheDir: cache,
      openPath: async (path) => { opened.push(path) },
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(`${base}/v1/messages/msg%2F1/attachments/att%2F9/open?account=one&filename=${encodeURIComponent('arrival.pdf')}`, {
      method: 'POST',
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { opened: boolean; filename: string; path: string }
    expect(body).toMatchObject({ opened: true, filename: 'arrival.pdf' })
    expect(opened).toEqual([body.path])
    await expect(readFile(body.path, 'utf8')).resolves.toBe('%PDF-1.1 gmail')
  })

  it('caches an attachment ahead of time and streams the bytes to the browser', async () => {
    let reads = 0
    const cache = await mkdtemp(join(tmpdir(), 'dispatch-mail-cache-'))
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      readAttachment: async () => { reads += 1; return { structuredContent: { mime_type: 'image/png', data: Buffer.from('png-bytes').toString('base64') } } },
    }, { demoEnabled: false, attachmentCacheDir: cache, openPath: async () => { throw new Error('must not open') } })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const cached = await fetch(`${base}/v1/messages/m1/attachments/img-1/cache?account=one&filename=logo.png`, { method: 'POST' })
    expect(cached.status).toBe(200)
    await expect(cached.json()).resolves.toMatchObject({ cached: true, reused: false, filename: 'logo.png', mediaType: 'image/png' })
    const raw = await fetch(`${base}/v1/messages/m1/attachments/img-1?account=one&filename=logo.png`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('image/png')
    expect(raw.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8410')
    expect(Buffer.from(await raw.arrayBuffer()).toString()).toBe('png-bytes')
    const json = await fetch(`${base}/v1/messages/m1/attachments/img-1?account=one&filename=logo.png`, { headers: { accept: 'application/json' } })
    await expect(json.json()).resolves.toMatchObject({ attachment: { structuredContent: { mime_type: 'image/png' } } })
    expect(reads).toBe(2)
  })

  it('fails in the open when Gmail attachment bytes are missing', async () => {
    const server = createMailServer({
      accounts: async () => [{ id: 'one', connectorId: 'gmail', name: 'One', email: 'one@example.com' }],
      listMessages: async () => [], listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [], listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
      readAttachment: async () => ({}),
    }, { demoEnabled: false, openPath: async () => undefined })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages/m1/attachments/a1/open?account=one&filename=note.pdf`, {
      method: 'POST',
    })
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: 'gmail_attachment_open_failed' })
  })

  it('opens a demo attachment with the default native app', async () => {
    const opened: string[] = []
    const cache = await mkdtemp(join(tmpdir(), 'dispatch-demo-open-'))
    const server = createMailServer({
      accounts: async () => [],
      listMessages: async () => [],
      listUnifiedMessages: async () => [],
      readMessage: async () => { throw new Error('not configured') },
      listConversations: async () => [],
      listUnifiedConversations: async () => [],
      readConversation: async () => { throw new Error('not configured') },
    }, {
      demoEnabled: true,
      attachmentCacheDir: cache,
      openPath: async (path) => { opened.push(path) },
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(`${base}/v1/messages/demo-message-opua/attachments/demo-attachment-opua/open?filename=${encodeURIComponent('Opua arrival instructions.pdf')}`, {
      method: 'POST',
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { opened: boolean; filename: string; path: string }
    expect(body).toMatchObject({ opened: true, filename: 'Opua arrival instructions.pdf' })
    expect(opened).toEqual([body.path])
    const bytes = await readFile(body.path)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  })
})

it('serves offline account/list reads without Gmail and refuses attachment cache misses without downloading', async () => {
  const remote = vi.fn(async () => { throw new Error('No remote calls allowed') })
  const server = createMailServer({ accounts: remote, cachedAccounts: () => [], listMessages: remote, listUnifiedMessages: remote, readMessage: remote, listConversations: remote, listUnifiedConversations: remote, readConversation: remote, readAttachment: remote, downloadedConversations: () => [], recordExternalSend: () => { throw new Error('Invalid identity') } }, { attachmentCacheDir: await mkdtemp(join(tmpdir(), 'dispatch-offline-test-')) })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  expect((await fetch(`${base}/v1/accounts?offline=true`)).status).toBe(200)
  expect((await (await fetch(`${base}/v1/conversations?offline=true&state=all`)).json()).coverage).toBe('downloaded')
  expect((await fetch(`${base}/v1/messages/missing/attachments/missing?filename=none.txt&account=one&offline=true`)).status).toBe(404)
  expect(remote).not.toHaveBeenCalled()
  const invalid = await fetch(`${base}/v1/send-receipts`, { method: 'POST', body: JSON.stringify({ accountId: '', messageId: '' }) })
  expect(invalid.status).toBe(400)
  expect((await fetch(`${base}/health`)).status).toBe(200)
})

it('serves demo mailbox counts when no Gmail account is connected', async () => {
  const base = await start()
  const response = await fetch(`${base}/v1/mailboxes/counts`)
  expect(response.status).toBe(200)
  const body = await response.json() as { source: string; counts: { inbox: number; drafts: number; spam: number } }
  expect(body.source).toBe('demo')
  expect(body.counts.inbox).toBeGreaterThan(0)
  expect(body.counts).toMatchObject({ drafts: 0, spam: 0 })
})

it('acknowledges durable draft commands as pending and preserves omitted fields at the REST boundary', async () => {
  const enqueue = vi.fn(() => ({ ...projectDraft({ id: 'queued-one', accountId: 'one', inReplyToMessageId: '', to: [], subject: '', bodyMarkdown: '' }), syncState: 'pending' as const }))
  const server = createMailServer({ accounts: async () => [], listMessages: async () => [], listUnifiedMessages: async () => [], readMessage: async () => { throw new Error('not configured') }, listConversations: async () => [], listUnifiedConversations: async () => [], readConversation: async () => { throw new Error('not configured') }, enqueueDraftSave: enqueue })
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const response = await fetch(`${base}/v1/draft-saves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'one', draftId: 'existing', to: 'new@example.com' }) })
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({ draft: { id: 'queued-one', syncState: 'pending' } })
  expect(enqueue).toHaveBeenCalledExactlyOnceWith('one', '', { to: 'new@example.com' }, 'existing', undefined)
  for (const input of [{ accountId: 'one', bodyMarkdown: 1 }, { accountId: 'one' }, { accountId: 'one', attachments: [{}] }, { accountId: 'one', draftId: '', to: 'x' }]) {
    expect((await fetch(`${base}/v1/draft-saves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(400)
  }
  expect(enqueue).toHaveBeenCalledTimes(1)
})

it('accepts durable attachment operations and exposes conflict resolution and archived copies', async () => {
  const attachmentDraft = { ...projectDraft({ id: 'existing', accountId: 'one', inReplyToMessageId: '', to: [], subject: 'Saved', bodyMarkdown: '' }), syncState: 'pending' as const }
  const attachDraftFiles = vi.fn(async () => ({ draft: attachmentDraft, operationId: '123e4567-e89b-42d3-a456-426614174000', syncState: 'pending' as const, verifiedFiles: [] }))
  const resolveDraftConflict = vi.fn(async () => ({ ...projectDraft({ id: 'existing', accountId: 'one', inReplyToMessageId: '', to: [], subject: 'Saved', bodyMarkdown: '' }), draftRevision: 4 }))
  const conflictDraft = projectDraft({ id: 'existing', accountId: 'one', inReplyToMessageId: '', to: [], subject: 'Saved', bodyMarkdown: '' })
  const conflictCopies = vi.fn((accountId?: string) => [{ id: 'copy-1', accountId: accountId ?? 'one', draftId: 'existing', local: conflictDraft, remote: conflictDraft, choice: 'use-remote' as const, createdAt: '2026-09-30T00:00:00.000Z' }])
  const base = await start({}, { attachDraftFiles, resolveDraftConflict, conflictCopies })
  const attached = await fetch(`${base}/v1/drafts/existing/attachments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'one', operationId: '123e4567-e89b-42d3-a456-426614174000', paths: ['/tmp/file.txt'] }) })
  expect(attached.status).toBe(202)
  expect(attachDraftFiles).toHaveBeenCalledExactlyOnceWith('one', 'existing', ['/tmp/file.txt'], '123e4567-e89b-42d3-a456-426614174000')

  const resolved = await fetch(`${base}/v1/draft-saves/existing/conflict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'one', choice: 'use-remote', expectedRevision: 3 }) })
  expect(resolved.status).toBe(200)
  expect(await resolved.json()).toMatchObject({ draft: { id: 'existing', draftRevision: 4 } })
  expect(resolveDraftConflict).toHaveBeenCalledExactlyOnceWith('one', 'existing', 'use-remote', 3)

  const archived = await fetch(`${base}/v1/draft-conflicts?account=one`)
  expect(await archived.json()).toMatchObject({ conflicts: [{ id: 'copy-1', accountId: 'one', draftId: 'existing', choice: 'use-remote' }] })
  expect(conflictCopies).toHaveBeenCalledExactlyOnceWith('one')
})

it('maps the draft queue revision-change error to a conflict response', async () => {
  const resolveDraftConflict = async () => { throw Object.assign(new Error('Draft changed while resolving.'), { code: 'draft_revision_changed' }) }
  const base = await start({}, { resolveDraftConflict })
  const response = await fetch(`${base}/v1/draft-saves/existing/conflict`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'one', choice: 'keep-local', expectedRevision: 3 }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'draft_revision_changed' })
})

it('returns typed conflicts when an accepted attachment operation was cancelled or removed', async () => {
  const attachDraftFiles = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('append cancelled'), { code: 'draft_attachment_operation_cancelled' }))
    .mockRejectedValueOnce(Object.assign(new Error('append was removed'), { code: 'draft_attachment_not_present' }))
  const base = await start({}, { attachDraftFiles })
  const body = JSON.stringify({ accountId: 'one', operationId: '123e4567-e89b-42d3-a456-426614174000', paths: ['/tmp/file.txt'] })
  const cancelled = await fetch(`${base}/v1/drafts/queued-one/attachments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  expect(cancelled.status).toBe(409)
  expect(await cancelled.json()).toMatchObject({ error: 'draft_attachment_operation_cancelled' })
  const removed = await fetch(`${base}/v1/drafts/queued-two/attachments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  expect(removed.status).toBe(409)
  expect(await removed.json()).toMatchObject({ error: 'draft_attachment_not_present' })
})

it('reports whether a Gmail attachment is already cached without downloading it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-attachment-status-'))
  const readAttachment = vi.fn(async () => { throw new Error('status must be local only') })
  const base = await start({ attachmentCacheDir: directory }, { readAttachment })
  const status = await fetch(`${base}/v1/messages/message/attachments/attachment/status?account=one&filename=file.pdf`)
  expect(status.status).toBe(200)
  expect(await status.json()).toEqual({ cached: false })
  expect(readAttachment).not.toHaveBeenCalled()
})

it('exports bounded work evidence from the exact account and refuses incomplete threads',async()=>{
  const message={id:'m',threadId:'t',accountId:'a',sender:{name:'Jacob',address:'jacob@example.com',initials:'J'},subject:'Weekly',receivedAt:'2026-10-01T12:00:00Z',receivedLabel:'Oct 1',receivedFullLabel:'October 1',preview:'Proposal',unread:false,body:{kind:'sanitized-html' as const,content:'<p>I will send the proposal.</p>'},attachments:[],to:[{name:'Boss',address:'boss@example.com',initials:'B'}],source:'gmail' as const}
  let complete=true
  const base=await start({}, {accounts:async()=>[{id:'a',connectorId:'connector',name:'Gmail',email:'boss@example.com'}],readConversation:async()=>({...message,latestMessageId:'m',messageCount:1,messages:[message],completeness:{complete,knownCount:2,loadedCount:1}})})
  const response=await fetch(base+'/v1/work/sources?account=a&thread=t');expect(response.status).toBe(200);expect(await response.json()).toMatchObject({sources:[{kind:'email',accountId:'a',messageId:'m',text:'I will send the proposal.',accountEmail:'boss@example.com'}]})
  complete=false;expect((await fetch(base+'/v1/work/sources?account=a&thread=t')).status).toBe(409)
})

it('distinguishes unavailable work evidence from a transient mail read failure',async()=>{
  let unavailable=true
  const base=await start({}, {readWorkConversation:async()=>{throw Object.assign(new Error(unavailable?'No eligible evidence.':'Read timed out.'),unavailable?{code:'work_evidence_unavailable'}:{})}})
  expect((await fetch(base+'/v1/work/sources?account=a&thread=t')).status).toBe(410)
  unavailable=false
  expect((await fetch(base+'/v1/work/sources?account=a&thread=t')).status).toBe(502)
})

it('accepts an editor send snapshot immediately and exposes its background status without a provider send call', async () => {
  const draft = projectDraft({ id: 'queued-snapshot', accountId: 'one', inReplyToMessageId: 'm1', to: [], subject: 'Reply', bodyMarkdown: 'Current text' })
  const receipt = { id: 'attempt', accountId: 'one', accountLabel: 'work@example.com', draftId: draft.id, requestedAt: new Date().toISOString(), status: 'preparing' as const, detailsSource: 'unavailable' as const }
  const enqueue = vi.fn(() => ({ ...draft, draftRevision: 7 }))
  const begin = vi.fn(() => receipt)
  const send = vi.fn(async () => { throw new Error('HTTP acceptance must not wait for delivery') })
  const base = await start({}, { enqueueDraftSave: enqueue, beginGmailDraftSend: begin, sendGmailDraft: send, sendReceipt: id => id === receipt.id ? receipt : undefined })
  const submit = (fields: object) => fetch(`${base}/v1/draft-sends`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) })
  const accepted = await submit({ accountId: 'one', messageId: 'm1', to: 'recipient@example.com', bodyMarkdown: 'Current text' })
  expect(accepted.status).toBe(202)
  expect(await accepted.json()).toMatchObject({ receipt: { id: 'attempt', status: 'preparing' } })
  expect(begin).toHaveBeenCalledWith('one', draft.id, 7)
  expect(send).not.toHaveBeenCalled()
  expect(await (await fetch(`${base}/v1/draft-sends/attempt`)).json()).toMatchObject({ receipt: { id: 'attempt' } })
  expect((await submit({ accountId: 'one', to: '', bodyMarkdown: 'Do not send' })).status).toBe(400)
  expect(enqueue).toHaveBeenCalledTimes(1)
})

it('reads a sent draft outcome through the mail owner without sending or fetching Gmail', async () => {
  const receipt = { id: 'confirmed', accountId: 'one', accountLabel: 'test@example.com', draftId: 'gmail-remote', messageId: 'sent', status: 'verified' as const, requestedAt: new Date().toISOString(), detailsSource: 'sent-message' as const }
  const lookup = vi.fn((accountId: string, draftId?: string) => accountId === 'one' && draftId === 'queued-alias' ? receipt : undefined)
  const send = vi.fn(async () => { throw new Error('Status must never send') })
  const base = await start({}, { existingDraftSend: lookup, sendGmailDraft: send })
  expect(await (await fetch(base + '/v1/drafts/queued-alias/send-status?account=one')).json()).toMatchObject({ receipt: { messageId: 'sent', status: 'verified' } })
  expect(await (await fetch(base + '/v1/drafts/queued-alias/send-status?account=other')).json()).toEqual({ receipt: null })
  expect((await fetch(base + '/v1/drafts/queued-alias/send-status')).status).toBe(400)
  expect(lookup).toHaveBeenCalledWith('one', 'queued-alias')
  expect(send).not.toHaveBeenCalled()
})
it('validates complete recovery snapshots before comparing with Sent', async () => {
  const compare = vi.fn(async () => true)
  const base = await start({}, { sentDraftMatches: compare })
  const send = (snapshot: object) => fetch(base + '/v1/drafts/queued-alias/send-status?account=one', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) })
  expect((await send({ bodyMarkdown: 'Incomplete' })).status).toBe(400)
  expect(compare).not.toHaveBeenCalled()
  const fields = { to: 'test@example.com', cc: '', bcc: '', subject: 'Reply', bodyMarkdown: 'Full reply', attachments: [] }
  expect(await (await send(fields)).json()).toEqual({ matches: true })
  expect(compare).toHaveBeenCalledWith('one', 'queued-alias', fields)
})
it('never reports later edits delivered using a previous successful send receipt', async () => {
  const receipt = { id: 'sent', accountId: 'one', accountLabel: 'Test', draftId: 'draft', requestedAt: '2026-10-06T00:00:00Z', status: 'verified' as const, detailsSource: 'sent-message' as const, messageId: 'message' }
  const compare = vi.fn(async (_account, _id, fields) => fields.bodyMarkdown === 'Actually sent')
  const enqueue = vi.fn()
  const base = await start({}, { existingDraftSend: () => receipt, sentDraftMatches: compare, enqueueDraftSave: enqueue, beginGmailDraftSend: vi.fn() })
  const submit = (bodyMarkdown: string) => fetch(base + '/v1/draft-sends', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'one', draftId: 'draft', to: 'test@example.com', cc: '', bcc: '', subject: 'Reply', bodyMarkdown, attachments: [] }) })
  expect((await submit('New unsent edits')).status).toBe(409)
  expect(await (await submit('Actually sent')).json()).toEqual({ receipt })
  expect(enqueue).not.toHaveBeenCalled()
})


it('keeps authoritative and offline reads explicit while offering a cached opening route', async () => {
  const read = vi.fn(async () => { throw new Error('authoritative read') })
  const open = vi.fn(async () => { throw new Error('cached open') })
  const base = await start({}, { readConversation: read, openConversation: open })
  await fetch(base + '/v1/conversations/t1?account=one&preferCached=true&mailbox=spam')
  expect(open).toHaveBeenCalledWith('one', 't1', 'spam')
  expect(read).not.toHaveBeenCalled()
  await fetch(base + '/v1/conversations/t1?account=one')
  expect(read).toHaveBeenLastCalledWith('one', 't1', false, 'inbox')
  await fetch(base + '/v1/conversations/t1?account=one&preferCached=true&offline=true')
  expect(open).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenLastCalledWith('one', 't1', true, 'inbox')
})
