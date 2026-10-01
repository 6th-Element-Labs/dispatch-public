import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { GmailConnectorProvider } from '../src/gmail-provider.js'
import { ResumeClock } from '../src/resume-clock.js'
import { createMailServer } from '../src/server.js'

const message = (id: string) => ({ id, thread_id: id, from_: 'test@example.com', subject: id, labels: ['INBOX'], email_ts: '2026-09-12T00:00:00Z' })

it('detects a sleep gap and the background service requests wake refresh without a window', async () => {
  vi.useFakeTimers()
  const clock = new ResumeClock(1000)
  expect(clock.observe(6000)).toBe(false)
  expect(clock.observe(8 * 3600_000)).toBe(true)
  const p = new GmailConnectorProvider('http://127.0.0.1:1', { indexPath: ':memory:' })
  vi.spyOn(p, 'syncNow').mockResolvedValue()
  const refresh = vi.spyOn(p, 'requestRefresh').mockImplementation(() => {})
  try {
    p.startBackgroundSync()
    await vi.advanceTimersByTimeAsync(5000)
    vi.setSystemTime(Date.now() + 8 * 3600_000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(refresh).toHaveBeenCalledWith('wake')
  } finally { p.stopBackgroundSync(); vi.restoreAllMocks(); vi.useRealTimers() }
})

it('publishes healthy Inbox results before another account or folder finishes', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let releaseTail!: () => void
  const tail = new Promise<void>(resolve => { releaseTail = resolve })
  const agent = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'slow', email: 'slow@example.com' }, { linkId: 'fast', email: 'fast@example.com' }] })); return }
    if (input.linkId === 'slow') { res.end(JSON.stringify({ isError: true, structuredContent: { error: 'RATE_LIMITED' } })); return }
    if (!input.labelIds.includes('INBOX')) await gate
    if (input.labelIds.includes('SPAM')) await tail
    res.end(JSON.stringify({ structuredContent: { emails: input.labelIds.includes('INBOX') ? [message('fresh')] : input.labelIds.includes('SENT') ? [{ ...message('fresh'), labels: ['SENT'] }] : [] } }))
  })
  await new Promise<void>(resolve => agent.listen(0, '127.0.0.1', resolve))
  const p = new GmailConnectorProvider(`http://127.0.0.1:${(agent.address() as AddressInfo).port}`, { indexPath: ':memory:' })
  const running = p.refreshNow().catch(error => error)
  try {
    await expect.poll(async () => (await p.listMailboxConversations('inbox', 'all', 'fast')).map(row => row.subject)).toEqual(['fresh'])
    expect(p.syncStatus()?.state).toBe('syncing')
    release()
    await expect.poll(() => p.syncStatus()?.pagesFetched).toBe(4)
    expect((await p.listMailboxConversations('inbox', 'all', 'fast'))[0]?.subject).toBe('fresh')
    releaseTail(); expect(String(await running)).toMatch(/^Error: slow@example\.com: .*RATE_LIMITED/)
    expect((await p.listMailboxConversations('inbox', 'all', 'fast'))[0]?.subject).toBe('fresh')
  } finally { release(); releaseTail(); await running; p.stopBackgroundSync(); await new Promise<void>(resolve => agent.close(() => resolve())) }
})

const FOLDERS = ['INBOX', 'UNREAD', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'ARCHIVE']
/** Every minute: the 7 folders plus the Inbox-and-Unread check, by ID only. */
const CHECKS = [...FOLDERS.slice(0, 2), 'INBOX+UNREAD', ...FOLDERS.slice(2)]
type FakeMail = { id: string; labels: string[]; email_ts: string; order?: number }
const mail = (id: string, labels: string[], hour = 0): FakeMail => ({ id, labels, email_ts: `2026-09-12T${String(hour).padStart(2, '0')}:00:00Z` })
type DetailCall = { folder: string; max: number; token: string }

/**
 * A fake agent over labelled mail. Folders follow INDEX_STREAMS, pages are newest first and
 * `pageSize` long (tokens are offsets), and modify changes labels.
 */
