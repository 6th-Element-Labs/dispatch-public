import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GmailConnectorProvider } from '../src/gmail-provider.js'
import { GmailIndex } from '../src/gmail-index.js'
import { LocalMailStore } from '../src/local-mail-store.js'

it('a delayed Gmail read cannot roll back a newer confirmed draft in the durable cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cache-order-'))
  let release!: () => void
  let started!: () => void
  const reading = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    if (req.url?.endsWith('/drafts/list')) { res.end(JSON.stringify({ structuredContent: { drafts: [{ draft_id: 'd', message_id: 'old-message', thread_id: 't', to: ['test@example.com'], subject: 'Test' }] } })); return }
    if (req.url?.endsWith('/drafts/update')) { res.end(JSON.stringify({ structuredContent: { id: 'd', message: { id: 'new-message', thread_id: 't' } } })); return }
    if (req.url?.endsWith('/read')) {
      started(); await gate
      res.end(JSON.stringify({ structuredContent: { id: 'old-message', thread_id: 't', label_ids: ['DRAFT'], internal_date: '1789100000000', payload: { mime_type: 'text/plain', headers: [{ name: 'From', value: 'test@example.com' }, { name: 'To', value: 'test@example.com' }, { name: 'Subject', value: 'Test' }], body: { content: 'Older remote text' } } } })); return
    }
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, localPath: join(dir, 'local.sqlite') })
  try {
    const refresh = provider.readGmailDraft('one', 'd')
    await reading
    await provider.updateGmailDraft({ id: 'd', accountId: 'one', gmailThreadId: 't', inReplyToMessageId: '', to: [{ name: 'Test', address: 'test@example.com', initials: 'T' }], subject: 'Test', bodyMarkdown: 'Newer confirmed text', bodyText: 'Newer confirmed text', bodyHtml: '<p>Newer confirmed text</p>', attachments: [], state: 'draft' })
    release()
    expect((await refresh).bodyMarkdown).toBe('Newer confirmed text')
    expect((await provider.openGmailDraft('one', 'new-message', 't')).bodyMarkdown).toBe('Newer confirmed text')
  } finally { release(); provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) }
})

it('returns the indexed Drafts list while Gmail draft discovery is blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-fast-drafts-'))
  const path = join(dir, 'index.sqlite')
  const index = new GmailIndex(path)
  index.replaceAccounts([{ id: 'one', name: 'Test', email: 'test@example.com', connectorId: 'gmail' }], new Date().toISOString())
  index.completeSync(new Date().toISOString(), true)
  index.close()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let listCalls = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] })); return }
    listCalls++; await gate
    res.end(JSON.stringify({ structuredContent: { drafts: [{ draft_id: 'd', message_id: 'm', thread_id: 't', from_: 'test@example.com', to: ['test@example.com'], subject: 'Arrived in background', labels: ['DRAFT'], email_ts: '2026-09-11T01:00:00Z' }] } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: path })
  try {
    const rows = await Promise.race([provider.listMailboxConversations('drafts', 'all'), new Promise(resolve => setTimeout(() => resolve('blocked'), 500))])
    expect(rows).toEqual([])
    const revision = provider.syncStatus()?.draftsRevision
    const refreshing = provider.refreshDrafts(undefined, true)
    release(); await refreshing
    expect((await provider.listMailboxConversations('drafts', 'all'))[0]?.subject).toBe('Arrived in background')
    expect(provider.syncStatus()?.draftsRevision).not.toBe(revision)
    expect(listCalls).toBe(1)
  } finally { release(); await provider.refreshDrafts().catch(() => {}); provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) }
})

it('opens a confirmed cached draft after restart without a Gmail request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cached-editor-'))
  const path = join(dir, 'local.sqlite')
  const store = new LocalMailStore(path)
  store.putDraft({ id: 'd', accountId: 'one', gmailThreadId: 't', gmailMessageId: 'm', inReplyToMessageId: '', to: [{ name: 'Test', address: 'test@example.com', initials: 'T' }], subject: 'Saved subject', bodyMarkdown: '**Keep this**', bodyText: 'Keep this', bodyHtml: '<p><strong>Keep this</strong></p>', attachments: [{ name: 'note.txt', mediaType: 'text/plain', contentBase64: 'aGVsbG8=' }], state: 'draft' })
  store.close()
  // No listener: any provider call would fail this test.
  const provider = new GmailConnectorProvider('http://127.0.0.1:1', { indexPath: false, localPath: path })
  try {
    expect(await provider.openGmailDraft('one', 'outdated-message', 't')).toMatchObject({ id: 'd', cachedAt: expect.any(String), bodyMarkdown: '**Keep this**', attachments: [{ contentBase64: 'aGVsbG8=' }] })
  } finally { provider.stopBackgroundSync(); rmSync(dir, { recursive: true, force: true }) }
})
