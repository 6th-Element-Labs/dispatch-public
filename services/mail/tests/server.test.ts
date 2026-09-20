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

async function start(options: Parameters<typeof createMailServer>[1] = {}) {
  const server = createMailServer({
    accounts: async () => [],
    listMessages: async () => [],
    listUnifiedMessages: async () => [],
    readMessage: async () => { throw new Error('not configured') },
    listConversations: async () => [],
    listUnifiedConversations: async () => [],
    readConversation: async () => { throw new Error('not configured') },
  }, { demoEnabled: true, ...options })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${port}`
}

describe('dispatch-mail', () => {
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
