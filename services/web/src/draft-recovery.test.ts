import { expect, it } from 'vitest'
import { DraftRecovery, type RecoveryDraft } from './draft-recovery.js'
import type { DraftProjection } from './contracts.js'

const LEGACY_KEY = 'dispatch.editor-recovery.v1'

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>()
  beforeSet?: (key: string, value: string) => void
  beforeRemove?: (key: string) => void
  failNextSet?: (key: string) => boolean
  get length(): number { return this.#values.size }
  clear(): void { this.#values.clear() }
  getItem(key: string): string | null { return this.#values.get(key) ?? null }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null }
  removeItem(key: string): void {
    const hook = this.beforeRemove
    this.beforeRemove = undefined
    hook?.(key)
    this.#values.delete(key)
  }
  setItem(key: string, value: string): void {
    if (this.failNextSet?.(key)) throw new Error('Quota exceeded')
    const hook = this.beforeSet
    this.beforeSet = undefined
    hook?.(key, value)
    this.#values.set(key, String(value))
  }
}

function record(key: string, revision = 1, bodyMarkdown = `text ${revision}`): Omit<RecoveryDraft, 'attachments'> {
  return {
    key, updatedAt: `2026-09-30T00:00:0${Math.min(revision, 9)}Z`, revision,
    accountId: 'account', gmailDraftId: '', inReplyToMessageId: '', to: 'person@example.com', cc: '', bcc: '',
    subject: key, bodyMarkdown,
  }
}

it('clears only an acknowledged revision and preserves a newer checkpoint', () => {
  const storage = new MemoryStorage()
  const recovery = new DraftRecovery(storage)
  recovery.save(record('copy', 1, 'First text'), [])
  recovery.save(record('copy', 2, 'Newer text'), [])
  recovery.bindGmailIdentity('copy', 'account', 'gmail-id')
  recovery.removeSavedRevision('copy', 1)
  expect(recovery.list()[0]).toMatchObject({ gmailDraftId: 'gmail-id', revision: 2, bodyMarkdown: 'Newer text' })
  recovery.removeSavedRevision('copy', 2)
  expect(recovery.list()).toEqual([])
})

it('preserves interleaved saves for different drafts in separate windows', () => {
  const storage = new MemoryStorage()
  const windowA = new DraftRecovery(storage)
  const windowB = new DraftRecovery(storage)
  storage.beforeSet = () => windowB.save(record('draft-B'), [])
  windowA.save(record('draft-A'), [])
  expect(new Set(windowA.list().map(item => item.key))).toEqual(new Set(['draft-A', 'draft-B']))
})

it('keeps a newer revision saved while an older revision is being removed in another window', () => {
  const storage = new MemoryStorage()
  const windowA = new DraftRecovery(storage)
  const windowB = new DraftRecovery(storage)
  windowA.save(record('draft', 1), [])
  storage.beforeRemove = () => windowB.save(record('draft', 2, 'Typed during cleanup'), [])
  windowA.removeSavedRevision('draft', 1)
  expect(windowA.list()).toMatchObject([{ key: 'draft', revision: 2, bodyMarkdown: 'Typed during cleanup' }])
})

it('compacts acknowledgments while retaining the highest saved revision', () => {
  const storage = new MemoryStorage()
  const recovery = new DraftRecovery(storage)
  recovery.removeSavedRevision('draft', 1)
  recovery.removeSavedRevision('draft', 3)
  recovery.removeSavedRevision('draft', 2)
  const acknowledgments = [...Array.from({ length: storage.length }, (_, index) => storage.key(index)!)].filter(key => key.startsWith('dispatch.editor-recovery.v2.ack:'))
  expect(acknowledgments).toHaveLength(1)
  expect(acknowledgments[0]).toMatch(/:3$/)
})

it('migrates the legacy array after copying records and preserves attachment recovery metadata', () => {
  const storage = new MemoryStorage()
  const legacy = [{ ...record('legacy-draft', 4, 'Keep this text'), gmailDraftId: 'draft-4', gmailThreadId: 'thread-4', attachments: [
    { name: 'report.txt', mediaType: 'text/plain', sizeLabel: '12 B', blobKey: 'stored-file' },
    { name: 'pending.txt', mediaType: 'text/plain', contentPending: true },
  ] }]
  const raw = JSON.stringify(legacy)
  storage.setItem(LEGACY_KEY, raw)
  const recovery = new DraftRecovery(storage)
  expect(recovery.list()).toMatchObject([{ key: 'legacy-draft', revision: 4, bodyMarkdown: 'Keep this text', attachments: legacy[0]!.attachments }])
  expect(storage.getItem(LEGACY_KEY)).toBeNull()
})

it('persists the original editor baseline without copying attachment bytes into localStorage', () => {
  const storage = new MemoryStorage()
  const recovery = new DraftRecovery(storage)
  const base: DraftProjection = {
    id: 'gmail-draft', accountId: 'account', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Before',
    bodyMarkdown: 'Original text', bodyText: 'Original text', bodyHtml: '<p>Original text</p>', state: 'draft',
    attachments: [{ id: 'file-1', name: 'existing.txt', mediaType: 'text/plain', contentBase64: 'c2VjcmV0LWJ5dGVz' }],
  }
  recovery.save({ ...record('with-base'), base }, [])
  expect(recovery.list()[0]?.base).toMatchObject({ id: 'gmail-draft', bodyMarkdown: 'Original text' })
  expect(recovery.list()[0]?.base?.attachments[0]).not.toHaveProperty('contentBase64')
})

it('recovers queued-draft attachment intent and its baseline after restart', () => {
  const recovery = new DraftRecovery(new MemoryStorage())
  const base: DraftProjection = {
    id: 'queued-draft', accountId: 'account', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Subject',
    bodyMarkdown: 'Before', bodyText: 'Before', bodyHtml: '', state: 'draft', attachments: [],
  }
  recovery.save({ ...record('queued'), gmailDraftId: 'queued-draft', base, attachmentsChanged: false }, [])
  expect(recovery.list()[0]).toMatchObject({
    gmailDraftId: 'queued-draft', attachmentsChanged: false, base: { id: 'queued-draft', attachments: [] },
  })
})

it('keeps both versions of a conflict and its queue revision through crash recovery', () => {
  const storage = new MemoryStorage()
  const recovery = new DraftRecovery(storage)
  const base: DraftProjection = {
    id: 'gmail-draft', accountId: 'account', gmailThreadId: 'thread-9', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: 'Base',
    bodyMarkdown: 'Original', bodyText: 'Original', bodyHtml: '', state: 'draft', attachments: [{ id: 'base-file', name: 'base.txt', mediaType: 'text/plain', contentBase64: 'YmFzZQ==' }],
  }
  const remote: DraftProjection = { ...base, subject: 'Changed in Gmail', bodyMarkdown: 'Remote text', bodyText: 'Remote text', attachments: [{ id: 'remote-file', name: 'remote.txt', mediaType: 'text/plain', contentBase64: 'cmVtb3Rl' }] }
  recovery.save({ ...record('conflict', 12, 'My local text'), gmailThreadId: 'thread-9', accountId: 'account', base, draftRevision: 9, conflict: { fields: ['bodyMarkdown', 'subject'], remote } }, [])
  expect(recovery.list()[0]).toMatchObject({ revision: 12, bodyMarkdown: 'My local text', draftRevision: 9,
    accountId: 'account', gmailThreadId: 'thread-9', base: { bodyMarkdown: 'Original', attachments: [{ id: 'base-file' }] },
    conflict: { fields: ['bodyMarkdown', 'subject'], remote: { bodyMarkdown: 'Remote text', subject: 'Changed in Gmail', attachments: [{ id: 'remote-file' }] } } })
  expect(recovery.list()[0]?.base?.attachments[0]).not.toHaveProperty('contentBase64')
  expect(recovery.list()[0]?.conflict?.remote.attachments[0]).not.toHaveProperty('contentBase64')
})

it('keeps the legacy source intact when migration cannot copy it', () => {
  const storage = new MemoryStorage()
  const raw = JSON.stringify([{ ...record('legacy-draft'), attachments: [] }])
  storage.setItem(LEGACY_KEY, raw)
  storage.failNextSet = key => key.startsWith('dispatch.editor-recovery.v2.record:')
  const recovery = new DraftRecovery(storage)
  expect(() => recovery.list()).toThrow(/original data is still intact|has not been changed/i)
  expect(storage.getItem(LEGACY_KEY)).toBe(raw)
})

it('leaves malformed legacy recovery visible and untouched', () => {
  const storage = new MemoryStorage()
  const raw = '{bad json'
  storage.setItem(LEGACY_KEY, raw)
  const recovery = new DraftRecovery(storage)
  expect(() => recovery.list()).toThrow(/cannot be read.*has not been changed/i)
  expect(storage.getItem(LEGACY_KEY)).toBe(raw)
})

it('forgets a Gmail draft id that Gmail no longer knows so the next sync recreates the draft', () => {
  const recovery = new DraftRecovery(new MemoryStorage())
  recovery.save({ ...record('ghost'), gmailDraftId: '', gmailThreadId: 'thread-1' }, [])
  recovery.bindGmailIdentity('ghost', 'account', 'stale-draft', 'thread-1')
  expect(recovery.list()[0]).toMatchObject({ gmailDraftId: 'stale-draft', gmailThreadId: 'thread-1' })
  recovery.clearGmailIdentity('ghost', 'account')
  expect(recovery.list()[0]).toMatchObject({ gmailDraftId: '', bodyMarkdown: 'text 1' })
  recovery.bindGmailIdentity('ghost', 'account', 'fresh-draft')
  expect(recovery.list()[0]).toMatchObject({ gmailDraftId: 'fresh-draft' })
})