async function gmailAgent() {
  const state = {
    mail: [] as FakeMail[], accounts: ['one'], pageSize: {} as Record<string, number>,
    calls: { ids: [] as string[], details: [] as DetailCall[] },
    idsGate: undefined as Promise<void> | undefined,
    inboxGate: undefined as Promise<void> | undefined,
    afterDetails: undefined as ((folder: string) => void) | undefined,
  }
  const has = (item: FakeMail, label: string) => item.labels.includes(label)
  const inFolder = (item: FakeMail, folder: string) => folder === 'SPAM' ? has(item, 'SPAM')
    : folder === 'TRASH' ? has(item, 'TRASH')
      : folder === 'ARCHIVE' ? !['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH'].some(label => has(item, label))
        : folder === 'INBOX+UNREAD' ? has(item, 'INBOX') && has(item, 'UNREAD') && !has(item, 'SPAM') && !has(item, 'TRASH')
          : has(item, folder) && !has(item, 'TRASH') && (folder === 'SENT' || folder === 'DRAFT' || !has(item, 'SPAM'))
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: state.accounts.map(linkId => ({ linkId, email: `${linkId}@example.com` })) })); return }
    const labels = (input.labelIds as string[] | undefined) ?? []
    const folder = labels.length ? labels.join('+') : 'ARCHIVE'
    // Gmail lists by its own internal date, which a message's email_ts need not follow.
    const all = state.mail.filter(item => inFolder(item, folder)).sort((a, b) => (b.order ?? 0) - (a.order ?? 0) || b.email_ts.localeCompare(a.email_ts))
    const offset = Number(input.nextPageToken || 0)
    const size = Math.min(input.maxResults ?? 50, state.pageSize[folder] ?? 50)
    const page = all.slice(offset, offset + size)
    const next_page_token = offset + (state.pageSize[folder] ?? 50) < all.length ? String(offset + (state.pageSize[folder] ?? 50)) : ''
    if (req.url === '/v1/connectors/gmail/search') {
      state.calls.ids.push(folder); if (state.idsGate) await state.idsGate
      res.end(JSON.stringify({ structuredContent: { message_ids: page.map(item => item.id), next_page_token } })); return
    }
    if (req.url === '/v1/connectors/gmail/search-messages') {
      state.calls.details.push({ folder, max: input.maxResults, token: input.nextPageToken ?? '' }); if (folder === 'INBOX' && state.inboxGate) await state.inboxGate
      const emails = page.map(item => ({ id: item.id, thread_id: item.id, from_: 'test@example.com', subject: item.id, labels: [...item.labels], email_ts: item.email_ts }))
      state.afterDetails?.(folder)
      res.end(JSON.stringify({ structuredContent: { emails, next_page_token } })); return
    }
    if (req.url === '/v1/connectors/gmail/modify') {
      for (const item of state.mail.filter(candidate => input.messageIds.includes(candidate.id))) item.labels = [...item.labels.filter(label => !input.removeLabels.includes(label)), ...input.addLabels.filter((label: string) => !item.labels.includes(label))]
      res.end(JSON.stringify({ structuredContent: { responses: input.messageIds.map((id: string) => state.mail.some(item => item.id === id)
        ? { message_id: id, success: true }
        : { message_id: id, success: false, error: 'HttpError 404: Requested entity was not found.' }) } })); return
    }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    state, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    reset: () => { state.calls.ids.length = 0; state.calls.details.length = 0 },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
const inbox = async (p: GmailConnectorProvider, mailbox: 'inbox' | 'archive' = 'inbox') => (await p.listMailboxConversations(mailbox, 'all')).map(row => [row.subject, row.unread])

it('reads only messages the index lacks, and only as far down the page as they go', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX', 'UNREAD'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    // An empty index reads every folder in detail once.
    await p.refreshNow()
    expect(g.state.calls).toEqual({ ids: [], details: FOLDERS.map(folder => ({ folder, max: 50, token: '' })) })

    g.reset(); await p.refreshNow()
    expect(g.state.calls).toEqual({ ids: CHECKS, details: [] })

    // New mail, and the first message read on another device: one message read, nothing else.
    g.state.mail = [mail('second', ['INBOX', 'UNREAD'], 1), mail('first', ['INBOX'])]
    g.reset(); await p.refreshNow()
    expect(g.state.calls.details).toEqual([{ folder: 'INBOX', max: 1, token: '' }])
    expect(await inbox(p)).toEqual([['second', true], ['first', false]])
    expect(p.syncStatus()?.state).toBe('ready')

    // Refresh still reads every folder.
    g.reset(); await p.refreshNow({ details: true })
    expect(g.state.calls.details.map(call => call.folder)).toEqual(FOLDERS)
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('never re-reads a folder whose IDs have not changed, however old its copy', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX', 'UNREAD'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.refreshNow(); await p.refreshNow()
    vi.setSystemTime(Date.now() + 24 * 3600_000); g.reset(); await p.refreshNow()
    expect(g.state.calls).toEqual({ ids: CHECKS, details: [] })
  } finally { vi.useRealTimers(); p.stopBackgroundSync(); await g.close() }
})

