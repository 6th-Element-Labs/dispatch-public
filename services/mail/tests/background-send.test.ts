import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GmailConnectorProvider } from '../src/gmail-provider.js'
import { vi } from 'vitest'

it.each(['accepted', 'unknown', 'save-failed', 'rejected'])('background Send accepts immediately, preserves the submitted reply and does not replay %s', async outcome => {
  let releaseCreate!: () => void
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
  let sends = 0
  let creates = 0
  let deliveryOutcome = outcome
  let payload: Record<string, any> = {}
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', email: 'test@example.com' }] }))
    if (req.url?.endsWith('/drafts/create')) {
      creates++; payload = input; await createGate
      if (outcome === 'save-failed') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Invalid Gmail draft' })) }
      return res.end(JSON.stringify({ structuredContent: { draft_id: 'saved', message: { id: 'm1', thread_id: 't1' } } }))
    }
    if (req.url?.endsWith('/drafts/list')) return res.end(JSON.stringify({ structuredContent: { drafts: [{ draft_id: 'saved', message_id: 'm1', thread_id: 't1', to: [payload.to], cc: [], bcc: [], subject: payload.subject }] } }))
    if (req.url?.endsWith('/read')) return res.end(JSON.stringify({ structuredContent: { id: 'm1', thread_id: 't1', label_ids: ['DRAFT'], internal_date: '1788486120000', payload: { mime_type: 'text/plain', headers: [{ name: 'From', value: 'test@example.com' }, { name: 'To', value: payload.to }, { name: 'Subject', value: payload.subject }, { name: 'Content-ID', value: `<${payload.draftContentId}>` }], body: { content: payload.bodyMarkdown } } } }))
    if (req.url?.endsWith('/drafts/send')) {
      sends++; expect(input.draftId ?? input.draft_id).toBe('saved')
      if (deliveryOutcome === 'rejected') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Provider rejected the send' })) }
      if (deliveryOutcome === 'unknown') { res.statusCode = 502; return res.end(JSON.stringify({ error: 'timeout after provider accepted send' })) }
      return res.end(JSON.stringify({ structuredContent: { id: 'sent' } }))
    }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, localPath: ':memory:', draftListLagMs: 0 })
  try {
    const draft = provider.enqueueDraftSave('one', '', { to: 'test@example.com', subject: 'Instant', bodyMarkdown: 'The exact reply', attachments: [] })
    const started = performance.now()
    const receipt = provider.beginGmailDraftSend('one', draft.id, draft.draftRevision)
    expect(performance.now() - started).toBeLessThan(100)
    expect(receipt.status).toBe('preparing')
    expect(provider.beginGmailDraftSend('one', draft.id).id).toBe(receipt.id)
    expect(sends).toBe(0)
    expect(() => provider.enqueueDraftSave('one', '', { bodyMarkdown: 'Stale edit' }, draft.id)).toThrow('already sending')
    releaseCreate()
    await expect.poll(() => provider.sendReceipt(receipt.id)?.status).toBe(outcome === 'accepted' ? 'accepted' : outcome === 'unknown' ? 'unknown' : 'failed')
    expect(payload.bodyMarkdown).toBe('The exact reply')
    expect(creates).toBe(1)
    expect(sends).toBe(outcome === 'save-failed' ? 0 : 1)
    if (outcome === 'accepted' || outcome === 'unknown') {
      expect(provider.beginGmailDraftSend('one', draft.id).id).toBe(receipt.id)
      expect(provider.beginGmailDraftSend('one', 'saved').id).toBe(receipt.id)
      expect(sends).toBe(1)
    }
    if (outcome === 'rejected') {
      expect(provider.backgroundSends()).toHaveLength(1)
      deliveryOutcome = 'accepted'
      const retry = provider.beginGmailDraftSend('one', 'saved')
      await expect.poll(() => provider.sendReceipt(retry.id)?.status).toBe('accepted')
      expect(sends).toBe(2)
      expect(provider.backgroundSends()).toHaveLength(0)
    }
  } finally { releaseCreate(); provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('resolves an externally sent Gmail draft back to its saved queue identity and refuses stale reads', async () => {
  let fields: Record<string, any> = {}
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', email: 'test@example.com' }] }))
    if (req.url?.endsWith('/drafts/create')) { fields = input; return res.end(JSON.stringify({ structuredContent: { draft_id: 'gmail-remote', message: { id: 'draft-message', thread_id: 'thread' } } })) }
    if (req.url?.endsWith('/drafts/list')) return res.end(JSON.stringify({ structuredContent: { drafts: [{ draft_id: 'gmail-remote', message_id: 'draft-message', thread_id: 'thread', to: [fields.to], subject: fields.subject }] } }))
    if (req.url?.endsWith('/read')) return res.end(JSON.stringify({ structuredContent: { id: 'draft-message', thread_id: 'thread', label_ids: ['DRAFT'], internal_date: '1788486120000', payload: { mime_type: 'text/plain', headers: [{ name: 'From', value: 'test@example.com' }, { name: 'To', value: fields.to }, { name: 'Subject', value: fields.subject }, { name: 'Content-ID', value: `<${fields.draftContentId}>` }], body: { content: fields.bodyMarkdown } } } }))
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, localPath: ':memory:', draftListLagMs: 0 })
  try {
    const draft = provider.enqueueDraftSave('one', '', { to: 'test@example.com', subject: 'External send', bodyMarkdown: 'Body' })
    await provider.flushDraftSaves('one')
    expect(await provider.readGmailDraft('one', draft.id)).toMatchObject({ id: 'gmail-remote', resolvedFromDraftId: draft.id })
    const receipt = provider.recordExternalSend('one', 'sent', 'gmail-remote')
    expect(provider.existingDraftSend('one', draft.id)?.id).toBe(receipt.id)
    expect(provider.existingDraftSend('other', draft.id)).toBeUndefined()
    await expect(provider.readGmailDraft('one', draft.id)).rejects.toMatchObject({ code: 'gmail_draft_not_found' })
    await expect(provider.readGmailDraft('one', 'gmail-remote')).rejects.toMatchObject({ code: 'gmail_draft_not_found' })
    expect(provider.beginGmailDraftSend('one', draft.id).id).toBe(receipt.id)
    expect(() => provider.enqueueDraftSave('one', '', { bodyMarkdown: 'Stale recovered draft' }, draft.id, 'new-editor')).toThrow('already sent')
  } finally { provider.stopBackgroundSync(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('consumes recovery only when Sent contains the same recipients, full body and attachment bytes', async () => {
  const provider = new GmailConnectorProvider('http://127.0.0.1:1', { indexPath: false, localPath: ':memory:', draftListLagMs: 0 })
  const file = { name: 'proposal.pdf', mediaType: 'application/pdf', contentBase64: 'YWJj' }
  const message = { id: 'sent', threadId: 'thread', sender: { address: 'me@example.com', name: 'Me', initials: 'M' }, to: [{ address: 'test@example.com', name: 'Test', initials: 'T' }], cc: [], bcc: [], subject: 'Reply', receivedAt: new Date().toISOString(), receivedLabel: '', receivedFullLabel: '', preview: '', unread: false, accountId: 'one', labels: ['SENT'], source: 'gmail' as const, body: { kind: 'sanitized-html' as const, content: '<p>Full <strong>reply</strong>.</p>' }, attachments: [{ id: 'file', name: file.name, mediaType: file.mediaType, sizeLabel: '3 B', contentId: 'generated@draft.dispatch.local' }] }
  vi.spyOn(provider, 'readMessage').mockResolvedValue(message)
  vi.spyOn(provider, 'readAttachment').mockResolvedValue({ structuredContent: { base64_url_content: 'YWJj' } })
  provider.recordExternalSend('one', 'sent', 'remote')
  const fields = { to: 'test@example.com', cc: '', bcc: '', subject: 'Reply', bodyMarkdown: 'Full **reply**.', attachments: [file] }
  try {
    expect(await provider.sentDraftMatches('one', 'remote', fields)).toBe(true)
    expect(await provider.sentDraftMatches('one', 'remote', { ...fields, bodyMarkdown: 'Full **reply**.\n\nNew unsent edits.' })).toBe(false)
    expect(await provider.sentDraftMatches('one', 'remote', { ...fields, cc: 'other@example.com' })).toBe(false)
    expect(await provider.sentDraftMatches('one', 'remote', { ...fields, attachments: [{ ...file, contentBase64: 'eHl6' }] })).toBe(false)
    expect(await provider.sentDraftMatches('one', 'remote', { ...fields, attachments: [{ ...file, contentId: 'inline-image@example.com' }] })).toBe(false)
    expect(await provider.sentDraftMatches('one', 'remote', { ...fields, attachments: [{ ...file, contentId: 'generated@draft.dispatch.local' }] })).toBe(true)
    expect(await provider.sentDraftMatches('other', 'remote', fields)).toBe(false)
  } finally { provider.stopBackgroundSync() }
})
