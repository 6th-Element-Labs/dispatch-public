import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftSaveQueue, type DraftSaveGateway, type DraftSaveJob } from '../src/draft-save-queue.js'
import { draftChanges, DraftConflictError } from '../src/draft-conflict.js'
import { LocalMailStore } from '../src/local-mail-store.js'
import { projectDraft } from '../src/draft.js'
import type { DraftProjection } from '../src/model.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-queued-draft-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let now = 0
  const path = join(dir, 'local.sqlite')
  let remote = projectDraft({ id: 'gmail-one', accountId: 'one', inReplyToMessageId: 'message', to: [{ address: 'old@example.com', name: 'Old', initials: 'O' }], cc: 'copy@example.com', subject: 'Subject', bodyMarkdown: 'Original text', attachments: [{ name: 'file.pdf', mediaType: 'application/pdf', contentBase64: 'YWJj' }] })
  const merge = (job: DraftSaveJob, current: DraftProjection): DraftProjection => {
    const attachments = [...(job.fields.attachments ?? current.attachments)]
    for (const intent of job.attachmentAppends ?? []) if (!intent.applied && !intent.cancelled) for (const file of intent.attachments) {
      if (!attachments.some(existing => existing.name === file.name && existing.mediaType === file.mediaType && existing.contentBase64 === file.contentBase64)) attachments.push(file)
    }
    return { ...projectDraft({ ...current, ...job.fields, attachments, to: job.fields.to === undefined ? current.to : [{ address: job.fields.to, name: 'Test', initials: 'T' }] }), id: 'gmail-one' }
  }
  const gateway: DraftSaveGateway = {
    create: vi.fn(async job => (remote = merge(job, projectDraft({ ...remote, attachments: [] })))),
    read: vi.fn(async () => remote), update: vi.fn(async (job, current) => (remote = merge(job, current))),
    discard: vi.fn(async () => undefined), findCreated: vi.fn(async () => 'gmail-one'),
  }
  const changed = vi.fn()
  let store = new LocalMailStore(path)
  let queue = new DraftSaveQueue(store, gateway, changed, () => now)
  cleanups.push(() => { queue.stop(); store.close() })
  return { gateway, changed, get queue() { return queue }, get store() { return store }, advance() { now += 60_001 },
    setRemote(value: DraftProjection) { remote = value }, get remote() { return remote }, restart() { queue.stop(); store.close(); store = new LocalMailStore(path); queue = new DraftSaveQueue(store, gateway, changed, () => now) } }
}
it('acknowledges locally before Gmail, survives revoked login and restart, and confirms the actual saved copy', async () => {
  const f = setup()
  vi.mocked(f.gateway.create).mockRejectedValueOnce(new Error('Transport send error: HTTP 401 token_revoked'))
  const draft = f.queue.enqueue('one', '', { to: 'new@example.com', subject: 'New', bodyMarkdown: 'Keep this text' })
  expect(draft).toMatchObject({ syncState: 'pending', bodyMarkdown: 'Keep this text' })
  await f.queue.flush()
  expect(await f.queue.read('one', draft.id)).toMatchObject({ syncState: 'pending', reconnectRequired: true })
  f.restart(); f.advance(); await f.queue.flush()
  expect(await f.queue.read('one', draft.id)).toMatchObject({ id: 'gmail-one', resolvedFromDraftId: draft.id, bodyMarkdown: 'Keep this text' })
  expect((await f.queue.read('one', draft.id)).syncState).toBeUndefined()
  expect(f.queue.pending()).toHaveLength(0)
})
it('does not acknowledge a draft when its initial durable queue write fails', () => {
  const f = setup(); f.queue.pause(true)
  vi.spyOn(f.store, 'putDraftSave').mockImplementationOnce(() => { throw new Error('disk full') })
  expect(() => f.queue.enqueue('one', '', { bodyMarkdown: 'Must be durable first' })).toThrow('disk full')
  expect(f.changed).not.toHaveBeenCalled()
  expect(f.queue.pending()).toHaveLength(0)
  expect(f.gateway.create).not.toHaveBeenCalled()
})
it('keeps the accepted pending command and retries if persistence fails after Gmail accepts it', async () => {
  const f = setup()
  const originalPut = f.store.putDraftSave.bind(f.store)
  let failSavedSnapshot = true
  vi.spyOn(f.store, 'putDraftSave').mockImplementation(job => {
    if (failSavedSnapshot && job.state === 'saved') { failSavedSnapshot = false; throw new Error('disk busy after provider acknowledgment') }
    originalPut(job)
  })
  const accepted = f.queue.enqueue('one', '', { bodyMarkdown: 'Durable accepted revision' })
  await f.queue.flush()
  expect(f.gateway.create).toHaveBeenCalledTimes(1)
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'pending', remoteId: 'gmail-one', fields: { bodyMarkdown: 'Durable accepted revision' }, retryAt: 3_000 })
  f.advance(); await f.queue.flush()
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'saved', remoteId: 'gmail-one', fields: { bodyMarkdown: 'Durable accepted revision' } })
  expect(f.remote.bodyMarkdown).toBe('Durable accepted revision')
})
it('preserves omitted recipients, body and attachment bytes for a partial update', async () => {
  const f = setup()
  const draft = f.queue.enqueue('one', '', { to: 'new@example.com' }, 'gmail-one')
  expect(f.queue.editorFields('one', draft.id, { to: 'new@example.com', bodyMarkdown: '', cc: '', attachments: [] })).toEqual({ to: 'new@example.com' })
  await f.queue.flush()
  expect(f.remote).toMatchObject({ to: [{ address: 'new@example.com' }], cc: 'copy@example.com', bodyMarkdown: 'Original text', attachments: [{ contentBase64: 'YWJj' }] })
})
it('verifies only editor fields changed from the remote baseline', async () => {
  const f = setup(); const base = f.remote
  f.setRemote({ ...base, subject: 'External Gmail subject' })
  const original = f.gateway.update
  f.gateway.update = vi.fn(async (job, current) => original({ ...job, fields: draftChanges(job.fields, job.base) }, current))
  const draft = f.queue.enqueue('one', '', {
    to: base.to.map(item => item.address).join(', '), cc: base.cc, bcc: base.bcc,
    subject: base.subject, bodyMarkdown: 'Local body edit', attachments: base.attachments,
  }, 'gmail-one', base)
  await f.queue.flush()
  expect(f.remote.subject).toBe('External Gmail subject')
  expect(f.remote.bodyMarkdown).toBe('Local body edit')
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ state: 'saved', base: { subject: 'External Gmail subject' } })
})
it('archives both conflict versions before keeping local edits against the captured Gmail version', async () => {
  const f = setup(); const base = f.remote; const remote = { ...base, bodyMarkdown: 'Gmail body edit', bodyHtml: '<p>Gmail body edit</p>', bodyText: 'Gmail body edit' }
  f.setRemote(remote)
  f.gateway.update = vi.fn(async () => { throw new DraftConflictError(['bodyMarkdown'], remote) })
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'Dispatch body edit' }, 'gmail-one', base)
  await f.queue.flush()
  const conflicted = f.store.draftSave('one', draft.id)!
  expect(conflicted).toMatchObject({ state: 'failed', conflictRemote: remote, conflictFields: ['bodyMarkdown'], draft: { bodyMarkdown: 'Dispatch body edit', conflict: { remote, fields: ['bodyMarkdown'] } } })
  f.queue.pause(true)
  const resolved = await f.queue.resolveConflict('one', draft.id, 'keep-local', draft.draftRevision)
  expect(resolved).toMatchObject({ syncState: 'pending', draftRevision: 2, bodyMarkdown: 'Dispatch body edit' })
  expect(resolved.conflict).toBeUndefined()
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ state: 'pending', base: remote, fields: { bodyMarkdown: 'Dispatch body edit' } })
  expect(f.store.draftSave('one', draft.id)?.conflictRemote).toBeUndefined()
  expect(f.store.conflictCopies('one')).toMatchObject([{ draftId: draft.id, choice: 'keep-local', local: { bodyMarkdown: 'Dispatch body edit' }, remote: { bodyMarkdown: 'Gmail body edit' } }])
})

