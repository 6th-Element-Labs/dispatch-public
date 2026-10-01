import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { GmailConnectorProvider } from '../src/gmail-provider.js'

it.each(['revoked', 'lost500', 'lostTimeout'])('a durable save recovers from %s and restart without duplicating Gmail drafts', async failure => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-outbox-provider-'))
  let attempts = 0; let accepted = 0; let payload: Record<string, any> = {}; let exists = false
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', name: 'Test', email: 'test@example.com' }] }))
    if (req.url?.endsWith('/drafts/create')) {
      attempts++
      if (attempts === 1 && failure === 'revoked') { res.statusCode = 502; return res.end(JSON.stringify({ error: 'Transport send error: HTTP 401 token_revoked' })) }
      accepted++; exists = true; payload = input
      if (attempts === 1) { res.statusCode = 502; return res.end(JSON.stringify({ error: failure === 'lost500' ? 'Gmail HTTP status: 500 after accepting draft' : 'timeout after accepting draft' })) }
      return res.end(JSON.stringify({ structuredContent: { draft_id: 'saved', message: { id: 'm1', thread_id: 't1' } } }))
    }
    if (req.url?.endsWith('/drafts/list')) return res.end(JSON.stringify({ structuredContent: { drafts: exists ? [{ draft_id: 'saved', message_id: 'm1', thread_id: 't1', to: [payload.to], cc: [], bcc: [], subject: payload.subject }] : [] } }))
    if (req.url?.endsWith('/drafts/update')) { payload = { ...payload, ...input }; return res.end(JSON.stringify({ structuredContent: { id: 'saved', message: { id: 'm1', thread_id: 't1' } } })) }
    if (req.url?.endsWith('/read')) return res.end(JSON.stringify({ structuredContent: { id: 'm1', thread_id: 't1', label_ids: ['DRAFT'], internal_date: '1788486120000', payload: { mime_type: 'text/plain', headers: [{ name: 'From', value: 'test@example.com' }, { name: 'To', value: payload.to }, { name: 'Subject', value: payload.subject }, { name: 'Content-ID', value: `<${payload.draftContentId}>` }], body: { content: payload.bodyMarkdown } } } }))
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const open = () => new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, localPath: join(dir, 'local.sqlite'), draftListLagMs: 0 })
  let provider = open()
  try {
    const draft = provider.enqueueDraftSave('one', '', { to: 'test@example.com', subject: 'Durable', bodyMarkdown: 'Never lose this', attachments: [] })
    await provider.flushDraftSaves()
    expect((await provider.readGmailDraft('one', draft.id)).syncState).toBe('pending')
    await expect(provider.sendGmailDraft('one', draft.id)).rejects.toThrow('Nothing was sent')
    provider.stopBackgroundSync(); provider = open()
    // Advance the persisted retry time without changing a provider response or a save identity.
    const { LocalMailStore } = await import('../src/local-mail-store.js')
    const store = new LocalMailStore(join(dir, 'local.sqlite'))
    store.putDraftSave({ ...store.draftSave('one', draft.id)!, retryAt: 0 }); store.close()
    await provider.flushDraftSaves()
    const confirmed = await provider.readGmailDraft('one', draft.id)
    expect(confirmed).toMatchObject({ id: 'saved', resolvedFromDraftId: draft.id, bodyMarkdown: 'Never lose this', to: [{ address: 'test@example.com' }] })
    expect(confirmed.syncState).toBeUndefined()
    expect(accepted).toBe(1)
    expect(attempts).toBe(failure === 'revoked' ? 2 : 1)
  } finally { provider.stopBackgroundSync(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) }
})
