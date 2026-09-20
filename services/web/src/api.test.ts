import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api.js'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('draft API', () => {
  it('gets preview HTML from mail', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ bodyHtml: '<p><strong>Hello</strong></p>' }))
    vi.stubGlobal('fetch', fetch)

    await expect(api.previewDraft('**Hello**')).resolves.toBe('<p><strong>Hello</strong></p>')
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8411/v1/drafts/preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ bodyMarkdown: '**Hello**' }),
      }),
    )
  })

  it('opens, gets, and discards a draft through mail', async () => {
    const draft = { id: 'draft/1' }
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ draft }))
    vi.stubGlobal('fetch', fetch)

    await expect(api.openDraftFromMessage('account one', 'message/1')).resolves.toEqual(draft)
    await expect(api.getDraft('draft/1', 'account one')).resolves.toEqual(draft)
    await expect(api.discardDraft('draft/1', 'account one')).resolves.toBeUndefined()

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8411/v1/drafts/open',
      'http://127.0.0.1:8411/v1/drafts/draft%2F1?account=account%20one',
      'http://127.0.0.1:8411/v1/drafts/draft%2F1?action=discard&account=account%20one',
    ])
    expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ accountId: 'account one', messageId: 'message/1' }),
    }))
    expect(fetch.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }))
  })

  it('asks mail to open an attachment in the default native app', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ opened: true, filename: 'arrival.pdf' }))
    vi.stubGlobal('fetch', fetch)

    await expect(api.openAttachment('msg/1', 'att/9', 'link-one', 'arrival.pdf')).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8411/v1/messages/msg%2F1/attachments/att%2F9/open?filename=arrival.pdf&account=link-one',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('opens a demo attachment without a Gmail account', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ opened: true, filename: 'note.pdf' }))
    vi.stubGlobal('fetch', fetch)

    await api.openAttachment('demo-message-opua', 'demo-attachment-opua', undefined, 'note.pdf')
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8411/v1/messages/demo-message-opua/attachments/demo-attachment-opua/open?filename=note.pdf',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('sends one Markdown value as both draft body fields', async () => {
    const draft = { id: 'draft-1' }
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ draft }))
    vi.stubGlobal('fetch', fetch)

    await api.createDraft('message-1', { bodyMarkdown: '# Create' })
    await api.updateDraft('draft-1', { bodyText: '# Update' })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      messageId: 'message-1',
      bodyMarkdown: '# Create',
      bodyText: '# Create',
    })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      bodyMarkdown: '# Update',
      bodyText: '# Update',
    })
  })

  it('asks mail for recipient suggestions', async () => {
    const fetch = vi.fn(async () => jsonResponse({ recipients: [{ name: 'Ana', address: 'ana@example.com', initials: 'A' }] }))
    vi.stubGlobal('fetch', fetch)
    await expect(api.listRecipients('ana', 'link-one')).resolves.toEqual([{ name: 'Ana', address: 'ana@example.com', initials: 'A' }])
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8411/v1/recipients?q=ana&account=link-one', expect.anything())
  })

  it('asks agent to bind an unbound or conversation Codex thread', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ binding: { key: { kind: 'unbound' }, threadId: 'thread-u', created: false, replaced: false } }))
    vi.stubGlobal('fetch', fetch)
    await expect(api.bindThread({ kind: 'unbound' }, 'legacy')).resolves.toEqual({
      key: { kind: 'unbound' }, threadId: 'thread-u', created: false, replaced: false,
    })
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8412/v1/threads/bindings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'unbound', adoptThreadId: 'legacy' }),
      }),
    )
  })

  it('asks agent to bind a conversation Codex thread', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ binding: { key: { kind: 'conversation', accountId: 'one', gmailThreadId: 't1' }, threadId: 'thread-t1', created: true, replaced: false } }))
    vi.stubGlobal('fetch', fetch)
    await expect(api.bindThread({ kind: 'conversation', accountId: 'one', gmailThreadId: 't1' })).resolves.toMatchObject({ threadId: 'thread-t1', created: true })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ kind: 'conversation', accountId: 'one', gmailThreadId: 't1' })
  })
})