it('moves mail between folders from their IDs, reading only a message a folder did not show', async () => {
  const g = await gmailAgent()
  g.state.mail = [mail('newest', ['INBOX'], 3), mail('moved', ['INBOX'], 2), mail('older', ['INBOX'], 1), mail('oldest', ['INBOX'], 0)]
  g.state.pageSize.INBOX = 3
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.syncNow(); await p.refreshNow()
    // Archived on another device: Inbox's first page loses it, Archive's gains it.
    g.state.mail[1]!.labels = []
    g.reset(); await p.refreshNow()
    expect(g.state.calls.details).toEqual([{ folder: 'ARCHIVE', max: 1, token: '' }])
    expect(await inbox(p)).toEqual([['newest', false], ['older', false], ['oldest', false]])
    expect(await inbox(p, 'archive')).toEqual([['moved', false]])
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('keeps Inbox read state right beyond the first page of Unread, without reading mail', async () => {
  const g = await gmailAgent()
  g.state.mail = [mail('newer', ['INBOX', 'UNREAD'], 1), mail('older', ['INBOX', 'UNREAD'], 0)]
  g.state.pageSize.UNREAD = 1
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.syncNow(); await p.refreshNow()
    g.state.mail[1]!.labels = ['INBOX']
    g.reset(); await p.refreshNow()
    expect(g.state.calls.details).toEqual([])
    expect(await inbox(p)).toEqual([['newer', true], ['older', false]])
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('judges a message gone from a first page by Gmail\'s order, not by its date', async () => {
  const g = await gmailAgent()
  // Gmail's order: a, b, c, then late, whose own date header claims to be the newest.
  g.state.mail = [{ ...mail('a', ['INBOX'], 4), order: 4 }, { ...mail('b', ['INBOX'], 3), order: 3 }, { ...mail('c', ['INBOX'], 2), order: 2 }, { ...mail('late', ['INBOX'], 9), order: 1 }]
  g.state.pageSize.INBOX = 3
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.syncNow(); await p.refreshNow()
    g.state.mail.push({ ...mail('new', ['INBOX'], 5), order: 5 })
    await p.refreshNow()
    expect((await inbox(p)).map(([subject]) => subject).sort()).toEqual(['a', 'b', 'c', 'late', 'new'])
    // b archived elsewhere: it was high on the page, so its absence means it left.
    g.state.mail.find(item => item.id === 'b')!.labels = []
    await p.refreshNow()
    expect((await inbox(p)).map(([subject]) => subject).sort()).toEqual(['a', 'c', 'late', 'new'])
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('removes mail deleted in Gmail, so later actions on its thread do not carry a dead ID', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('kept', ['INBOX'], 1), mail('binned', ['TRASH'])]
  g.state.mail[1]!.id = 'binned'
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.refreshNow(); await p.refreshNow()
    // Trash emptied in Gmail.
    g.state.mail = g.state.mail.filter(item => item.id !== 'binned')
    await p.refreshNow()
    expect(p.syncStatus()?.messageCount).toBe(1)
    // A change naming a message Gmail no longer has still completes.
    await p.mutateConversation('one', 'kept', ['kept', 'gone-already'], 'archive')
    await p.flushActions()
    expect(p.syncStatus()?.state).not.toBe('partial')
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('re-checks a folder when a change landed between reading a message and listing the folder', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.refreshNow(); await p.refreshNow()
    // New unread mail is read from Inbox; before Unread is listed, it is read on the phone.
    g.state.mail.unshift(mail('second', ['INBOX', 'UNREAD'], 1))
    g.state.afterDetails = folder => { if (folder === 'INBOX') { g.state.mail[0]!.labels = ['INBOX']; g.state.afterDetails = undefined } }
    await p.refreshNow()
    await p.refreshNow()
    expect(await inbox(p)).toEqual([['second', false], ['first', false]])
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('drops a message Gmail no longer has when a change to it comes back not found', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('kept', ['INBOX'], 1), mail('purged', ['TRASH'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.refreshNow()
    g.state.mail = g.state.mail.filter(item => item.id !== 'purged')
    await p.mutateConversation('one', 'purged', ['purged'], 'inbox')
    await p.flushActions()
    expect(await inbox(p)).toEqual([['kept', false]])
    expect(p.syncStatus()?.messageCount).toBe(1)
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('still sees mail leave a paged folder in the refresh after a change made in Dispatch', async () => {
  const g = await gmailAgent()
  // Archive's first page holds newer mail, so b archived lands past it and is never read.
  g.state.mail = [mail('a', ['INBOX', 'UNREAD'], 4), mail('b', ['INBOX'], 3), mail('c', ['INBOX'], 2), mail('d', ['INBOX'], 1), mail('e', ['INBOX'], 0), mail('z1', [], 9), mail('z2', [], 8)]
  g.state.pageSize.INBOX = 3
  g.state.pageSize.ARCHIVE = 2
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.syncNow(); await p.refreshNow(); await p.refreshNow()
    // b is archived on the phone while a is read in Dispatch.
    g.state.mail[1]!.labels = []
    g.reset(); await p.setConversationUnread('one', 'a', false, ['a'])
    await expect.poll(() => g.state.calls.ids.length === CHECKS.length && p.syncStatus()?.state === 'ready', { timeout: 5_000 }).toBe(true)
    expect((await inbox(p)).map(([subject]) => subject)).toEqual(['a', 'c', 'd', 'e'])
  } finally { p.stopBackgroundSync(); await g.close() }
}, 15_000)

it('shows mail marked unread elsewhere between being read and Unread being listed', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.refreshNow(); await p.refreshNow()
    g.state.mail.unshift(mail('second', ['INBOX'], 1))
    g.state.afterDetails = folder => { if (folder === 'INBOX') { g.state.mail[0]!.labels = ['INBOX', 'UNREAD']; g.state.afterDetails = undefined } }
    await p.refreshNow()
    await p.refreshNow()
    expect(await inbox(p)).toEqual([['second', true], ['first', false]])
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('does not let the minute refresh abort a full sync, however long it runs', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  let release!: () => void
  try {
    await p.refreshNow()
    g.state.idsGate = new Promise<void>(resolve => { release = resolve })
    g.reset()
    const full = p.syncNow().catch(error => error)
    await expect.poll(() => g.state.calls.ids.length).toBe(1)
    vi.setSystemTime(Date.now() + 10 * 60_000)
    p.requestRefresh('periodic')
    g.state.idsGate = undefined; release()
    expect(await full).toBeUndefined()
  } finally { release?.(); vi.useRealTimers(); p.stopBackgroundSync(); await g.close() }
})

it('runs one ID-only full sync after launch, so the first refreshes can see mail that left', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX'])]
  const indexPath = join(mkdtempSync(join(tmpdir(), 'dispatch-launch-')), 'index.sqlite')
  const seed = new GmailConnectorProvider(g.base, { indexPath })
  await seed.refreshNow(); seed.stopBackgroundSync()
  const p = new GmailConnectorProvider(g.base, { indexPath, launchSyncDelayMs: 0 })
  try {
    g.reset(); p.startBackgroundSync()
    // The launch refresh checks CHECKS by ID; the full sync then pages the 7 folders by ID.
    await expect.poll(() => g.state.calls.ids.length, { timeout: 5_000 }).toBe(CHECKS.length + FOLDERS.length)
    await expect.poll(() => p.syncStatus()?.state).toBe('ready')
    expect(g.state.calls.details).toEqual([])
  } finally { p.stopBackgroundSync(); await g.close() }
}, 15_000)

it('a manual Refresh replaces a quick check that is already running', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  let release!: () => void
  try {
    await p.refreshNow()
    g.state.idsGate = new Promise<void>(resolve => { release = resolve })
    g.reset()
    const quick = p.refreshNow().catch(error => error)
    await expect.poll(() => g.state.calls.ids.length).toBe(1)
    g.state.idsGate = undefined
    p.requestRefresh('manual')
    await expect.poll(() => g.state.calls.details.map(call => call.folder)).toEqual(FOLDERS)
    release()
    expect((await quick).name).toBe('AbortError')
    await expect.poll(() => p.syncStatus()?.state).toBe('ready')
  } finally { release?.(); p.stopBackgroundSync(); await g.close() }
})

it('re-reads an account that left the Gmail inventory and came back', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX'])]; g.state.accounts = ['one', 'two']
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.refreshNow()
    g.state.accounts = ['one']; await p.refreshNow()
    expect(await p.listMailboxConversations('inbox', 'all', 'two')).toEqual([])
    g.state.accounts = ['one', 'two']; g.reset(); await p.refreshNow()
    expect(g.state.calls.details.map(call => call.folder)).toEqual(FOLDERS)
    expect((await p.listMailboxConversations('inbox', 'all', 'two')).map(row => row.subject)).toEqual(['first'])
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('confirms a read-state change made in Dispatch by reading just that message', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX', 'UNREAD'], 1), mail('old', ['INBOX'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.refreshNow()
    g.reset(); await p.setConversationUnread('one', 'first', false, ['first'])
    // The follow-up refresh runs a second after the change lands.
    await expect.poll(() => g.state.calls.details, { timeout: 5_000 }).toEqual([{ folder: 'INBOX', max: 1, token: '' }])
    await expect.poll(() => g.state.calls.ids.length === CHECKS.length && p.syncStatus()?.state === 'ready').toBe(true)
    // Marked unread again on another device: shown, because Gmail confirmed the change first.
    g.state.mail[0]!.labels = ['INBOX', 'UNREAD']
    await p.refreshNow()
    expect(await inbox(p)).toEqual([['first', true], ['old', false]])
    // A move needs no confirming read: both folders' IDs change.
    g.reset(); await p.mutateConversation('one', 'old', ['old'], 'archive')
    await expect.poll(() => g.state.calls.ids.length, { timeout: 5_000 }).toBe(CHECKS.length)
    expect(g.state.calls.details).toEqual([{ folder: 'ARCHIVE', max: 1, token: '' }])
  } finally { p.stopBackgroundSync(); await g.close() }
}, 15_000)

it('confirms a read-state change outside Inbox, so a later change on another device shows', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('kept', ['UNREAD'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.refreshNow()
    g.reset(); await p.setConversationUnread('one', 'kept', false, ['kept'])
    await expect.poll(() => g.state.calls.details, { timeout: 5_000 }).toEqual([{ folder: 'ARCHIVE', max: 1, token: '' }])
    await expect.poll(() => g.state.calls.ids.length === CHECKS.length && p.syncStatus()?.state === 'ready').toBe(true)
    g.state.mail[0]!.labels = ['UNREAD']
    await p.refreshNow()
    expect(await inbox(p, 'archive')).toEqual([['kept', true]])
  } finally { p.stopBackgroundSync(); await g.close() }
}, 15_000)

it('does not keep an Inbox copy read while a read-state change was landing', async () => {
  const g = await gmailAgent(); g.state.mail = [mail('first', ['INBOX', 'UNREAD'])]
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  let release!: () => void
  try {
    await p.refreshNow()
    // New mail sends the next check into a detailed Inbox read; hold it while the change lands.
    g.state.mail = [mail('second', ['INBOX'], 1), ...g.state.mail]
    g.state.inboxGate = new Promise<void>(resolve => { release = resolve })
    g.reset()
    const running = p.refreshNow()
    await expect.poll(() => g.state.calls.details.map(call => call.folder)).toEqual(['INBOX'])
    await p.setConversationUnread('one', 'first', false, ['first'])
    await p.flushActions()
    g.state.inboxGate = undefined; release(); await running
    g.reset()
    await expect.poll(() => g.state.calls.details.map(call => call.folder), { timeout: 5_000 }).toContain('INBOX')
    await expect.poll(async () => (await p.listMailboxConversations('inbox', 'all')).find(row => row.subject === 'first')?.unread).toBe(false)
  } finally { release?.(); p.stopBackgroundSync(); await g.close() }
}, 15_000)

it('a full sync of an indexed account lists IDs and reads only new or moved mail', async () => {
  const g = await gmailAgent()
  g.state.mail = [5, 4, 3, 2, 1].map(n => mail(`m${n}`, ['INBOX'], n))
  g.state.pageSize.INBOX = 2
  const p = new GmailConnectorProvider(g.base, { indexPath: ':memory:' })
  try {
    await p.syncNow()
    g.state.mail.unshift(mail('m6', ['INBOX'], 6))
    g.state.mail.find(item => item.id === 'm3')!.labels = []
    g.state.mail = g.state.mail.filter(item => item.id !== 'm1')
    g.reset(); await p.syncNow()
    expect(g.state.calls.details).toEqual([{ folder: 'INBOX', max: 1, token: '' }, { folder: 'ARCHIVE', max: 1, token: '' }])
    expect(g.state.calls.ids.filter(folder => folder === 'INBOX')).toHaveLength(2)
    expect(await inbox(p)).toEqual([['m6', false], ['m5', false], ['m4', false], ['m2', false]])
    expect(await inbox(p, 'archive')).toEqual([['m3', false]])
    expect(p.syncStatus()?.state).toBe('ready')
  } finally { p.stopBackgroundSync(); await g.close() }
})

it('rejects a Gmail ID search without message IDs instead of treating the folder as unchanged', async () => {
  let idsReply: unknown = { structuredContent: { next_page_token: '' } }
  const agent = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', email: 'test@example.com' }] })); return }
    if (req.url === '/v1/connectors/gmail/search') { res.end(JSON.stringify(idsReply)); return }
    res.end(JSON.stringify({ structuredContent: { emails: [message('only')], next_page_token: '' } }))
  })
  await new Promise<void>(resolve => agent.listen(0, '127.0.0.1', resolve))
  const p = new GmailConnectorProvider(`http://127.0.0.1:${(agent.address() as AddressInfo).port}`, { indexPath: ':memory:' })
  try {
    await p.refreshNow()
    await expect(p.refreshNow()).rejects.toThrow('Gmail ID search for test@example.com returned no message_ids')
    expect(p.syncStatus()?.state).toBe('failed')
    idsReply = { structuredContent: { message_ids: ['only'], next_page_token: '' } }
    await p.refreshNow()
    expect(p.syncStatus()?.state).toBe('ready')
  } finally { p.stopBackgroundSync(); agent.closeAllConnections(); await new Promise<void>(resolve => agent.close(() => resolve())) }
})

it('wake replaces a pre-sleep read without cancelling draft writes, and refresh returns 202', async () => {
  let entered!: () => void; let release!: () => void
  const firstRead = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let releaseWrite!: () => void; let writing!: () => void
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
  const writeStarted = new Promise<void>(resolve => { writing = resolve })
  let calls = 0
  const agent = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/connectors/gmail') { res.end(JSON.stringify({ accounts: [{ linkId: 'one', email: 'test@example.com' }] })); return }
    if (req.url?.endsWith('/drafts/update')) { writing(); await writeGate; res.end(JSON.stringify({ structuredContent: { id: 'd' } })); return }
    if (req.url?.endsWith('/drafts/list')) { res.end(JSON.stringify({ structuredContent: { drafts: [] } })); return }
    if (++calls === 1) { entered(); await gate; res.end(JSON.stringify({ structuredContent: { emails: [message('obsolete')] } })); return }
    res.end(JSON.stringify({ structuredContent: { emails: input.labelIds.includes('INBOX') ? [message('after-wake')] : [] } }))
  })
  await new Promise<void>(resolve => agent.listen(0, '127.0.0.1', resolve))
  const p = new GmailConnectorProvider(`http://127.0.0.1:${(agent.address() as AddressInfo).port}`, { indexPath: ':memory:' })
  const old = p.refreshNow().catch(error => error)
  await firstRead
  let writeSettled = false
  const updating = p.updateGmailDraft({ id: 'd', accountId: 'one', inReplyToMessageId: '', to: [], subject: 'Kept', bodyMarkdown: 'Keep my edits', bodyHtml: '<p>Keep my edits</p>', bodyText: 'Keep my edits', attachments: [], state: 'draft' }).then(result => { writeSettled = true; return result }, error => { writeSettled = true; return error })
  await writeStarted
  p.startBackgroundSync = () => {}
  const mail = createMailServer(p)
  await new Promise<void>(resolve => mail.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(mail.address() as AddressInfo).port}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'wake' }), signal: AbortSignal.timeout(1000) })
    expect(response.status).toBe(202)
    // A second detector joins the replacement even when the old scan was young.
    p.requestRefresh('wake')
    await p.refreshNow()
    expect(calls).toBe(8)
    expect((await old).name).toBe('AbortError')
    release()
    expect((await p.listMailboxConversations('inbox', 'all')).map(row => row.subject)).toEqual(['after-wake'])
    expect(p.syncStatus()?.state).toBe('ready')
    expect(writeSettled).toBe(false)
    releaseWrite(); expect((await updating).bodyMarkdown).toBe('Keep my edits')
  } finally { release(); releaseWrite(); await updating; await old; p.stopBackgroundSync(); mail.closeAllConnections(); await new Promise<void>(resolve => mail.close(() => resolve())); agent.closeAllConnections(); await new Promise<void>(resolve => agent.close(() => resolve())) }
})
