import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GmailIndex, type IndexedGmailAccount } from '../src/gmail-index.js'
import { GmailApiError, GmailHistorySync, type GmailHistoryTransport } from '../src/gmail-history-sync.js'
import { GmailConnectorProvider, projectGmailApiMessage } from '../src/gmail-provider.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const account: IndexedGmailAccount = { id: 'one', email: 'work@example.com', name: 'Work', connectorId: 'gmail' }
const directories: string[] = []
const indexes: GmailIndex[] = []
afterEach(() => { indexes.splice(0).forEach(index => index.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })) })
function message(id: string, labels = ['INBOX', 'UNREAD']) {
  return { id, threadId: `thread-${id}`, labelIds: labels, internalDate: '1790769600000', snippet: `Preview ${id}`, payload: { headers: [{ name: 'From', value: 'Ana <ana@example.com>' }, { name: 'Subject', value: `Subject ${id}` }], parts: [{ filename: 'proposal.pdf', mimeType: 'application/pdf', body: { attachmentId: 'opaque', size: 2 } }] } }
}
function indexFile() {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-history-')); directories.push(directory)
  return join(directory, 'mail.sqlite')
}
function fixture(handler: (path: string, signal: AbortSignal) => unknown | Promise<unknown>, seeded = true) {
  const path = indexFile()
  const index = new GmailIndex(path); indexes.push(index)
  index.replaceAccounts([account], 'now')
  if (seeded) index.applyHistory(account.id, account.email, [projectGmailApiMessage(message('old'), account)], [], '100')
  const calls: string[] = []
  const transport: GmailHistoryTransport = { connected: async () => true, get: async (_account, path, signal) => { calls.push(path); return handler(path, signal) } }
  return { path, index, calls, transport, sync: new GmailHistorySync(index, transport, projectGmailApiMessage) }
}