it('keeps a newer local revision when a stale conflict resolution arrives, then can choose Gmail', async () => {
  const f = setup(); const base = f.remote; const remote = { ...base, subject: 'Gmail subject edit' }
  f.setRemote(remote)
  f.gateway.update = vi.fn(async () => { throw new DraftConflictError(['subject'], remote) })
  const draft = f.queue.enqueue('one', '', { subject: 'Dispatch subject edit' }, 'gmail-one', base)
  await f.queue.flush()
  f.queue.pause(true)
  const newer = f.queue.enqueue('one', '', { subject: 'Newer Dispatch subject' }, draft.id)
  await expect(f.queue.resolveConflict('one', draft.id, 'use-remote', draft.draftRevision)).rejects.toMatchObject({ code: 'draft_revision_changed' })
  expect(f.store.conflictCopies('one')).toHaveLength(0)
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ revision: 2, state: 'failed', fields: { subject: 'Newer Dispatch subject' } })
  const resolved = await f.queue.resolveConflict('one', draft.id, 'use-remote', newer.draftRevision)
  expect(resolved).toMatchObject({ subject: 'Gmail subject edit', resolvedFromDraftId: draft.id, draftRevision: 3 })
  expect(resolved.syncState).toBeUndefined()
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ revision: 3, state: 'saved', fields: {}, draft: { subject: 'Gmail subject edit' }, base: remote })
  expect(f.store.conflictCopies('one')).toMatchObject([{ choice: 'use-remote', local: { subject: 'Newer Dispatch subject' }, remote: { subject: 'Gmail subject edit' } }])
})
it('keeps conflicted edits and appends paused until an explicit resolution', async () => {
  const f = setup(); const base = f.remote; const remote = { ...base, bodyMarkdown: 'Gmail body edit' }
  f.setRemote(remote)
  const originalUpdate = f.gateway.update
  let updateCalls = 0
  f.gateway.update = vi.fn(async (job, current) => {
    if (++updateCalls === 1) throw new DraftConflictError(['bodyMarkdown'], remote)
    return originalUpdate(job, current)
  })
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'Dispatch body edit' }, 'gmail-one', base)
  await f.queue.flush()
  expect(f.store.draftSave('one', draft.id)?.state).toBe('failed')

  const sameAsGmail = f.queue.enqueue('one', '', { bodyMarkdown: remote.bodyMarkdown }, draft.id)
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ revision: 2, state: 'failed', conflictRemote: remote, fields: { bodyMarkdown: remote.bodyMarkdown } })
  const file = { name: 'conflicted.txt', mediaType: 'text/plain', contentBase64: 'Y29uZmxpY3RlZA==' }
  f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], 'conflicted-append', remote)
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ revision: 3, state: 'failed', conflictRemote: remote, attachmentAppends: [{ operationId: 'conflicted-append' }] })
  await f.queue.flush()
  expect(f.gateway.update).toHaveBeenCalledTimes(1)
  expect(f.store.draftSave('one', draft.id)?.state).toBe('failed')

  const resolved = await f.queue.resolveConflict('one', draft.id, 'keep-local', f.store.draftSave('one', draft.id)!.revision)
  expect(resolved.conflict).toBeUndefined()
  await f.queue.flush()
  expect(f.gateway.update).toHaveBeenCalledTimes(2)
  expect(f.store.draftSave('one', sameAsGmail.id)).toMatchObject({ state: 'saved', attachmentAppends: [{ operationId: 'conflicted-append', applied: true }] })
  expect(f.remote).toMatchObject({ bodyMarkdown: remote.bodyMarkdown, attachments: [...base.attachments, file] })
})
it('rejects conflict resolution when a newer local revision arrives during the fresh Gmail read', async () => {
  const f = setup(); const base = f.remote; const remote = { ...base, subject: 'Gmail subject edit' }
  f.setRemote(remote)
  f.gateway.update = vi.fn(async () => { throw new DraftConflictError(['subject'], remote) })
  const draft = f.queue.enqueue('one', '', { subject: 'Dispatch subject edit' }, 'gmail-one', base)
  await f.queue.flush()

  let release!: () => void; let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const readStarted = new Promise<void>(resolve => { started = resolve })
  const originalRead = f.gateway.read
  f.gateway.read = vi.fn(async (accountId, id) => { started(); await gate; return originalRead(accountId, id) })
  const resolving = f.queue.resolveConflict('one', draft.id, 'keep-local', draft.draftRevision)
  await readStarted
  const newer = f.queue.enqueue('one', '', { subject: 'Newer Dispatch subject' }, draft.id)
  release()
  await expect(resolving).rejects.toMatchObject({ code: 'draft_revision_changed' })
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ revision: newer.draftRevision, state: 'failed', fields: { subject: 'Newer Dispatch subject' }, conflictRemote: remote })
  expect(f.store.conflictCopies('one')).toHaveLength(0)
})
it('refreshes the conflict preview and rejects a choice after Gmail changes again', async () => {
  const f = setup(); const base = f.remote
  const preview = { ...base, subject: 'Gmail subject edit' }
  const changedAgain = { ...preview, cc: 'new-copy@example.com' }
  f.setRemote(preview)
  f.gateway.update = vi.fn(async () => { throw new DraftConflictError(['subject'], preview) })
  const draft = f.queue.enqueue('one', '', { subject: 'Dispatch subject edit' }, 'gmail-one', base)
  await f.queue.flush()
  f.setRemote(changedAgain)

  await expect(f.queue.resolveConflict('one', draft.id, 'keep-local', draft.draftRevision)).rejects.toMatchObject({ code: 'draft_revision_changed' })
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ revision: 2, state: 'failed', conflictRemote: changedAgain,
    conflictFields: ['subject', 'cc'], draft: { conflict: { remote: changedAgain, fields: ['subject', 'cc'] } } })
  expect(f.store.conflictCopies('one')).toHaveLength(0)
})
it('does not archive or resolve a conflict when the draft is cancelled during the fresh Gmail read', async () => {
  const f = setup(); const base = f.remote; const remote = { ...base, subject: 'Gmail subject edit' }
  f.setRemote(remote)
  f.gateway.update = vi.fn(async () => { throw new DraftConflictError(['subject'], remote) })
  const draft = f.queue.enqueue('one', '', { subject: 'Dispatch subject edit' }, 'gmail-one', base)
  await f.queue.flush()

  let release!: () => void; let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const readStarted = new Promise<void>(resolve => { started = resolve })
  const originalRead = f.gateway.read
  f.gateway.read = vi.fn(async (accountId, id) => { started(); await gate; return originalRead(accountId, id) })
  const resolving = f.queue.resolveConflict('one', draft.id, 'use-remote', draft.draftRevision)
  await readStarted
  await f.queue.discard('one', draft.id)
  release()
  await expect(resolving).rejects.toThrow('Draft was discarded')
  expect(f.store.conflictCopies('one')).toHaveLength(0)
  expect(f.store.draftSave('one', draft.id)?.state).toBe('cancelled')
})
it('keeps a newer editor revision submitted during a slow create and uses the same remote draft', async () => {
  const f = setup(); let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const original = f.gateway.create
  f.gateway.create = vi.fn(async job => { await gate; return original(job) })
  const first = f.queue.enqueue('one', '', { bodyMarkdown: 'First' })
  const flight = f.queue.flush()
  expect(f.queue.active).toBe(true)
  f.queue.enqueue('one', '', { bodyMarkdown: 'Newer edit' }, first.id)
  release(); await flight
  expect((await f.queue.read('one', first.id)).bodyMarkdown).toBe('Newer edit')
  expect((await f.queue.read('one', first.id)).syncState).toBeUndefined()
  expect(f.remote.bodyMarkdown).toBe('Newer edit')
  expect(f.gateway.create).toHaveBeenCalledTimes(1)
  expect(f.gateway.update).toHaveBeenCalledTimes(1)
})
it('uses a later draft revision accepted while an earlier same-account draft is blocked', async () => {
  const f = setup(); let release!: () => void; let started!: () => void
  const gate = new Promise<void>(r => { release = r }); const firstStarted = new Promise<void>(r => { started = r })
  const original = f.gateway.create; const created: string[] = []
  f.gateway.create = vi.fn(async job => {
    if (job.fields.bodyMarkdown === 'Slow first') { started(); await gate }
    created.push(job.fields.bodyMarkdown ?? '')
    return original(job)
  })
  f.queue.enqueue('one', '', { bodyMarkdown: 'Slow first' })
  const later = f.queue.enqueue('one', '', { bodyMarkdown: 'Original later draft' })
  const flight = f.queue.flush(); await firstStarted
  f.queue.enqueue('one', '', { bodyMarkdown: 'Newest accepted revision' }, later.id)
  release(); await flight
  expect(created).toEqual(['Slow first', 'Newest accepted revision'])
  expect(f.store.draftSave('one', later.id)).toMatchObject({ revision: 2, state: 'saved', fields: { bodyMarkdown: 'Newest accepted revision' } })
  expect(f.remote.bodyMarkdown).toBe('Newest accepted revision')
})
it('rebases a newer body edit onto its own confirmed write without a false conflict', async () => {
  const f = setup(); const base = f.remote
  let release!: () => void; let updateStarted!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { updateStarted = resolve })
  const originalUpdate = f.gateway.update; let hold = true
  f.gateway.update = vi.fn(async (job, current) => {
    const saved = await originalUpdate({ ...job, fields: draftChanges(job.fields, job.base) }, current)
    if (hold) { hold = false; updateStarted(); await gate }
    return saved
  })
  const first = f.queue.enqueue('one', '', { bodyMarkdown: 'First body edit' }, 'gmail-one', base)
  const flight = f.queue.flush(); await started
  f.queue.enqueue('one', '', { bodyMarkdown: 'Newer body edit' }, first.id, base)
  release(); await flight
  expect(f.remote.bodyMarkdown).toBe('Newer body edit')
  expect(f.store.draftSave('one', first.id)).toMatchObject({ state: 'saved', fields: { bodyMarkdown: 'Newer body edit' }, base: f.remote })
})
it('restores the original body when a newer edit reverts an in-flight body save', async () => {
  const f = setup(); const base = f.remote
  let release!: () => void; let updateStarted!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { updateStarted = resolve })
  const originalUpdate = f.gateway.update; let hold = true
  f.gateway.update = vi.fn(async (job, current) => {
    const saved = await originalUpdate({ ...job, fields: draftChanges(job.fields, job.base) }, current)
    if (hold) { hold = false; updateStarted(); await gate }
    return saved
  })
  const first = f.queue.enqueue('one', '', { bodyMarkdown: 'Temporary body' }, 'gmail-one', base)
  const flight = f.queue.flush(); await started
  f.queue.enqueue('one', '', { bodyMarkdown: base.bodyMarkdown }, first.id, base)
  release(); await flight
  expect(f.remote.bodyMarkdown).toBe(base.bodyMarkdown)
  expect(f.store.draftSave('one', first.id)).toMatchObject({ state: 'saved', fields: { bodyMarkdown: base.bodyMarkdown }, base: f.remote })
})
it('rechecks the latest revision after the provider read and skips a stale update', async () => {
  const f = setup(); let release!: () => void; let started!: () => void
  const gate = new Promise<void>(r => { release = r }); const readStarted = new Promise<void>(r => { started = r })
  const originalRead = f.gateway.read; const originalUpdate = f.gateway.update; let reads = 0
  f.gateway.read = vi.fn(async (accountId, id) => { if (++reads === 1) { started(); await gate }; return originalRead(accountId, id) })
  const updated: string[] = []
  f.gateway.update = vi.fn(async (job, current) => { updated.push(job.fields.bodyMarkdown ?? ''); return originalUpdate(job, current) })
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'Stale body' }, 'gmail-one', f.remote)
  const flight = f.queue.flush(); await readStarted
  f.queue.enqueue('one', '', { bodyMarkdown: 'Latest body' }, draft.id)
  release(); await flight
  expect(updated).toEqual(['Latest body'])
  expect(f.remote.bodyMarkdown).toBe('Latest body')
})
it('does not start a later draft cancelled while an earlier same-account draft is blocked', async () => {
  const f = setup(); let release!: () => void; let started!: () => void
  const gate = new Promise<void>(r => { release = r }); const firstStarted = new Promise<void>(r => { started = r })
  const original = f.gateway.create; const created: string[] = []
  f.gateway.create = vi.fn(async job => {
    if (job.fields.bodyMarkdown === 'Slow first') { started(); await gate }
    created.push(job.fields.bodyMarkdown ?? '')
    return original(job)
  })
  f.queue.enqueue('one', '', { bodyMarkdown: 'Slow first' })
  const later = f.queue.enqueue('one', '', { bodyMarkdown: 'Cancelled later draft' })
  const flight = f.queue.flush(); await firstStarted
  await f.queue.discard('one', later.id)
  release(); await flight
  expect(created).toEqual(['Slow first'])
  expect(f.store.draftSave('one', later.id)).toMatchObject({ state: 'cancelled', cleanupDone: true })
})
it('lets account B confirm a draft while account A is still waiting on Gmail', async () => {
  const f = setup(); let releaseA!: () => void; let startedB!: () => void
  const gateA = new Promise<void>(r => { releaseA = r }); const bStarted = new Promise<void>(r => { startedB = r })
  const remote = new Map<string, DraftProjection>()
  f.gateway.create = vi.fn(async job => {
    if (job.accountId === 'account-A') await gateA
    else startedB()
    const saved = projectDraft({ ...job.draft, id: `gmail-${job.accountId}` })
    remote.set(saved.id, saved)
    return saved
  })
  f.gateway.read = vi.fn(async (_account, id) => remote.get(id)!)
  const a = f.queue.enqueue('account-A', '', { bodyMarkdown: 'A is slow' })
  const b = f.queue.enqueue('account-B', '', { bodyMarkdown: 'B is independent' })
  const flight = f.queue.flush()
  await bStarted
  await vi.waitFor(() => expect(f.store.draftSave('account-B', b.id)?.state).toBe('saved'))
  expect(f.store.draftSave('account-A', a.id)).toMatchObject({ state: 'pending', started: true })
  releaseA(); await flight
})
it('lets an account-specific flush return while another account is still waiting on Gmail', async () => {
  const f = setup(); let releaseA!: () => void; let startedA!: () => void
  const gateA = new Promise<void>(r => { releaseA = r }); const aStarted = new Promise<void>(r => { startedA = r })
  const remote = new Map<string, DraftProjection>()
  f.gateway.create = vi.fn(async job => {
    if (job.accountId === 'account-A') { startedA(); await gateA }
    const saved = projectDraft({ ...job.draft, id: `gmail-${job.accountId}` })
    remote.set(saved.id, saved)
    return saved
  })
  f.gateway.read = vi.fn(async (_account, id) => remote.get(id)!)
  const a = f.queue.enqueue('account-A', '', { bodyMarkdown: 'A waits' })
  const aFlight = f.queue.flushAccount('account-A')
  await aStarted
  const b = f.queue.enqueue('account-B', '', { bodyMarkdown: 'B can finish' })
  await f.queue.flushAccount('account-B')
  expect(f.store.draftSave('account-B', b.id)?.state).toBe('saved')
  expect(f.store.draftSave('account-A', a.id)).toMatchObject({ state: 'pending', started: true })
  releaseA(); await aFlight
})
it('does not confirm an older body that only shares the requested prefix', async () => {
  const f = setup(); f.gateway.update = vi.fn(async () => f.remote)
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'Original' }, 'gmail-one')
  await f.queue.flush()
  expect((await f.queue.read('one', draft.id)).syncState).toBe('pending')
})
it('does not confirm body readback that lost paragraph breaks', async () => {
  const f = setup()
  f.gateway.read = vi.fn(async () => ({ ...f.remote, bodyMarkdown: 'First paragraph Second paragraph' }))
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'First paragraph\n\nSecond paragraph' })
  await f.queue.flush()
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ state: 'pending', error: 'Draft is saved on this device. Waiting for Gmail.' })
})
it('verifies attachment bytes and removal rather than trusting filenames', async () => {
  const f = setup(); f.gateway.update = vi.fn(async () => f.remote)
  const draft = f.queue.enqueue('one', '', { attachments: [{ name: 'file.pdf', mediaType: 'application/pdf', contentBase64: 'ZGlmZmVyZW50' }] }, 'gmail-one')
  await f.queue.flush(); expect((await f.queue.read('one', draft.id)).syncState).toBe('pending')
  f.queue.enqueue('one', '', { attachments: [] }, draft.id)
  await f.queue.flush(); expect((await f.queue.read('one', draft.id)).syncState).toBe('pending')
})
it('coalesces an identical pending create command instead of making two drafts', async () => {
  const f = setup()
  const first = f.queue.enqueue('one', 'message', { bodyMarkdown: 'Once' })
  expect(f.queue.enqueue('one', 'message', { bodyMarkdown: 'Once' }).id).toBe(first.id)
  await f.queue.flush(); expect(f.gateway.create).toHaveBeenCalledTimes(1)
})
it('cancels immediately while a save runs and removes only the exact created draft', async () => {
  const f = setup(); let release!: () => void
  const original = f.gateway.create; const gate = new Promise<void>(r => { release = r })
  f.gateway.create = vi.fn(async job => { await gate; return original(job) })
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'Cancelled' }); const saving = f.queue.flush()
  await f.queue.discard('one', draft.id)
  await expect(f.queue.read('one', draft.id)).rejects.toMatchObject({ code: 'gmail_draft_not_found' })
  release(); await saving
  expect(f.gateway.discard).toHaveBeenCalledExactlyOnceWith('one', 'gmail-one')
})
it('recovers cleanup after restart without creating a cancelled draft', async () => {
  const f = setup(); const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'Cancelled' })
  f.store.putDraftSave({ ...f.store.draftSave('one', draft.id)!, state: 'cancelled', started: true })
  f.restart(); await f.queue.flush()
  expect(f.gateway.findCreated).toHaveBeenCalledExactlyOnceWith('one', draft.id)
  expect(f.gateway.discard).toHaveBeenCalledExactlyOnceWith('one', 'gmail-one')
  expect(f.gateway.create).not.toHaveBeenCalled()
})
it('reclaims the newest pending revision after restart and skips an unstarted cancellation', async () => {
  const f = setup(); f.queue.pause(true)
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'First local revision' })
  f.queue.enqueue('one', '', { bodyMarkdown: 'Newest local revision' }, draft.id)
  const cancelled = f.queue.enqueue('two', '', { bodyMarkdown: 'Discard before start' })
  await f.queue.discard('two', cancelled.id)
  f.restart(); await f.queue.flush()
  expect(f.store.draftSave('one', draft.id)).toMatchObject({ revision: 2, state: 'saved', fields: { bodyMarkdown: 'Newest local revision' } })
  expect(f.store.draftSave('two', cancelled.id)).toMatchObject({ state: 'cancelled', cleanupDone: true })
  expect(f.gateway.create).toHaveBeenCalledTimes(1)
  expect(f.gateway.create).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'one', fields: { bodyMarkdown: 'Newest local revision' } }))
})

