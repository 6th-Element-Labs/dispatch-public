import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { GmailConnectorProvider } from '../src/gmail-provider.js'
import { GmailIndex } from '../src/gmail-index.js'
import { LocalMailStore } from '../src/local-mail-store.js'

it('can retry after the agent could not be reached at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-refused-draft-'))
  const path = join(dir, 'index.sqlite')
  const index = new GmailIndex(path)
  index.replaceAccounts([{ id: 'one', name: 'Work', email: 'work@example.com', connectorId: 'gmail' }], new Date().toISOString())
  index.close()
  const unused = createServer()
  await new Promise<void>(resolve => unused.listen(0, '127.0.0.1', resolve))
  const port = (unused.address() as AddressInfo).port
  await new Promise<void>(resolve => unused.close(() => resolve()))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${port}`, { indexPath: path })
  try {
    await expect(provider.createGmailDraft('one', '', 'work@example.com', '', '', 'Subject', 'Body', [], 'refused-key')).rejects.toThrow()
    const store = new LocalMailStore(`${path}.local`)
    expect(store.draftCreate('one', 'refused-key')).toBeUndefined()
    store.close()
  } finally { provider.stopBackgroundSync(); await rm(dir, { recursive: true, force: true }) }
})

it.each([false, true])('reuses one draft across response loss and restart (lost=%s)', async lost => {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-draft-sync-'))
  let creates = 0
  let payload: Record<string, any> = {}
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Work', email: 'work@example.com' }] }))
    if (req.url === '/v1/connectors/gmail/drafts/create') {
      creates++; payload = input
      if (lost) { res.statusCode = 502; return res.end(JSON.stringify({ error: 'timeout after provider accepted the draft' })) }
      return res.end(JSON.stringify({ structuredContent: { draft_id: 'saved', message: { id: 'm1', thread_id: 't1' } } }))
    }
    if (req.url === '/v1/connectors/gmail/drafts/list') return res.end(JSON.stringify({ structuredContent: { drafts: creates ? [{ draft_id: 'saved', message_id: 'm1', thread_id: 't1', to: ['work@example.com'], subject: 'Subject' }] : [] } }))
    if (req.url === '/v1/connectors/gmail/read') return res.end(JSON.stringify({ structuredContent: { id: 'm1', thread_id: 't1', label_ids: ['DRAFT'], internal_date: '1788486120000', payload: { mime_type: 'text/plain', headers: [{ name: 'From', value: 'work@example.com' }, { name: 'Subject', value: 'Subject' }, { name: 'Content-ID', value: `<${payload.draftContentId}>` }], body: { content: payload.bodyMarkdown } } } }))
    if (req.url === '/v1/connectors/gmail/drafts/update') { payload = { ...payload, ...input }; return res.end(JSON.stringify({ structuredContent: { id: 'saved' } })) }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const open = () => new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, localPath: join(dir, 'local.sqlite') })
  let provider = open()
  try {
    const first = provider.createGmailDraft('one', '', 'work@example.com', '', '', 'Subject', 'First', [], 'stable-save-key')
    if (lost) await expect(first).rejects.toThrow('timeout')
    else expect((await first).id).toBe('saved')
    provider.stopBackgroundSync(); provider = open()
    const saved = await provider.createGmailDraft('one', '', 'work@example.com', '', '', 'Subject', 'Newer text', [], 'stable-save-key')
    expect(saved.id).toBe('saved')
    expect(payload.bodyMarkdown).toBe('Newer text')
    expect(creates).toBe(1)
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
})

it('re-reads a draft after the Gmail list lag before reporting it missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-draft-lag-'))
  let lists = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Work', email: 'work@example.com' }] }))
    if (req.url === '/v1/connectors/gmail/drafts/list') { lists++; return res.end(JSON.stringify({ structuredContent: { drafts: lists >= 2 ? [{ draft_id: 'r-new', message_id: 'm2', thread_id: 't1', to: ['work@example.com'], subject: 'Subject' }] : [] } })) }
    if (req.url === '/v1/connectors/gmail/read') return res.end(JSON.stringify({ structuredContent: { id: 'm2', thread_id: 't1', label_ids: ['DRAFT'], internal_date: '1788486120000', payload: { mime_type: 'text/plain', headers: [{ name: 'From', value: 'work@example.com' }, { name: 'Subject', value: 'Subject' }], body: { content: 'Body' } } } }))
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, localPath: join(dir, 'local.sqlite'), draftListLagMs: 20 })
  try {
    const draft = await provider.readGmailDraft('one', 'r-new')
    expect(draft.id).toBe('r-new')
    expect(lists).toBe(2)
    await expect(provider.readGmailDraft('one', 'r-gone')).rejects.toMatchObject({ code: 'gmail_draft_not_found' })
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
})

it('updates the replacement draft when Gmail no longer knows the old draft id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-draft-replaced-'))
  const updates: string[] = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Work', email: 'work@example.com' }] }))
    if (req.url === '/v1/connectors/gmail/drafts/list') return res.end(JSON.stringify({ structuredContent: { drafts: [{ draft_id: 'r-new', message_id: 'm2', thread_id: 't1', to: ['work@example.com'], subject: 'Subject' }] } }))
    if (req.url === '/v1/connectors/gmail/drafts/update') {
      updates.push(String(input.draftId))
      if (input.draftId === 'r-old') return res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'ActionError: Gmail `update_draft` failed: Gmail API request failed. HTTP status: 404. Retryable: no.' }] }))
      return res.end(JSON.stringify({ structuredContent: { id: 'r-new', message: { id: 'm3', thread_id: 't1' } } }))
    }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, localPath: join(dir, 'local.sqlite'), draftListLagMs: 0 })
  try {
    const saved = await provider.updateGmailDraft({ id: 'r-old', accountId: 'one', inReplyToMessageId: '', to: [{ name: 'work@example.com', address: 'work@example.com', initials: 'W' }], cc: '', bcc: '', subject: 'Subject', bodyMarkdown: 'Newer', bodyHtml: '<p>Newer</p>', bodyText: 'Newer', attachments: [], state: 'draft', gmailThreadId: 't1' })
    expect(saved.id).toBe('r-new')
    expect(updates).toEqual(['r-old', 'r-new'])
    await expect(provider.updateGmailDraft({ id: 'r-old', accountId: 'one', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Subject', bodyMarkdown: 'x', bodyHtml: '', bodyText: 'x', attachments: [], state: 'draft', gmailThreadId: 't-other' })).rejects.toMatchObject({ code: 'gmail_draft_not_found' })
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
})