describe('durable Gmail history synchronization', () => {
  it('replays paginated additions, off-head label moves and deletions; deduplicates message reads', async () => {
    const f = fixture(path => {
      if (path === 'history?startHistoryId=100&maxResults=500') return { history: [{ id: '110', messagesAdded: [{ message: { id: 'new' } }], labelsRemoved: [{ message: { id: 'old' } }], messages: [{ id: 'new' }] }], nextPageToken: 'two', historyId: '150' }
      if (path.includes('pageToken=two')) return { history: [{ id: '120', messagesDeleted: [{ message: { id: 'deleted' } }], labelsAdded: [{ message: { id: 'new' } }] }], historyId: '150' }
      if (path.includes('/deleted?')) throw new GmailApiError(404, 'message_not_found')
      return message(path.includes('/old?') ? 'old' : 'new', path.includes('/old?') ? [] : ['INBOX'])
    })
    f.index.replaceAccount(account.id, [projectGmailApiMessage(message('deleted', ['SENT']), account)], 'seed', false)
    await f.sync.synchronize(account, new AbortController().signal)
    expect(f.index.historyCheckpoint(account.id, account.email)).toBe('150')
    expect(f.index.messages(account.id).find(row => row.id === 'old')).toMatchObject({ inArchive: true, inInbox: false, unread: false, hasAttachment: true })
    expect(f.index.messages(account.id).map(row => row.id).sort()).toEqual(['new', 'old'])
    expect(f.calls.filter(path => path === 'messages/new?format=full')).toHaveLength(1)
    expect(f.calls.some(path => path.startsWith('messages?'))).toBe(false)
  })

  it('loads the exact checkpoint after restart without rescanning the mailbox', async () => {
    const f = fixture(() => ({ historyId: '9007199254740993999' }))
    await f.sync.synchronize(account, new AbortController().signal)
    indexes.splice(indexes.indexOf(f.index), 1); f.index.close()
    const restarted = new GmailIndex(f.path); indexes.push(restarted)
    expect(restarted.historyCheckpoint(account.id, account.email)).toBe('9007199254740993999')
    const calls: string[] = []
    await new GmailHistorySync(restarted, { connected: async () => true, get: async (_a, path) => { calls.push(path); return { historyId: '9007199254740994000' } } }, projectGmailApiMessage).synchronize(account, new AbortController().signal)
    expect(calls).toEqual(['history?startHistoryId=9007199254740993999&maxResults=500'])
  })

  it('captures a baseline before scanning and catches changes made while the scan runs', async () => {
    const f = fixture(path => {
      if (path === 'profile') return { emailAddress: account.email, historyId: '200' }
      if (path.startsWith('messages?')) return { messages: [{ id: 'old' }] }
      if (path.startsWith('history?startHistoryId=100')) throw new GmailApiError(404, 'history_expired')
      if (path.startsWith('history?startHistoryId=200')) return { historyId: '220', history: [{ id: '210', messagesAdded: [{ message: { id: 'during-scan' } }] }] }
      return message(path.includes('/old?') ? 'old' : 'during-scan')
    })
    await f.sync.synchronize(account, new AbortController().signal)
    expect(f.calls.slice(0, 3)).toEqual(['history?startHistoryId=100&maxResults=500', 'profile', 'messages?includeSpamTrash=true&maxResults=500'])
    expect(f.index.messages(account.id).map(row => row.id).sort()).toEqual(['during-scan', 'old'])
    expect(f.index.historyCheckpoint(account.id, account.email)).toBe('220')
  })

  it('uses metadata for cached immutable messages, retains their attachment hint, and accepts an omitted empty label list', async () => {
    const f = fixture(path => {
      if (path === 'profile') return { emailAddress: account.email, historyId: '200' }
      if (path.startsWith('messages?')) return { messages: [{ id: 'old' }, { id: 'new' }] }
      if (path.startsWith('history?startHistoryId=100')) throw new GmailApiError(404, 'history_expired')
      if (path.startsWith('history?')) return { historyId: '220' }
      if (path === 'messages/old?format=metadata') return { ...message('old'), labelIds: undefined, payload: { headers: message('old').payload.headers } }
      return message('new')
    })
    await f.sync.synchronize(account, new AbortController().signal)
    expect(f.calls).toContain('messages/old?format=metadata')
    expect(f.calls).toContain('messages/new?format=full')
    expect(f.index.messages(account.id).find(row => row.id === 'old')).toMatchObject({ inArchive: true, inInbox: false, unread: false, hasAttachment: true })
  })

  it('retains cached rows and the old checkpoint when an expired-history replacement scan fails', async () => {
    const f = fixture(path => {
      if (path.startsWith('history?')) throw new GmailApiError(404, 'history_expired')
      if (path === 'profile') return { emailAddress: account.email, historyId: '200' }
      if (path.startsWith('messages?')) return { messages: [{ id: 'new' }] }
      throw new GmailApiError(503, 'gmail_read_failed')
    })
    await expect(f.sync.synchronize(account, new AbortController().signal)).rejects.toThrow('503')
    expect(f.index.historyCheckpoint(account.id, account.email)).toBe('100')
    expect(f.index.messages(account.id).map(row => row.id)).toEqual(['old'])
  })

  it('resumes a rate-limited baseline after restart, publishes catch-up changes atomically, and removes staging', async () => {
    const ids = ['one', 'two', 'three', 'four', 'five', 'six']
    let limited = true
    const f = fixture(path => {
      if (path === 'profile') return { emailAddress: account.email, historyId: '200' }
      if (path.startsWith('messages?')) return { messages: ids.map(id => ({ id })) }
      if (path.startsWith('history?startHistoryId=100')) throw new GmailApiError(404, 'history_expired')
      if (path.startsWith('history?startHistoryId=200')) return { historyId: '220', history: [{ id: '210', labelsRemoved: [{ message: { id: 'one' } }], messagesAdded: [{ message: { id: 'during-scan' } }] }] }
      const id = path.split('/')[1]!.split('?')[0]!
      if (id === 'six' && limited) throw new GmailApiError(429, 'gmail_backoff')
      return message(id, limited ? ['INBOX'] : [])
    })
    await expect(f.sync.synchronize(account, new AbortController().signal)).rejects.toThrow('429')
    expect(f.index.historyCheckpoint(account.id, account.email)).toBe('100')
    expect(f.index.messages(account.id).map(row => row.id)).toEqual(['old'])
    expect(f.index.historyBaseline(account.id, account.email)?.pending).toEqual(['six'])
    f.index.close(); indexes.splice(indexes.indexOf(f.index), 1)
    limited = false
    f.calls.length = 0
    const restarted = new GmailIndex(f.path); indexes.push(restarted)
    await new GmailHistorySync(restarted, f.transport, projectGmailApiMessage).synchronize(account, new AbortController().signal)
    expect(f.calls).not.toContain('profile')
    expect(f.calls.some(path => path.startsWith('messages?'))).toBe(false)
    expect(f.calls.filter(path => path.startsWith('messages/')).sort()).toEqual(['messages/six?format=full', 'messages/one?format=full', 'messages/during-scan?format=full'].sort())
    expect(restarted.messages(account.id).map(row => row.id).sort()).toEqual([...ids, 'during-scan'].sort())
    expect(restarted.messages(account.id).find(row => row.id === 'one')).toMatchObject({ inInbox: false, inArchive: true })
    expect(restarted.historyCheckpoint(account.id, account.email)).toBe('220')
    expect(restarted.historyBaseline(account.id, account.email)).toBeUndefined()
  })

  it('does not publish a staged baseline if catch-up fails, and retries only catch-up', async () => {
    let failed = true
    const f = fixture(path => {
      if (path === 'profile') return { emailAddress: account.email, historyId: '200' }
      if (path.startsWith('messages?')) return { messages: [{ id: 'new' }] }
      if (path.startsWith('messages/')) return message('new')
      if (failed) throw new GmailApiError(503, 'gmail_read_failed')
      return { historyId: '220' }
    }, false)
    await expect(f.sync.synchronize(account, new AbortController().signal)).rejects.toThrow('503')
    expect(f.index.messages()).toEqual([])
    expect(f.index.historyCheckpoint(account.id, account.email)).toBeUndefined()
    failed = false; f.calls.length = 0
    await f.sync.synchronize(account, new AbortController().signal)
    expect(f.calls).toEqual(['history?startHistoryId=200&maxResults=500'])
    expect(f.index.messages().map(row => row.id)).toEqual(['new'])
  })

  it('discards an expired staged baseline without publishing it and starts a fresh scan on retry', async () => {
    let expired = true
    const f = fixture(path => {
      if (path === 'profile') return { emailAddress: account.email, historyId: expired ? '200' : '300' }
      if (path.startsWith('messages?')) return { messages: [{ id: expired ? 'old' : 'new' }] }
      if (path.startsWith('messages/')) return message(expired ? 'old' : 'new')
      if (expired) throw new GmailApiError(404, 'history_expired')
      return { historyId: '320' }
    }, false)
    await expect(f.sync.synchronize(account, new AbortController().signal)).rejects.toThrow('history_expired')
    expect(f.index.messages()).toEqual([])
    expect(f.index.historyBaseline(account.id, account.email)).toBeUndefined()
    expired = false
    await f.sync.synchronize(account, new AbortController().signal)
    expect(f.index.messages().map(row => row.id)).toEqual(['new'])
  })

  it('keeps completed staging when publishing the baseline encounters a storage failure', async () => {
    const f = fixture(path => path === 'profile' ? { emailAddress: account.email, historyId: '200' }
      : path.startsWith('messages?') ? { messages: [{ id: 'new' }] }
        : path.startsWith('messages/') ? message('new') : { historyId: '220' }, false)
    const db = new DatabaseSync(f.path)
    db.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON gmail_history_checkpoint BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    await expect(f.sync.synchronize(account, new AbortController().signal)).rejects.toThrow('disk failure')
    expect(f.index.messages()).toEqual([])
    expect(f.index.historyBaseline(account.id, account.email)?.messages).toHaveLength(1)
    db.exec('DROP TRIGGER reject_checkpoint'); db.close()
    f.calls.length = 0
    await f.sync.synchronize(account, new AbortController().signal)
    expect(f.calls).toEqual(['history?startHistoryId=200&maxResults=500'])
    expect(f.index.historyBaseline(account.id, account.email)).toBeUndefined()
  })

  it.each(['rate limit', 'cancelled'])('does not advance a checkpoint or publish half a batch after %s', async kind => {
    const controller = new AbortController()
    const f = fixture(path => {
      if (path.startsWith('history?')) return { historyId: '200', history: [{ id: '110', messages: [{ id: 'new' }, { id: 'broken' }] }] }
      if (path.includes('/broken?')) { if (kind === 'cancelled') controller.abort(); throw new GmailApiError(429, 'gmail_backoff') }
      return message('new')
    })
    await expect(f.sync.synchronize(account, controller.signal)).rejects.toThrow()
    expect(f.index.historyCheckpoint(account.id, account.email)).toBe('100')
    expect(f.index.messages(account.id).map(row => row.id)).toEqual(['old'])
  })

  it.each(['missing historyId', 'backwards checkpoint', 'pagination cycle', 'invalid message'])('rejects %s without committing', async kind => {
    const f = fixture(path => {
      if (path.startsWith('messages/')) return { ...message('new'), labelIds: 'INBOX' }
      if (kind === 'missing historyId') return {}
      if (kind === 'backwards checkpoint') return { historyId: '90' }
      if (kind === 'pagination cycle') return { historyId: '200', nextPageToken: 'loop' }
      return { historyId: '200', history: [{ id: '110', messages: [{ id: 'new' }] }] }
    })
    await expect(f.sync.synchronize(account, new AbortController().signal)).rejects.toThrow()
    expect(f.index.historyCheckpoint(account.id, account.email)).toBe('100')
  })

  it('never treats a changed label as an archive/delete rollback while a local command is pending', async () => {
    const f = fixture(path => path.startsWith('history?') ? { historyId: '200', history: [{ id: '110', labelsAdded: [{ message: { id: 'old' } }] }] } : message('old'))
    f.index.applyConversationAction(account.id, ['old'], 'archive', true)
    await f.sync.synchronize(account, new AbortController().signal)
    expect(f.index.messages(account.id)[0]).toMatchObject({ inInbox: false, inArchive: true })
    expect(f.index.pendingActions()).toHaveLength(1)
  })

  it('rolls back rows, checkpoints and in-memory overlays together on a storage failure', async () => {
    const f = fixture(() => ({}))
    f.index.setUnread(account.id, ['old'], false)
    const db = new DatabaseSync(f.path)
    db.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON gmail_history_checkpoint WHEN NEW.history_id='300' BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    expect(() => f.index.applyHistory(account.id, account.email, [projectGmailApiMessage(message('old', ['INBOX']), account)], [], '300')).toThrow('disk failure')
    expect(f.index.historyCheckpoint(account.id, account.email)).toBe('100')
    db.close()
    f.index.replaceAccount(account.id, [projectGmailApiMessage(message('old'), account)], 'stale', false)
    expect(f.index.messages(account.id)[0]?.unread).toBe(false)
  })

  it('rejects a Gmail identity mismatch before touching the cached mailbox', async () => {
    const f = fixture(() => ({ emailAddress: 'another@example.com', historyId: '200' }), false)
    await expect(f.sync.synchronize(account, new AbortController().signal)).rejects.toThrow('does not match')
    expect(f.index.historyCheckpoint(account.id, account.email)).toBeUndefined()
    expect(f.index.messages()).toEqual([])
  })

  it('leaves the connector path explicit for an account without direct authorization', async () => {
    const f = fixture(() => { throw new Error('must not call Gmail REST') })
    await expect(new GmailHistorySync(f.index, { ...f.transport, connected: async () => false }, projectGmailApiMessage).synchronize(account, new AbortController().signal)).resolves.toBe(false)
    expect(f.calls).toEqual([])
  })
  it('persists an explicit return to connector sync without deleting mail or the history checkpoint', async () => {
    const f = fixture(() => { throw new Error('must not call Gmail REST') })
    f.index.setDirectSyncEnabled(account.id, false)
    const restarted = new GmailIndex(f.path); indexes.push(restarted)
    expect(restarted.directSyncDisabled(account.id)).toBe(true)
    expect(restarted.messages(account.id).map(row => row.id)).toEqual(['old'])
    expect(restarted.historyCheckpoint(account.id, account.email)).toBe('100')
    const disabled = new GmailHistorySync(restarted, { connected: async () => { throw new Error('must not require OAuth') }, get: f.transport.get }, projectGmailApiMessage)
    await expect(disabled.synchronize(account, new AbortController().signal)).resolves.toBe(false)
    expect(f.calls).toEqual([])
  })

  it('refreshes authorized mail even while the Codex connector inventory is unavailable', async () => {
    const f = fixture(() => ({ historyId: '200' }))
    const server = createServer((_request, response) => { response.statusCode = 503; response.end('{}') })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: f.path, historyTransport: f.transport })
    try {
      await provider.refreshNow()
      expect(provider.syncStatus()).toMatchObject({ state: 'ready', error: null })
      expect(f.index.historyCheckpoint(account.id, account.email)).toBe('200')
    } finally { provider.stopBackgroundSync(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('commits a healthy account even when another account fails during full synchronization', async () => {
    const f = fixture(() => ({}))
    const second = { ...account, id: 'two', email: 'second@example.com' }
    f.index.replaceAccounts([account, second], 'now')
    f.index.applyHistory(second.id, second.email, [projectGmailApiMessage(message('second-message'), second)], [], '100')
    const server = createServer((_request, response) => { response.statusCode = 503; response.end('{}') })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const transport = { ...f.transport, get: async (a: IndexedGmailAccount) => { if (a.id === account.id) throw new GmailApiError(429, 'gmail_backoff'); return { historyId: '200' } } }
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: f.path, historyTransport: transport })
    try {
      await expect(provider.syncNow()).rejects.toThrow('work@example.com')
      expect(f.index.historyCheckpoint(account.id, account.email)).toBe('100')
      expect(f.index.historyCheckpoint(second.id, second.email)).toBe('200')
      expect(provider.syncStatus()).toMatchObject({ state: 'failed', accountsCompleted: 1 })
    } finally { provider.stopBackgroundSync(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('removes only permanently deleted IDs from a pending command', async () => {
    const f = fixture(path => {
      if (path.startsWith('history?')) return { historyId: '200', history: [{ id: '110', messagesDeleted: [{ message: { id: 'gone' } }] }] }
      throw new GmailApiError(404, 'message_not_found')
    })
    f.index.replaceAccount(account.id, [projectGmailApiMessage(message('gone'), account)], 'seed', false)
    f.index.applyConversationAction(account.id, ['old', 'gone'], 'archive', true)
    await f.sync.synchronize(account, new AbortController().signal)
    expect(f.index.pendingActions()[0]?.messageIds).toEqual(['old'])
    expect(f.index.messages(account.id).map(row => row.id)).toEqual(['old'])
  })
})
