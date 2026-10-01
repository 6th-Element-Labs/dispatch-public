import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalMailStore } from '../src/local-mail-store.js'
import { GmailIndex, type IndexedGmailMessage } from '../src/gmail-index.js'
import { projectConversation } from '../src/conversation.js'
import { projectDraft } from '../src/draft.js'
import type { MessageProjection } from '../src/model.js'

const message = (accountId = 'one', id = 'm1'): MessageProjection => ({ id, threadId: 'thread', accountId, accountLabel: accountId, sender: { address: 'customer@example.com', name: 'Customer', initials: 'C' }, subject: 'Delivery', preview: 'Short preview', receivedAt: '2026-09-30T00:00:00Z', receivedLabel: 'Today', receivedFullLabel: 'Today', unread: false, body: { kind: 'sanitized-html', content: '<p>We agreed to September delivery with tracking code <strong>ZXQ-9817</strong>.</p>' }, attachments: [], labels: ['INBOX'], source: 'gmail' })
const indexed = (mail: MessageProjection, inInbox = true): IndexedGmailMessage => ({ ...mail, inInbox, inSent: false, inDrafts: false, inSpam: false, inTrash: !inInbox, inArchive: false })

it('finds downloaded full body phrases across restart and respects account/folder filters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-offline-search-'))
  const path = join(directory, 'local.sqlite')
  let store = new LocalMailStore(path)
  const index = new GmailIndex(':memory:')
  try {
    const inbox = message(), hidden = { ...message('one', 'trash'), body: { kind: 'plain-text' as const, content: 'secret-only-in-trash' }, labels: ['TRASH'] }
    const other = message('two')
    store.cache(projectConversation([inbox, hidden], 'gmail')); store.cache(projectConversation([other], 'gmail'))
    index.replaceAccount('one', [indexed(inbox), indexed(hidden, false)], 'run', true)
    index.replaceAccount('two', [indexed(other)], 'run', true)
    store.close(); store = new LocalMailStore(path)
    const bodyHits = store.searchCachedMessageIds(['September delivery'], 'one')
    expect(bodyHits).toEqual(new Set(['one:m1']))
    expect(index.searchDownloadedConversations('inbox', '"September delivery" from:customer@example.com', 'all', bodyHits, 'one').map(item => item.accountId)).toEqual(['one'])
    expect(index.searchDownloadedConversations('inbox', '"September delivery" from:other@example.com', 'all', bodyHits, 'one')).toEqual([])
    const trashHits = store.searchCachedMessageIds(['secret-only-in-trash'])
    expect(index.searchDownloadedConversations('inbox', 'secret-only-in-trash', 'all', trashHits)).toEqual([])
    expect(index.searchDownloadedConversations('trash', 'secret-only-in-trash', 'all', trashHits)).toHaveLength(1)
    store.cache(projectConversation([{ ...inbox, body: { kind: 'plain-text', content: 'Changed current body' } }], 'gmail'))
    expect(store.searchCachedMessageIds(['ZXQ-9817'], 'one')).toEqual(new Set())
  } finally { store.close(); index.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('backfills existing body caches and keeps conflict versions durably with bounded history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-cache-migration-'))
  const path = join(directory, 'local.sqlite')
  let store = new LocalMailStore(path)
  try {
    store.cache(projectConversation([message()], 'gmail')); store.close()
    const db = new DatabaseSync(path); db.exec("DROP TABLE downloaded_search; DELETE FROM local_state WHERE key='downloaded-search-v1'"); db.close()
    store = new LocalMailStore(path)
    expect(store.searchCachedMessageIds(['ZXQ-9817'])).toEqual(new Set(['one:m1']))
    const local = projectDraft({ id: 'd', accountId: 'one', inReplyToMessageId: '', to: [], subject: 'Local', bodyMarkdown: 'Local text' })
    const remote = { ...local, subject: 'Remote', bodyMarkdown: 'Remote text' }
    for (let i = 0; i < 102; i++) store.putConflictCopy('one', 'd', local, remote, 'use-remote')
    store.close(); store = new LocalMailStore(path)
    expect(store.conflictCopies('one')).toHaveLength(100)
    expect(store.conflictCopies('one')[0]).toMatchObject({ local: { bodyMarkdown: 'Local text' }, remote: { bodyMarkdown: 'Remote text' } })
    expect(store.conflictCopies('two')).toEqual([])
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
