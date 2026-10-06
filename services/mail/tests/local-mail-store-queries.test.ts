import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LocalMailStore } from '../src/local-mail-store.js'
import { projectDraft } from '../src/draft.js'
import type { DraftSaveJob } from '../src/draft-save-queue.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function job(id: string, state: DraftSaveJob['state'], accountId = 'one', extra: Partial<DraftSaveJob> = {}): DraftSaveJob {
  return { id, state, accountId, messageId: '', fields: { bodyMarkdown: 'Retained text' },
    draft: projectDraft({ id, accountId, inReplyToMessageId: '', to: [], subject: id, bodyMarkdown: 'Retained text',
      attachments: [{ name: 'retained.txt', mediaType: 'text/plain', contentBase64: 'YWJj' }] }),
    revision: 1, retryAt: 0, attempts: 0, reconnect: false, createdAt: '2026-10-07T01:00:00Z', ...extra }
}
it('selects pending work, cancellation cleanup and remote aliases without losing saved drafts', () => {
  const store = new LocalMailStore(':memory:'); cleanup.push(() => store.close())
  for (const entry of [job('saved', 'saved', 'one', { remoteId: 'remote' }), job('pending', 'pending'), job('failed', 'failed'),
    job('cleanup', 'cancelled'), job('done', 'cancelled', 'one', { cleanupDone: true }), job('other', 'saved', 'two', { remoteId: 'remote' })]) store.putDraftSave(entry)
  expect(store.draftSaves({ accountId: 'one', states: ['pending', 'failed'] }).map(job => job.id)).toEqual(['pending', 'failed'])
  expect(store.draftSaves({ unfinished: true }).map(job => job.id)).toEqual(['pending', 'cleanup'])
  expect(store.draftSaves({ states: ['cancelled'], cleanupPending: true }).map(job => job.id)).toEqual(['cleanup'])
  expect(store.draftSaves({ accountId: 'one', remoteId: 'remote', states: ['saved'] }).map(job => job.id)).toEqual(['saved'])
  expect(store.draftSaves({ states: [] })).toEqual([])
  expect(store.draftSave('one', 'saved')?.draft.attachments[0]?.contentBase64).toBe('YWJj')
  store.putDraftSave(job('pending', 'saved', 'one', { remoteId: 'new-remote' }))
  expect(store.draftSaves({ states: ['pending'] })).toEqual([])
  expect(store.draftSaves({ accountId: 'one', remoteId: 'new-remote' })[0]?.state).toBe('saved')
})
it('adds query indexes to the original three-column store and retains recovery across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-draft-query-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'mail.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec('CREATE TABLE draft_saves(account_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,id))')
  legacy.prepare('INSERT INTO draft_saves VALUES(?,?,?)').run('one', 'legacy', JSON.stringify(job('legacy', 'pending')))
  legacy.close()
  let store = new LocalMailStore(path)
  expect(store.draftSaves({ states: ['pending'] })[0]?.draft.bodyMarkdown).toBe('Retained text')
  store.putDraftSave(job('legacy', 'saved', 'one', { remoteId: 'confirmed' })); store.close()
  store = new LocalMailStore(path); cleanup.push(() => store.close())
  expect(store.draftSaves({ states: ['pending'] })).toEqual([])
  expect(store.draftSaves({ accountId: 'one', remoteId: 'confirmed' })[0]?.draft.attachments[0]?.contentBase64).toBe('YWJj')
})
