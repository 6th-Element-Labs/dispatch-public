import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
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
    expect(accepted).toMatchObject([{ removeLabels: ['INBOX'], addLabels: [] }, { removeLabels: ['UNREAD'], addLabels: [] }, { removeLabels: ['INBOX'], addLabels: ['TRASH'] }])
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
