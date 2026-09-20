import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { projectDraft } from '../src/draft.js'
import { GmailConnectorProvider } from '../src/gmail-provider.js'
import { LocalMailStore, type SendReceipt } from '../src/local-mail-store.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0 })
const account = { linkId: 'one', name: 'Work', email: 'work@example.com' }
const message = (id = 'm1', labels = ['INBOX']) => ({ id, thread_id: 't1', label_ids: labels, internal_date: '1788486120000', payload: { mime_type: 'multipart/mixed', headers: [ { name: 'From', value: 'Work <work@example.com>' }, { name: 'To', value: 'ana@example.com' }, { name: 'Cc', value: 'cc@example.com' }, { name: 'Bcc', value: 'bcc@example.com' }, { name: 'Subject', value: 'Delivery' } ], parts: [{ mime_type: 'text/plain', body: { content: 'Full saved body' } }, { mime_type: 'application/pdf', filename: 'proposal.pdf', body: { size: 100, attachment_id: 'a1' } }] } })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-reliability-')); cleanup.push(() => rmSync(dir, { force: true, recursive: true }))
  let releaseRead: (() => void) | undefined
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  let releaseSync: (() => void) | undefined
  const syncGate = new Promise<void>(resolve => { releaseSync = resolve })
  const state = { threadMessages: undefined as ReturnType<typeof message>[] | undefined, failUpdate: false, trashed: false, failTrash: false, deleted: [] as string[][], holdSync: false, syncCalls: 0, releaseSync: () => releaseSync!(), holdRead: false, releaseRead: () => releaseRead!(), reads: 0, sends: 0, threadError: '', sendError: false, verifyError: false, to: 'ana@example.com' }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const reply = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url === '/v1/connectors/gmail') return reply({ accounts: [account] })
    if (req.url === '/v1/connectors/gmail/read-thread') { state.reads++; if (state.holdRead) await gate; return state.threadError ? reply({ error: state.threadError }, 503) : reply({ structuredContent: { messages: state.threadMessages ?? [message()] } }) }
    if (req.url === '/v1/connectors/gmail/drafts/list') return reply({ structuredContent: { drafts: state.trashed ? [] : [{ draft_id: 'd1', message_id: 'draft-message', thread_id: 't1', to: ['ana@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Delivery' }] } })
    if (req.url === '/v1/connectors/gmail/read') {
      if (body.messageId === 'sent' && state.verifyError) return reply({ error: 'temporarily unavailable' }, 503)
      const value = message(body.messageId, body.messageId === 'sent' ? ['SENT'] : ['DRAFT'])
      if (body.messageId === 'sent') value.payload.headers[1]!.value = state.to
      return reply({ structuredContent: value })
    }
    if (req.url === '/v1/connectors/gmail/drafts/discard') return reply({ error: 'gmail_draft_discard_unavailable' }, 503)
    if (req.url === '/v1/connectors/gmail/delete') { state.deleted.push(body.messageIds); state.trashed = !state.failTrash; return reply({ structuredContent: { responses: [{ message_id: body.messageIds[0], success: !state.failTrash }] } }) }
    if (req.url === '/v1/connectors/gmail/drafts/update') return reply(state.failUpdate ? { isError: true, structuredContent: { error: 'recipient rejected' } } : { structuredContent: { draft_id: 'd1' } })
    if (req.url === '/v1/connectors/gmail/drafts/create') return reply({ structuredContent: { draft_id: 'created-fast' } })
    if (req.url === '/v1/connectors/gmail/drafts/send') { state.sends++; return state.sendError ? reply({ error: 'timeout waiting for Gmail' }, 504) : reply({ structuredContent: { id: 'sent' } }) }
    if (req.url === '/v1/connectors/gmail/search-messages') { state.syncCalls++; if (state.holdSync) await syncGate; return reply({ structuredContent: { emails: body.labelIds?.includes('INBOX') ? [{ id: 'm1', thread_id: 't1', from_: 'work@example.com', subject: 'Delivery', labels: ['INBOX'], email_ts: '2026-09-04T01:00:00Z' }] : [] } }) }
    reply({ error: 'not found' }, 404)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const path = join(dir, 'index.sqlite')
  const providers: GmailConnectorProvider[] = []
  cleanup.push(() => { for (const p of providers) p.stopBackgroundSync() })
  const open = () => { const p = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: path }); providers.push(p); return p }
  const close = (p: GmailConnectorProvider) => { p.stopBackgroundSync(); providers.splice(providers.indexOf(p), 1) }
  return { state, open, close, path }
}
it('keeps full opened threads across restart and does no connector read in downloaded mode', async () => {
  const f = await fixture(); const first = f.open()
  const live = await first.readConversation('one', 't1')
  expect(live.availability?.mode).toBe('live'); f.close(first)
  const restarted = f.open()
  const cached = await restarted.readConversation('one', 't1', true)
  expect(cached.messages[0]?.body.content).toContain('Full saved body')
  expect(cached.availability?.mode).toBe('downloaded'); expect(f.state.reads).toBe(1)
  await expect(restarted.readConversation('two', 't1', true)).rejects.toMatchObject({ code: 'not_downloaded' })
  expect(f.state.reads).toBe(1)
  f.state.threadError = 'timeout'; expect((await restarted.readConversation('one', 't1')).availability?.mode).toBe('downloaded')
  f.state.threadError = '404 not found'; await expect(restarted.readConversation('one', 't1')).rejects.toThrow('404')
})
it('downloads the selected indexed mailbox and reuses complete current copies', async () => {
  const f = await fixture(); const p = f.open(); await p.syncNow()
  expect(p.startOfflineDownload('inbox', 'one').total).toBe(1)
  await expect.poll(() => p.offlineStatus().download?.state).toBe('complete')
  expect(p.offlineStatus().conversations).toBe(1)
  expect(p.downloadedConversations('inbox', 'all', 'one')[0]?.downloaded).toBe(true)
  p.startOfflineDownload('inbox', 'one')
  await expect.poll(() => p.offlineStatus().download?.state).toBe('complete')
  expect(f.state.reads).toBe(1)
})
it('persists one send, verifies actual recipients and files, and never resends after restart', async () => {
  const f = await fixture(); const p = f.open(); f.state.to = 'changed@example.com'
  const responses = await Promise.all([p.sendGmailDraft('one', 'd1'), p.sendGmailDraft('one', 'd1')]) as { receipt: SendReceipt }[]
  expect(responses[0]?.receipt.status).toBe('accepted'); expect(f.state.sends).toBe(1)
  await expect.poll(() => p.sendReceipts()[0]?.status).toBe('verified')
  const receipt = p.sendReceipts()[0]!
  expect(receipt.details).toMatchObject({ to: ['changed@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], attachments: [{ name: 'proposal.pdf' }] })
  expect(receipt.warnings).toContain('Sent recipients differ from the saved draft snapshot.')
  f.close(p); const restarted = f.open(); await restarted.sendGmailDraft('one', 'd1')
  expect(f.state.sends).toBe(1); expect(restarted.sendReceipts()[0]?.id).toBe(receipt.id)
})
it('keeps accepted sends accepted when verification fails, then allows verification to recover', async () => {
  const f = await fixture(); const p = f.open(); f.state.verifyError = true
  const result = await p.sendGmailDraft('one', 'd1') as { receipt: SendReceipt }
  await expect.poll(() => p.sendReceipt(result.receipt.id)?.error).toContain('could not be verified')
  expect(p.sendReceipts()[0]?.status).toBe('accepted')
  f.state.verifyError = false
  expect((await p.verifySendReceipt(result.receipt.id)).status).toBe('verified')
  expect(f.state.sends).toBe(1)
})
it('keeps ambiguous send failures unknown across restart and blocks a blind retry', async () => {
  const f = await fixture(); const p = f.open(); f.state.sendError = true
  expect((await p.sendGmailDraft('one', 'd1') as { receipt: SendReceipt }).receipt.status).toBe('unknown')
  f.close(p); const restarted = f.open(); await restarted.sendGmailDraft('one', 'd1'); expect(f.state.sends).toBe(1)
})
it('recovers all interrupted receipts, including entries older than the visible history limit', async () => {
  const f = await fixture(); const db = new LocalMailStore(`${f.path}.local`)
  for (let i = 0; i < 105; i++) db.putReceipt({ id: `receipt-${i}`, accountId: 'one', accountLabel: 'Work', status: i % 2 ? 'preparing' : 'sending', requestedAt: new Date(i).toISOString(), detailsSource: 'unavailable' })
  db.putDownload({ id: 'job', state: 'running', total: 3, completed: 1, mailbox: 'inbox', errors: [], startedAt: new Date().toISOString() }); db.close()
  const restarted = new LocalMailStore(`${f.path}.local`)
  expect(restarted.receipt('receipt-0')?.status).toBe('unknown'); expect(restarted.receipt('receipt-1')?.status).toBe('failed')
  expect(restarted.download()?.state).toBe('interrupted'); restarted.close()
})

it('a cancelled download cannot overwrite the persisted status of its replacement', async () => {
  const f = await fixture(); const p = f.open(); await p.syncNow(); f.state.holdRead = true
  const first = p.startOfflineDownload('inbox', 'one')
  await expect.poll(() => f.state.reads).toBe(1)
  p.cancelOfflineDownload()
  const second = p.startOfflineDownload('sent', 'one')
  expect(second.id).not.toBe(first.id); expect(second.state).toBe('complete')
  f.state.releaseRead()
  await expect.poll(() => first.completed).toBe(1)
  f.close(p); const restarted = f.open()
  expect(restarted.offlineStatus().download?.id).toBe(second.id)
  expect(restarted.offlineStatus().download?.state).toBe('complete')
})

it('returns a confirmed draft without waiting for a blocked mailbox sync', async () => {
  const f = await fixture(); const p = f.open(); f.state.holdSync = true
  const syncing = p.syncNow()
  try {
    await expect.poll(() => f.state.syncCalls).toBeGreaterThan(0)
    const creating = p.createGmailDraft('one', 'm1', 'ana@example.com', '', '', 'Reply', 'Immediate reply')
    const result = await Promise.race([creating, new Promise<null>(resolve => setTimeout(() => resolve(null), 500))])
    expect(result?.id).toBe('created-fast')
  } finally { f.state.releaseSync(); await syncing }
})

it('discards only the exact draft message when the connector has Trash but no delete_draft', async () => {
  const f = await fixture(); const p = f.open()
  await p.discardGmailDraft('one', 'd1')
  expect(f.state.deleted).toEqual([['draft-message']])
  expect(f.state.trashed).toBe(true)
})
it('does not claim a draft was discarded when Gmail rejects the Trash action', async () => {
  const f = await fixture(); const p = f.open(); f.state.failTrash = true
  await expect(p.discardGmailDraft('one', 'd1')).rejects.toThrow('did not confirm')
  expect(f.state.trashed).toBe(false)
})

it('does not report a saved draft when the connector returns an error inside HTTP 200', async () => {
  const f = await fixture(); const p = f.open(); f.state.failUpdate = true
  await expect(p.updateGmailDraft(projectDraft({ id: 'd1', accountId: 'one', inReplyToMessageId: 'm1', to: [], subject: 'UAT', bodyMarkdown: 'Test' }))).rejects.toThrow('recipient rejected')
})

it('keeps raw downloaded bodies but applies folder visibility on every read', async () => {
  const f = await fixture(); const p = f.open()
  f.state.threadMessages = [message(), { ...message('discarded', ['DRAFT', 'TRASH']), internal_date: '1788487120000' }]
  expect((await p.readConversation('one', 't1')).latestMessageId).toBe('m1')
  f.close(p); const restarted = f.open()
  expect((await restarted.readConversation('one', 't1', true, 'trash')).latestMessageId).toBe('discarded')
  expect((await restarted.readConversation('one', 't1', true, 'inbox')).latestMessageId).toBe('m1')
  expect(f.state.reads).toBe(1)
})
