import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { folderFlagsFromLabels, GmailIndex, type IndexedGmailMessage } from '../src/gmail-index.js'
import { GmailConnectorProvider, projectGmailSearchEmail, type GmailAccountProjection } from '../src/gmail-provider.js'

const servers: ReturnType<typeof createServer>[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

const account: GmailAccountProjection = { id: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }
const connectorAccount = { linkId: account.id, connectorId: account.connectorId, name: account.name, email: account.email }

function indexedMessage(id: string, labels: readonly string[]): IndexedGmailMessage {
  const summary = projectGmailSearchEmail({
    id,
    thread_id: `thread-${id}`,
    from_: 'Ana <ana@example.com>',
    subject: `Subject ${id}`,
    snippet: `Preview ${id}`,
    labels,
    email_ts: '2026-09-30T12:00:00Z',
  }, account)
  return { ...summary, ...folderFlagsFromLabels(labels) }
}

type SearchPage = { ids: readonly string[]; next: string }
type SearchInput = { labelIds?: unknown; query?: unknown; nextPageToken?: unknown }

function streamKey(input: SearchInput): string {
  const labels = Array.isArray(input.labelIds) ? input.labelIds as string[] : []
  if (labels.length) return labels.join(',')
  return String(input.query ?? '').includes('-in:inbox -in:sent -in:drafts') ? 'ARCHIVE' : 'OTHER'
}

function searchBody(request: IncomingMessage): Promise<SearchInput> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}') as SearchInput) }
      catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}