it('durably appends files by operation ID and confirms their bytes without changing the MIME body', async () => {
  const f = setup(); const operationId = 'append-1'
  const file = { name: 'new.txt', mediaType: 'text/plain', contentBase64: 'bmV3IGZpbGU=' }
  const before = f.remote
  const projection = f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], operationId, before)
  expect(projection).toMatchObject({ syncState: 'pending', attachments: [...before.attachments, file], bodyHtml: before.bodyHtml, bodyText: before.bodyText })
  const queued = f.store.draftSave('one', projection.id)!
  expect(queued.fields).toEqual({})
  expect(queued.attachmentAppends?.[0]).toMatchObject({ operationId, attachments: [file] })
  expect(queued.attachmentAppends?.[0]?.applied).toBeUndefined()
  await f.queue.flush()
  expect(f.remote.attachments).toEqual([...before.attachments, file])
  expect(f.store.draftSave('one', projection.id)).toMatchObject({ state: 'saved', attachmentAppends: [{ operationId, applied: true }] })
  const revision = f.store.draftSave('one', projection.id)!.revision
  f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], operationId, before)
  expect(f.store.draftSave('one', projection.id)!.revision).toBe(revision)
  expect(() => f.queue.enqueueAttachmentAppend('one', 'gmail-one', [{ ...file, contentBase64: 'ZGlmZmVyZW50' }], operationId, before)).toThrow('reused with different files')
})
it('does not turn a stale editor attachment list into removal while an append is in flight', async () => {
  const f = setup(); const base = f.remote
  const file = { name: 'queued.txt', mediaType: 'text/plain', contentBase64: 'cXVldWVk' }
  let releaseUpdate!: () => void; let updateStarted!: () => void
  const gate = new Promise<void>(resolve => { releaseUpdate = resolve })
  const started = new Promise<void>(resolve => { updateStarted = resolve })
  const originalUpdate = f.gateway.update
  let holdFirstUpdate = true
  f.gateway.update = vi.fn(async (job, current) => {
    const saved = await originalUpdate({ ...job, fields: draftChanges(job.fields, job.base) }, current)
    if (holdFirstUpdate) { holdFirstUpdate = false; updateStarted(); await gate }
    return saved
  })
  const appended = f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], 'stale-editor-race', base)
  const flight = f.queue.flush(); await started
  const edited = f.queue.enqueue('one', '', { bodyMarkdown: 'Editor body after append', attachments: base.attachments }, appended.id)
  releaseUpdate(); await flight
  expect(f.remote.bodyMarkdown).toBe('Editor body after append')
  expect(f.remote.attachments).toEqual([...base.attachments, file])
  expect(f.store.draftSave('one', edited.id)).toMatchObject({ revision: 2, state: 'saved', base: f.remote })
})
it('removes an appended file when the editor baseline included that file', async () => {
  const f = setup(); const original = f.remote
  const file = { name: 'remove-me.txt', mediaType: 'text/plain', contentBase64: 'cmVtb3Zl' }
  const appended = f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], 'append-then-remove', original)
  await f.queue.flush()
  const editorBase = f.remote
  expect(editorBase.attachments).toEqual([...original.attachments, file])
  f.queue.enqueue('one', '', { attachments: original.attachments }, appended.id, editorBase)
  await f.queue.flush()
  expect(f.remote.attachments).toEqual(original.attachments)
  expect(f.store.draftSave('one', appended.id)?.state).toBe('saved')
})
it('keeps a queued-create append through stale full editor autosaves before and after create acknowledgment', async () => {
  const f = setup()
  let releaseCreate!: () => void; let createStarted!: () => void; let releaseAppend!: () => void; let appendStarted!: () => void
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve }); const createWait = new Promise<void>(resolve => { createStarted = resolve })
  const appendGate = new Promise<void>(resolve => { releaseAppend = resolve }); const appendWait = new Promise<void>(resolve => { appendStarted = resolve })
  const originalCreate = f.gateway.create; const originalUpdate = f.gateway.update
  f.gateway.create = vi.fn(async job => { createStarted(); await createGate; return originalCreate(job) })
  let holdAppend = true
  f.gateway.update = vi.fn(async (job, current) => {
    const saved = await originalUpdate({ ...job, fields: draftChanges(job.fields, job.base) }, current)
    if (holdAppend) { holdAppend = false; appendStarted(); await appendGate }
    return saved
  })
  const created = f.queue.enqueue('one', 'message', { bodyMarkdown: 'Create body', attachments: [] }, undefined, undefined, 'queued-append-create')
  const flight = f.queue.flush(); await createWait
  const file = { name: 'created-append.txt', mediaType: 'text/plain', contentBase64: 'YXBwZW5k' }
  f.queue.enqueueAttachmentAppend('one', created.id, [file], 'queued-create-append')
  f.queue.enqueue('one', 'message', { bodyMarkdown: 'Create body', attachments: [] }, created.id)
  releaseCreate(); await appendWait
  expect(f.store.draftSave('one', created.id)?.remoteId).toBe('gmail-one')
  // The editor still posts its original complete attachments list after the create got a remote ID.
  f.queue.enqueue('one', 'message', { bodyMarkdown: 'Create body', attachments: [] }, created.id)
  releaseAppend(); await flight
  expect(f.remote.attachments).toEqual([file])
  expect(f.store.draftSave('one', created.id)).toMatchObject({ state: 'saved', attachmentAppends: [{ operationId: 'queued-create-append', applied: true }] })
})
it('keeps a saved queued-create append against the original editor baseline but accepts a deliberate removal against the confirmed baseline', async () => {
  const f = setup()
  const originalBase = projectDraft({ id: 'local-compose', accountId: 'one', inReplyToMessageId: 'message', to: [], subject: 'Subject', bodyMarkdown: 'Create body', attachments: [] })
  const created = f.queue.enqueue('one', 'message', { bodyMarkdown: 'Create body', attachments: [] }, undefined, originalBase, 'queued-append-after-save')
  await f.queue.flush()
  const file = { name: 'saved-append.txt', mediaType: 'text/plain', contentBase64: 'YXBwZW5k' }
  f.queue.enqueueAttachmentAppend('one', created.id, [file], 'queued-append-after-save', originalBase)
  await f.queue.flush()
  expect(f.store.draftSave('one', created.id)).toMatchObject({ state: 'saved', attachmentAppends: [{ applied: true }] })
  expect(f.remote.attachments).toEqual([file])

  // The editor still has the original queued-draft snapshot. Sending its full attachment list
  // with that baseline must not turn the unrelated Codex append into a removal instruction.
  const staleEditorBase = { ...originalBase, id: created.id }
  const staleSave = f.queue.enqueue('one', 'message', { bodyMarkdown: 'Create body', attachments: [] }, created.id, staleEditorBase)
  expect(f.store.draftSave('one', staleSave.id)?.fields).toEqual({})
  await f.queue.flush()
  expect(f.remote.attachments).toEqual([file])

  // Once the editor has observed the append, the confirmed projection is its baseline;
  // removing the file from that list is an explicit replacement and must be honored.
  const confirmedEditorBase = { ...f.remote, id: created.id }
  f.queue.enqueue('one', 'message', { attachments: [] }, created.id, confirmedEditorBase)
  await f.queue.flush()
  expect(f.remote.attachments).toEqual([])
  expect(f.store.draftSave('one', created.id)?.state).toBe('saved')
})
it('accepts a durable append with identity-only seed and rejects corrupted empty-byte readback', async () => {
  const f = setup(); f.queue.pause(true)
  const file = { name: 'empty.txt', mediaType: 'text/plain', contentBase64: '' }
  const accepted = f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], 'empty-append')
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'pending', attachmentAppends: [{ operationId: 'empty-append' }] })
  expect(f.store.draftSave('one', accepted.id)?.base).toBeUndefined()
  f.queue.pause(false)
  const corrupted = { ...f.remote, attachments: [...f.remote.attachments, { ...file, contentBase64: 'eA==' }] }
  f.gateway.read = vi.fn(async () => corrupted)
  f.gateway.update = vi.fn(async () => corrupted)
  await f.queue.flush()
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'pending', error: 'Draft is saved on this device. Waiting for Gmail.' })
})
it('marks a combined attachment limit rejection failed with an actionable error while retaining accepted bytes', async () => {
  const f = setup()
  const file = { name: 'accepted.txt', mediaType: 'text/plain', contentBase64: 'a2VlcCBtZQ==' }
  f.gateway.update = vi.fn(async () => { throw Object.assign(new Error('Combined attachments exceed 25 MB. Remove a file before retrying.'), { code: 'draft_attachment_too_large' }) })
  const accepted = f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], 'too-large-append', f.remote)
  await f.queue.flush()
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({
    state: 'failed',
    retryAt: 0,
    error: 'Combined attachments exceed 25 MB. Remove a file before retrying.',
    attachmentAppends: [{ operationId: 'too-large-append', attachments: [file] }],
  })
})
it('lets an explicit replacement remove one file from a failed append while retaining the other', async () => {
  const f = setup(); const base = f.remote
  const files = [
    { name: 'duplicate.txt', mediaType: 'text/plain', contentBase64: 'a2VlcA==' },
    { name: 'duplicate.txt', mediaType: 'text/plain', contentBase64: 'cmVtb3Zl' },
  ]
  const originalUpdate = f.gateway.update
  let calls = 0
  f.gateway.update = vi.fn(async (job, current) => {
    if (++calls === 1) throw Object.assign(new Error('Combined attachments exceed 25 MB. Remove a file before retrying.'), { code: 'draft_attachment_too_large' })
    return originalUpdate(job, current)
  })
  const accepted = f.queue.enqueueAttachmentAppend('one', 'gmail-one', files, 'oversize-append', base)
  await f.queue.flush()
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'failed', attachmentAppends: [{ operationId: 'oversize-append', attachments: files }] })

  f.queue.pause(true)
  const observed = f.queue.projection(f.store.draftSave('one', accepted.id)!)
  const observedBase = { ...observed, attachments: observed.attachments.map(({ contentBase64: _bytes, ...metadata }) => metadata) }
  const desired = [...base.attachments, files[0]!]
  f.queue.enqueue('one', '', { attachments: desired }, accepted.id, observedBase)
  const revised = f.store.draftSave('one', accepted.id)!
  expect(revised).toMatchObject({ state: 'pending', fields: { attachments: desired }, attachmentAppends: [{ operationId: 'oversize-append', attachments: files, cancelled: true }] })
  expect(revised.base?.attachments).toEqual(base.attachments)
  expect(revised.draft.attachments).toEqual(desired)
  f.queue.pause(false)
  await f.queue.flush()

  expect(f.gateway.update).toHaveBeenCalledTimes(2)
  expect(f.remote.attachments).toEqual(desired)
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'saved', attachmentAppends: [{ operationId: 'oversize-append', attachments: files, cancelled: true }] })
})
it('compensates an append write when the editor removes a visible file in flight', async () => {
  const f = setup(); const base = f.remote
  const files = [
    { name: 'duplicate-in-flight.txt', mediaType: 'text/plain', contentBase64: 'a2VlcA==' },
    { name: 'duplicate-in-flight.txt', mediaType: 'text/plain', contentBase64: 'cmVtb3Zl' },
  ]
  const accepted = f.queue.enqueueAttachmentAppend('one', 'gmail-one', files, 'in-flight-append', base)
  let release!: () => void; let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const updateStarted = new Promise<void>(resolve => { started = resolve })
  const originalUpdate = f.gateway.update
  let hold = true
  f.gateway.update = vi.fn(async (job, current) => {
    const saved = await originalUpdate(job, current)
    if (hold) { hold = false; started(); await gate }
    return saved
  })
  const flight = f.queue.flush()
  await updateStarted
  expect(f.remote.attachments).toEqual([...base.attachments, ...files])

  const observed = f.queue.projection(f.store.draftSave('one', accepted.id)!)
  const observedBase = { ...observed, attachments: observed.attachments.map(({ contentBase64: _bytes, ...metadata }) => metadata) }
  const desired = [...base.attachments, files[0]!]
  f.queue.enqueue('one', '', { attachments: desired }, accepted.id, observedBase)
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'pending', fields: { attachments: desired }, attachmentAppends: [{ operationId: 'in-flight-append', attachments: files, cancelled: true }] })
  release()
  await flight

  expect(f.gateway.update).toHaveBeenCalledTimes(2)
  expect(f.remote.attachments).toEqual(desired)
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'saved', fields: { attachments: desired }, attachmentAppends: [{ operationId: 'in-flight-append', attachments: files, cancelled: true, applied: true }] })
  expect(f.store.draftSave('one', accepted.id)?.base?.attachments).toEqual(desired)
})
it('supersedes an observed unstarted append and carries the retained file in the replacement', async () => {
  const f = setup(); const base = f.remote; f.queue.pause(true)
  const files = [
    { name: 'keep-pending.txt', mediaType: 'text/plain', contentBase64: 'a2VlcA==' },
    { name: 'remove-pending.txt', mediaType: 'text/plain', contentBase64: 'cmVtb3Zl' },
  ]
  const accepted = f.queue.enqueueAttachmentAppend('one', 'gmail-one', files, 'pending-append', base)
  const observed = f.queue.projection(f.store.draftSave('one', accepted.id)!)
  const observedBase = { ...observed, attachments: observed.attachments.map(({ contentBase64: _bytes, ...metadata }) => metadata) }
  const desired = [...base.attachments, files[0]!]
  f.queue.enqueue('one', '', { attachments: desired }, accepted.id, observedBase)
  const revised = f.store.draftSave('one', accepted.id)!
  expect(revised).toMatchObject({ state: 'pending', fields: { attachments: desired }, attachmentAppends: [{ operationId: 'pending-append', attachments: files, cancelled: true }] })
  expect(revised.base?.attachments).toEqual(base.attachments)
  expect(revised.draft.attachments).toEqual(desired)

  f.queue.pause(false)
  await f.queue.flush()
  expect(f.gateway.update).toHaveBeenCalledOnce()
  expect(f.gateway.update).toHaveBeenCalledWith(expect.objectContaining({ fields: { attachments: desired },
    attachmentAppends: expect.arrayContaining([expect.objectContaining({ operationId: 'pending-append', attachments: files, cancelled: true })]) }), expect.any(Object))
  expect(f.remote.attachments).toEqual(desired)
})
it('retries a durable append by the same operation ID after an accepted write loses its reply', async () => {
  const f = setup(); const operationId = 'append-lost-reply'
  const file = { name: 'once.txt', mediaType: 'text/plain', contentBase64: 'b25jZQ==' }
  const original = f.gateway.update; let loseFirstReply = true
  f.gateway.update = vi.fn(async (job, current) => {
    const saved = await original(job, current)
    if (loseFirstReply) { loseFirstReply = false; throw new Error('connection lost after Gmail accepted the append') }
    return saved
  })
  const accepted = f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], operationId, f.remote)
  await f.queue.flush()
  expect(f.store.draftSave('one', accepted.id)).toMatchObject({ state: 'pending', retryAt: 3_000 })
  f.queue.enqueueAttachmentAppend('one', 'gmail-one', [file], operationId, f.remote)
  expect(f.store.draftSave('one', accepted.id)?.retryAt).toBe(0)
  await f.queue.flush()
  expect(f.gateway.update).toHaveBeenCalledTimes(2)
  expect(f.remote.attachments.filter(item => item.name === file.name)).toHaveLength(1)
  expect(f.store.draftSave('one', accepted.id)?.attachmentAppends).toMatchObject([{ operationId, applied: true }])
})

