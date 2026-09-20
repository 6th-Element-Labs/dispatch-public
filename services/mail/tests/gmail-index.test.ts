import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { GmailIndex, flagsAfterAction, folderFlagsFromLabels, type IndexedGmailMessage } from '../src/gmail-index.js'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

function message(
  id: string,
  unread: boolean,
  inInbox: boolean,
  extra: Partial<IndexedGmailMessage> = {},
): IndexedGmailMessage {
  return {
    id, threadId: `thread-${id}`, accountId: 'account-1', accountLabel: 'Work',
    sender: { name: 'Ana', address: 'ana@example.com', initials: 'A' }, subject: `Subject ${id}`,
    receivedAt: `2026-09-04T0${id === 'm1' ? '9' : '8'}:00:00Z`, receivedLabel: 'Sep 4, 9:00 AM',
    receivedFullLabel: 'September 4, 2026 at 9:00 AM', preview: 'Preview', unread, inInbox,
    inSent: false, inDrafts: false, inArchive: false, inSpam: false, inTrash: false,
    ...extra,
  }
}

describe('GmailIndex', () => {
  it('keeps unread archives out of Inbox across partial sync and restart, with a durable command', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-action-restart-'))
    directories.push(directory)
    const path = join(directory, 'gmail.sqlite')
    const first = new GmailIndex(path)
    const original = message('m1', true, true)
    first.replaceAccount('account-1', [original], 'one', true)
    first.applyConversationAction('account-1', ['m1'], 'archive', true)
    first.replaceAccount('account-1', [message('m2', false, true)], 'partial', false)
    first.close()
    const second = new GmailIndex(path)
    second.replaceAccount('account-1', [original], 'stale', false)
    expect(second.pendingActions()).toMatchObject([{ accountId: 'account-1', messageIds: ['m1'], action: 'archive' }])
    expect(second.conversations('unread')).toEqual([])
    expect(second.mailboxConversations('archive', 'unread')).toHaveLength(1)
    second.finishAction(second.pendingActions()[0]!.id)
    second.replaceAccount('account-1', [{ ...original, inInbox: false, inArchive: true }], 'confirmed', false)
    second.replaceAccount('account-1', [original], 'user-moved-back', false)
    expect(second.conversations('unread')).toHaveLength(1)
    second.close()
  })
  it('keeps an accepted folder action through a stale provider sync', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-index-action-'))
    directories.push(directory)
    const index = new GmailIndex(join(directory, 'gmail.sqlite'))
    index.beginSync('2026-09-04T09:00:00Z')
    index.replaceAccounts([{ id: 'account-1', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }], '2026-09-04T09:00:00Z')
    const inbox = message('m1', false, true)
    index.replaceAccount('account-1', [inbox], 'run-1', true)
    index.completeSync('2026-09-04T09:01:00Z')
    index.applyConversationAction('account-1', ['m1'], 'archive')
    expect(index.mailboxConversations('inbox', 'all', 'account-1')).toHaveLength(0)
    index.replaceAccount('account-1', [inbox], 'run-2', true)
    expect(index.mailboxConversations('inbox', 'all', 'account-1')).toHaveLength(0)
    expect(index.mailboxConversations('archive', 'all', 'account-1')).toHaveLength(1)
  })

  it('persists Gmail state and preserves All, Unread, and Read semantics', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-index-'))
    directories.push(directory)
    const path = join(directory, 'gmail.sqlite')
    const index = new GmailIndex(path)
    index.beginSync('2026-09-04T09:00:00Z')
    index.replaceAccounts([{ id: 'account-1', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }], '2026-09-04T09:00:00Z')
    index.replaceAccount('account-1', [message('m1', true, false), message('m2', false, true), message('m3', true, true)], 'run-1', true)
    index.completeSync('2026-09-04T09:01:00Z')
    expect(index.conversations('all')).toHaveLength(2)
    expect(index.conversations('unread').map((conversation) => conversation.latestMessageId)).toEqual(['m3'])
    expect(index.conversations('read')).toMatchObject([{ latestMessageId: 'm2', unread: false }])
    index.close()

    const reopened = new GmailIndex(path)
    expect(reopened.status()).toMatchObject({ state: 'ready', messageCount: 3, completedAt: '2026-09-04T09:01:00Z' })
    expect(reopened.messages()).toHaveLength(3)
    expect(reopened.accounts()).toMatchObject([{ id: 'account-1', email: 'work@example.com' }])
    reopened.close()
  })

  it('does not let a later account refresh restore an accepted unread write', () => {
    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [message('m1', true, true)], 'run-1', true)
    index.setUnread('account-1', ['m1'], false)
    expect(index.conversations('unread')).toHaveLength(0)
    index.replaceAccount('account-1', [message('m1', true, true)], 'run-2', true)
    expect(index.conversations('unread')).toHaveLength(0)
    expect(index.conversations('read')).toMatchObject([{ latestMessageId: 'm1', unread: false }])
    index.replaceAccount('account-1', [message('m1', false, true)], 'run-3', true)
    expect(index.conversations('read')).toMatchObject([{ latestMessageId: 'm1', unread: false }])
    index.replaceAccount('account-1', [message('m1', true, true)], 'run-4', true)
    expect(index.conversations('unread')).toMatchObject([{ latestMessageId: 'm1', unread: true }])
    index.close()
  })

  it('prunes records absent from a completed account refresh', () => {
    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [message('m1', true, false), message('m2', false, true)], 'run-1', true)
    index.replaceAccount('account-1', [message('m2', true, true)], 'run-2', true)
    expect(index.messages()).toMatchObject([{ id: 'm2', unread: true }])
    index.close()
  })

  it('removes records for disconnected Gmail accounts', () => {
    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [message('m1', true, false)], 'run-1', true)
    index.replaceAccount('account-2', [{ ...message('m2', false, true), accountId: 'account-2' }], 'run-1', true)
    index.pruneAccounts(['account-1'])
    expect(index.messages()).toMatchObject([{ accountId: 'account-1' }])
    index.close()
  })

  it('searches indexed Gmail fields and operators', () => {
    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [{ ...message('m1', true, true), hasAttachment: true }, message('m2', false, true), { ...message('m3', true, false), subject: 'Archived only' }], 'run-1', true)
    expect(index.searchConversations('from:ana', 'all')).toHaveLength(2)
    expect(index.searchConversations('subject:m1 has:attachment is:unread', 'all')).toHaveLength(1)
    expect(index.searchConversations('after:2026-09-04T08:30:00Z', 'all')).toHaveLength(1)
    expect(index.searchConversations('subject:Archived', 'all')).toHaveLength(0)
    expect(() => index.searchConversations('label:custom', 'all')).toThrow('Unsupported Gmail search operator')
    index.close()
  })

  it('derives exclusive archive from Gmail system labels', () => {
    expect(folderFlagsFromLabels(['INBOX', 'UNREAD'])).toEqual({
      inInbox: true, inSent: false, inDrafts: false, inArchive: false, inSpam: false, inTrash: false,
    })
    expect(folderFlagsFromLabels(['SENT'])).toMatchObject({ inSent: true, inArchive: false })
    expect(folderFlagsFromLabels(['UNREAD'])).toEqual({
      inInbox: false, inSent: false, inDrafts: false, inArchive: true, inSpam: false, inTrash: false,
    })
  })

  it('adds folder-flag columns to an existing in_inbox-only database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-index-'))
    directories.push(directory)
    const path = join(directory, 'gmail.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE gmail_messages (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        sender_initials TEXT NOT NULL,
        subject TEXT NOT NULL,
        received_at TEXT NOT NULL,
        received_label TEXT NOT NULL,
        received_full_label TEXT NOT NULL,
        preview TEXT NOT NULL,
        unread INTEGER NOT NULL,
        in_inbox INTEGER NOT NULL,
        has_attachment INTEGER NOT NULL DEFAULT 0,
        sync_run_id TEXT NOT NULL,
        PRIMARY KEY (account_id, id)
      );
    `)
    db.prepare(`
      INSERT INTO gmail_messages VALUES ('account-1','m1','thread-m1','Work','Ana','ana@example.com','A','Subject m1',
        '2026-09-04T09:00:00Z','Sep 4, 9:00 AM','September 4, 2026 at 9:00 AM','Preview',1,1,0,'run-old')
    `).run()
    db.close()

    const index = new GmailIndex(path)
    expect(index.messages()).toMatchObject([{
      id: 'm1', inInbox: true, inSent: false, inDrafts: false, inArchive: false, inSpam: false, inTrash: false,
    }])
    index.close()
  })

  it('keeps spam and trash out of All and Unread', () => {
    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [
      message('m1', true, true),
      message('m2', true, false, { inSpam: true, inArchive: false }),
      message('m3', true, false, { inTrash: true, inArchive: false }),
      message('m4', true, false, { inArchive: true }),
    ], 'run-1', true)
    expect(index.conversations('all').map((item) => item.latestMessageId).sort()).toEqual(['m1'])
    expect(index.conversations('unread').map((item) => item.latestMessageId).sort()).toEqual(['m1'])
    expect(index.mailboxConversations('spam', 'all').map((item) => item.latestMessageId)).toEqual(['m2'])
    expect(index.mailboxConversations('trash', 'unread').map((item) => item.latestMessageId)).toEqual(['m3'])
    index.close()
  })

  it('lists and searches Sent from inSent flags beyond a single page of ids', () => {
    const index = new GmailIndex(':memory:')
    const sent = Array.from({ length: 51 }, (_, offset) => message(
      `s${offset}`,
      false,
      false,
      {
        inSent: true,
        subject: offset === 0 ? 'Invoice 51' : `Sent ${offset}`,
        receivedAt: `2026-09-04T10:${String(offset).padStart(2, '0')}:00Z`,
      },
    ))
    index.replaceAccount('account-1', sent, 'run-1', true)
    expect(index.mailboxConversations('sent', 'all')).toHaveLength(51)
    expect(index.searchMailboxConversations('sent', 'subject:Invoice', 'all')).toMatchObject([
      { subject: 'Invoice 51' },
    ])
    index.close()
  })

  it('updates folder flags for archive, trash, spam, and inbox', () => {
    expect(flagsAfterAction({
      inInbox: true, inSent: false, inDrafts: false, inArchive: false, inSpam: false, inTrash: false,
    }, 'archive')).toEqual({
      inInbox: false, inSent: false, inDrafts: false, inArchive: true, inSpam: false, inTrash: false,
    })
    expect(flagsAfterAction({
      inInbox: true, inSent: true, inDrafts: false, inArchive: false, inSpam: false, inTrash: false,
    }, 'archive')).toMatchObject({ inInbox: false, inSent: true, inArchive: false })
    expect(flagsAfterAction({
      inInbox: true, inSent: true, inDrafts: false, inArchive: false, inSpam: false, inTrash: false,
    }, 'trash')).toMatchObject({ inTrash: true, inInbox: false, inSent: false, inDrafts: false, inArchive: false })

    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [message('m1', false, true)], 'run-1', true)
    index.applyConversationAction('account-1', ['m1'], 'archive')
    expect(index.mailboxConversations('archive', 'all')).toHaveLength(1)
    expect(index.conversations('all')).toHaveLength(0)
    index.applyConversationAction('account-1', ['m1'], 'inbox')
    expect(index.mailboxConversations('inbox', 'all')).toHaveLength(1)
    index.close()
  })

  it('clears drafts on send and deletes an orphan discarded draft', () => {
    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [
      message('draft-1', false, false, { inDrafts: true, subject: 'Draft' }),
      message('draft-2', false, false, { inDrafts: true, subject: 'Drop' }),
    ], 'run-1', true)
    index.markDraftsSent('account-1', ['draft-1'])
    expect(index.mailboxConversations('drafts', 'all')).toHaveLength(1)
    expect(index.mailboxConversations('sent', 'all')).toMatchObject([{ latestMessageId: 'draft-1' }])
    index.discardDraftMessages('account-1', ['draft-2'])
    expect(index.mailboxConversations('drafts', 'all')).toHaveLength(0)
    expect(index.messages().map((item) => item.id)).toEqual(['draft-1'])
    index.close()
  })

  it('suggests distinct indexed senders for recipient autocomplete', () => {
    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [
      message('m1', true, true),
      { ...message('m2', false, true), sender: { name: 'James Liu', address: 'james@example.com', initials: 'JL' } },
    ], 'run-1', true)
    expect(index.recipients('jam')).toEqual([{ name: 'James Liu', address: 'james@example.com', initials: 'JL' }])
    expect(index.recipients('')).toHaveLength(2)
    index.close()
  })
})

describe('GmailIndex reconcileStream', () => {
  it('drops the drafts flag and the row when Gmail no longer lists a draft, without touching other folders', () => {
    const index = new GmailIndex(':memory:')
    index.replaceAccount('account-1', [
      message('d1', false, false, { inDrafts: true }),
      message('d2', false, false, { inDrafts: true }),
      message('m1', true, true),
    ], 'run-1', false)
    expect(index.reconcileStream('account-1', 'drafts', ['d2'], 'run-2')).toEqual({ cleared: 1, removed: 1 })
    expect(index.mailboxConversations('drafts', 'all', 'account-1').map((conversation) => conversation.latestMessageId)).toEqual(['d2'])
    expect(index.messages('account-1').map((item) => item.id).sort()).toEqual(['d2', 'm1'])
    expect(index.reconcileStream('account-1', 'unread', [], 'run-2')).toEqual({ cleared: 1, removed: 0 })
    expect(index.messages('account-1').find((item) => item.id === 'm1')?.unread).toBe(false)
    expect(index.reconcileStream('account-1', 'inbox', ['m1'], 'run-2')).toEqual({ cleared: 0, removed: 0 })
    // Rows upserted by the current run are never reconciled away.
    index.replaceAccount('account-1', [message('d3', false, false, { inDrafts: true })], 'run-3', false)
    expect(index.reconcileStream('account-1', 'drafts', [], 'run-3')).toEqual({ cleared: 1, removed: 1 })
    expect(index.messages('account-1').map((item) => item.id).sort()).toEqual(['d3', 'm1'])
  })
})

describe('folderFlagsFromLabels', () => {
  it('keeps a trashed or spammed draft out of Drafts, Inbox, and Sent', () => {
    expect(folderFlagsFromLabels(['DRAFT', 'TRASH'])).toMatchObject({ inDrafts: false, inTrash: true, inArchive: false })
    expect(folderFlagsFromLabels(['INBOX', 'UNREAD', 'SPAM'])).toMatchObject({ inInbox: false, inSpam: true })
    expect(folderFlagsFromLabels(['SENT', 'TRASH'])).toMatchObject({ inSent: false, inTrash: true })
    expect(folderFlagsFromLabels(['DRAFT'])).toMatchObject({ inDrafts: true, inTrash: false })
  })

  it('counts unread inbox conversations and total drafts and spam per thread', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-counts-'))
    directories.push(directory)
    const index = new GmailIndex(join(directory, 'index.sqlite'))
    index.replaceAccount('account-1', [
      message('m1', true, true, { threadId: 'shared' }),
      message('m2', true, true, { threadId: 'shared' }),
      message('m3', false, true),
      message('m4', true, false, { inDrafts: true }),
      message('m5', false, false, { inSpam: true }),
      message('m6', true, false, { inSpam: true }),
    ], 'run', true)
    index.replaceAccount('account-2', [message('m7', true, true, { accountId: 'account-2' })], 'run', true)
    expect(index.mailboxCounts()).toEqual({ inbox: 2, drafts: 1, spam: 2 })
    expect(index.mailboxCounts('account-1')).toEqual({ inbox: 1, drafts: 1, spam: 2 })
    index.close()
  })
})