function send(response: ServerResponse, body: unknown): void {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

async function startFixture(options: {
  seed: readonly IndexedGmailMessage[]
  page: (key: string, token: string) => SearchPage
  details?: (key: string, token: string, page: SearchPage) => readonly IndexedGmailMessage[]
}) {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-sync-reconciliation-'))
  directories.push(directory)
  const indexPath = join(directory, 'gmail.sqlite')
  const index = new GmailIndex(indexPath)
  index.replaceAccount(account.id, options.seed, 'seed', true)
  index.close()

  const calls: Array<{ path: string; key: string; token: string }> = []
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/connectors/gmail') return send(response, { accounts: [connectorAccount] })
    if (request.url === '/v1/connectors/gmail/search' || request.url === '/v1/connectors/gmail/search-messages') {
      const input = await searchBody(request)
      const key = streamKey(input)
      const token = String(input.nextPageToken ?? '')
      const page = options.page(key, token)
      calls.push({ path: request.url, key, token })
      if (request.url === '/v1/connectors/gmail/search') {
        return send(response, { structuredContent: { message_ids: page.ids, next_page_token: page.next } })
      }
      const messages = options.details?.(key, token, page) ?? options.seed.filter(message => page.ids.includes(message.id))
      return send(response, {
        structuredContent: {
          emails: messages.map(message => ({
            id: message.id,
            thread_id: message.threadId,
            from_: `${message.sender.name} <${message.sender.address}>`,
            subject: message.subject,
            snippet: message.preview,
            labels: [
              ...(message.inInbox ? ['INBOX'] : []),
              ...(message.unread ? ['UNREAD'] : []),
              ...(message.inSent ? ['SENT'] : []),
              ...(message.inDrafts ? ['DRAFT'] : []),
              ...(message.inSpam ? ['SPAM'] : []),
              ...(message.inTrash ? ['TRASH'] : []),
            ],
            email_ts: message.receivedAt,
          })),
          next_page_token: page.next,
        },
      })
    }
    response.statusCode = 404
    return send(response, {})
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${address.port}`, { indexPath, draftListLagMs: 0 })
  return { provider, indexPath, calls }
}

describe('safe full-scan reconciliation', () => {
  it('converges off-head label moves and deletions only after complete paginated streams', async () => {
    const seed = [
      indexedMessage('keep-inbox', ['INBOX']),
      indexedMessage('move-to-archive', ['INBOX']),
      indexedMessage('delete-from-sent', ['SENT']),
      indexedMessage('archive-head', []),
      indexedMessage('sent-head', ['SENT']),
    ]
    const archiveHead = indexedMessage('archive-head', [])
    const freshInbox = indexedMessage('fresh-inbox', ['INBOX'])
    const moved = indexedMessage('move-to-archive', [])
    const sentTail = indexedMessage('sent-tail', ['SENT'])
    const pages: Record<string, Record<string, SearchPage>> = {
      INBOX: {
        '': { ids: ['keep-inbox'], next: 'inbox-p2' },
        'inbox-p2': { ids: ['fresh-inbox'], next: '' },
      },
      ARCHIVE: {
        '': { ids: ['archive-head'], next: 'archive-p2' },
        'archive-p2': { ids: ['move-to-archive'], next: '' },
      },
      SENT: {
        '': { ids: ['sent-head'], next: 'sent-p2' },
        'sent-p2': { ids: ['sent-tail'], next: '' },
      },
      UNREAD: { '': { ids: [], next: '' } },
      DRAFT: { '': { ids: [], next: '' } },
      SPAM: { '': { ids: [], next: '' } },
      TRASH: { '': { ids: [], next: '' } },
    }
    const fixture = await startFixture({
      seed,
      page: (key, token) => pages[key]?.[token] ?? { ids: [], next: '' },
      details: (key, _token, page) => {
        if (key === 'INBOX' && page.ids.includes('fresh-inbox')) return [freshInbox]
        if (key === 'ARCHIVE' && page.ids.includes('move-to-archive')) return [moved]
        if (key === 'SENT' && page.ids.includes('sent-tail')) return [sentTail]
        return page.ids.includes('archive-head') ? [archiveHead] : []
      },
    })
    try {
      await fixture.provider.syncNow()
      expect(fixture.provider.syncStatus()).toMatchObject({ state: 'ready' })
      expect(fixture.calls.filter(call => call.path.endsWith('/search') && ['INBOX', 'ARCHIVE', 'SENT'].includes(call.key))).toHaveLength(6)

      const current = new GmailIndex(fixture.indexPath)
      try {
        const rows = new Map(current.messages(account.id).map(message => [message.id, message]))
        expect(rows.get('keep-inbox')?.inInbox).toBe(true)
        expect(rows.get('fresh-inbox')?.inInbox).toBe(true)
        expect(rows.get('move-to-archive')).toMatchObject({ inInbox: false, inArchive: true })
        expect(rows.get('sent-tail')?.inSent).toBe(true)
        expect(rows.has('delete-from-sent')).toBe(false)
      } finally { current.close() }
    } finally { fixture.provider.stopBackgroundSync() }
  }, 20_000)

  it('rejects an a→b→a page-token cycle without reconciling existing rows as deleted', async () => {
    const keep = indexedMessage('known-inbox', ['INBOX'])
    const fixture = await startFixture({
      seed: [keep],
      page: (key, token) => key !== 'INBOX'
        ? { ids: [], next: '' }
        : token === '' ? { ids: ['known-inbox'], next: 'a' }
          : token === 'a' ? { ids: ['known-inbox'], next: 'b' }
            : { ids: ['known-inbox'], next: 'a' },
    })
    try {
      await expect(fixture.provider.syncNow()).rejects.toThrow(/pagination repeated a page token/i)
      expect(fixture.provider.syncStatus()).toMatchObject({ state: 'failed' })
      const current = new GmailIndex(fixture.indexPath)
      try { expect(current.messages(account.id)).toEqual([keep]) }
      finally { current.close() }
    } finally { fixture.provider.stopBackgroundSync() }
  }, 20_000)

  it('rejects a scan that stays incomplete after 100 pages without deleting indexed rows', async () => {
    const keep = indexedMessage('known-inbox', ['INBOX'])
    const fixture = await startFixture({
      seed: [keep],
      page: (key, token) => {
        if (key !== 'INBOX') return { ids: [], next: '' }
        const page = token ? Number(token.slice(1)) : 1
        return { ids: ['known-inbox'], next: `p${page + 1}` }
      },
    })
    try {
      await expect(fixture.provider.syncNow()).rejects.toThrow(/pagination exceeded 100 pages/i)
      expect(fixture.provider.syncStatus()).toMatchObject({ state: 'failed' })
      expect(fixture.calls.filter(call => call.path.endsWith('/search') && call.key === 'INBOX')).toHaveLength(100)
      const current = new GmailIndex(fixture.indexPath)
      try { expect(current.messages(account.id)).toEqual([keep]) }
      finally { current.close() }
    } finally { fixture.provider.stopBackgroundSync() }
  }, 20_000)
})
