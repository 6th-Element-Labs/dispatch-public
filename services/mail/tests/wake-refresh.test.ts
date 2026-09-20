import { createServer } from 'node:http'
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
    releaseTail(); expect(String(await running)).toContain('RATE_LIMITED')
    expect((await p.listMailboxConversations('inbox', 'all', 'fast'))[0]?.subject).toBe('fresh')
  } finally { release(); releaseTail(); await running; p.stopBackgroundSync(); await new Promise<void>(resolve => agent.close(() => resolve())) }
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