it('drains the active draft claim before pausing later work', async () => {
  const f = setup(); let release!: () => void; let started!: () => void
  const gate = new Promise<void>(r => { release = r }); const reachedProvider = new Promise<void>(r => { started = r })
  const original = f.gateway.create
  f.gateway.create = vi.fn(async job => { started(); await gate; return original(job) })
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'Finish the active claim' })
  const flight = f.queue.flush(); await reachedProvider
  const draining = f.queue.drain()
  let drained = false; void draining.then(() => { drained = true })
  await Promise.resolve(); expect(drained).toBe(false)
  release(); await draining; await flight
  expect(f.store.draftSave('one', draft.id)?.state).toBe('saved')
  const later = f.queue.enqueue('one', '', { bodyMarkdown: 'Wait for resume' }, draft.id)
  await f.queue.flush()
  expect(f.store.draftSave('one', later.id)).toMatchObject({ state: 'pending', fields: { bodyMarkdown: 'Wait for resume' } })
  f.queue.pause(false); await f.queue.flush()
  expect(f.store.draftSave('one', later.id)?.state).toBe('saved')
})

it('accepts equivalent Markdown formatting but does not accept unrelated suffix text on create', async () => {
  const f = setup()
  f.gateway.read = vi.fn(async () => ({ ...f.remote, bodyMarkdown: '_Hello_\n\nworld' }))
  const draft = f.queue.enqueue('one', '', { bodyMarkdown: '*Hello*\n\nworld' })
  await f.queue.flush(); expect((await f.queue.read('one', draft.id)).syncState).toBeUndefined()
  const other = f.queue.enqueue('one', '', { bodyMarkdown: 'Original' })
  f.gateway.read = vi.fn(async () => ({ ...f.remote, bodyMarkdown: 'Original unrelated text' }))
  await f.queue.flush(); expect((await f.queue.read('one', other.id)).syncState).toBe('pending')
})

it('a repeated stable creation identity reuses a draft even after confirmation and service restart', async () => {
  const f = setup(); const key = '61c4381d-9eb5-4350-9662-d5ad48a3b35a'; const fields = { bodyMarkdown: 'Once' }
  const first = f.queue.enqueue('one', '', fields, undefined, undefined, key)
  await f.queue.flush(); f.restart()
  expect(f.queue.enqueue('one', '', fields, undefined, undefined, key).id).toBe(first.id)
  await f.queue.flush(); expect(f.gateway.create).toHaveBeenCalledTimes(1)
  expect(f.gateway.update).toHaveBeenCalledTimes(1)
})
it('pauses pending work during an idle runtime update and resumes without losing it', async () => {
  const f = setup(); const draft = f.queue.enqueue('one', '', { bodyMarkdown: 'Keep through update' })
  f.queue.pause(true); await f.queue.flush()
  expect(f.gateway.create).not.toHaveBeenCalled()
  expect((await f.queue.read('one', draft.id)).syncState).toBe('pending')
  f.queue.pause(false); await f.queue.flush()
  expect((await f.queue.read('one', draft.id)).syncState).toBeUndefined()
})
