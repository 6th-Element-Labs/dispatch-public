import { randomUUID, createHash } from 'node:crypto'
import { projectDraft } from './draft.js'
import { draftChanges } from './draft-conflict.js'
import { normalizedDraftBody } from './draft-markdown.js'
import type { DraftAttachment, DraftProjection } from './model.js'
import type { LocalMailStore } from './local-mail-store.js'

export interface DraftSaveFields {
  to?: string; cc?: string; bcc?: string; subject?: string; bodyMarkdown?: string; attachments?: readonly DraftAttachment[]
}
export interface DraftAttachmentAppendIntent {
  operationId: string
  attachments: readonly DraftAttachment[]
  createdAt: string
  applied?: boolean
  cancelled?: boolean
}
export interface DraftSaveJob {
  id: string; accountId: string; messageId: string; remoteId?: string; fields: DraftSaveFields; draft: DraftProjection
  /** Remote snapshot against which the current coalesced edits were made. */
  base?: DraftProjection
  /** Last editor baseline; its own acknowledged writes must not look external. */
  editorBase?: DraftProjection
  conflictRemote?: DraftProjection
  conflictFields?: readonly string[]
  revision: number; state: 'pending' | 'failed' | 'saved' | 'cancelled'; retryAt: number; attempts: number
  reconnect: boolean; error?: string; createdAt: string
  started?: boolean; cleanupDone?: boolean
  /** Accepted append operations stay durable until verified; applied IDs remain for retry dedupe. */
  attachmentAppends?: readonly DraftAttachmentAppendIntent[]
}
export interface DraftSaveGateway {
  create(job: DraftSaveJob): Promise<DraftProjection>
  read(accountId: string, id: string): Promise<DraftProjection>
  update(job: DraftSaveJob, current: DraftProjection): Promise<DraftProjection>
  discard(accountId: string, id: string): Promise<void>
  findCreated(accountId: string, id: string): Promise<string | undefined>
}

const addresses = (value = '') => value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(address => address.trim()).filter(Boolean).map(value => ({ address: value.match(/<([^>]+)>/)?.[1] ?? value, name: value, initials: '@' }))
const normalized = (value = '') => normalizedDraftBody(value)
const addressKey = (value = '') => addresses(value).map(item => item.address.toLowerCase()).sort().join(',')
const hashBytes = (value: string) => createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex')
const hasBytes = (file: DraftAttachment): file is DraftAttachment & { contentBase64: string } => file.contentBase64 !== undefined

interface DraftConflictDetails { fields: readonly string[]; remote: DraftProjection }
function conflictDetails(error: unknown): DraftConflictDetails | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { code?: unknown; fields?: unknown; remote?: unknown }
  if (value.code !== 'draft_conflict' || !Array.isArray(value.fields) || !value.remote || typeof value.remote !== 'object') return undefined
  return { fields: value.fields.filter((field): field is string => typeof field === 'string'), remote: value.remote as DraftProjection }
}
function withConflict(draft: DraftProjection, remote?: DraftProjection, fields?: readonly string[]): DraftProjection {
  return remote && fields?.length ? { ...draft, conflict: { remote, fields } } : draft
}
function hasUnresolvedConflict(job?: DraftSaveJob): boolean {
  return Boolean(job && (job.conflictRemote || job.conflictFields?.length || job.draft.conflict))
}
function editableFields(draft: DraftProjection): DraftSaveFields {
  return { to: draft.to.map(item => item.address).join(', '), cc: draft.cc ?? '', bcc: draft.bcc ?? '', subject: draft.subject,
    bodyMarkdown: draft.bodyMarkdown, attachments: draft.attachments }
}

const pendingAppends = (job?: DraftSaveJob) => (job?.attachmentAppends ?? []).filter(intent => !intent.applied && !intent.cancelled)
const appendProjectionId = (operationId: string, index: number) => `dispatch-append-${createHash('sha256').update(`${operationId}:${index}`).digest('hex').slice(0, 32)}`

function projectedAppendFiles(intents: readonly DraftAttachmentAppendIntent[] = []): DraftAttachment[] {
  return intents.filter(intent => !intent.applied && !intent.cancelled).flatMap(intent =>
    intent.attachments.map((file, index) => ({ ...file, id: appendProjectionId(intent.operationId, index) })))
}

function sameAttachment(expected: DraftAttachment, actual: DraftAttachment): boolean {
  if (expected.name !== actual.name || expected.mediaType !== actual.mediaType) return false
  if (expected.contentBase64 !== undefined) return actual.contentBase64 !== undefined && hashBytes(expected.contentBase64) === hashBytes(actual.contentBase64)
  if (expected.id !== undefined && actual.id !== undefined) return expected.id === actual.id
  return true
}

function sameAttachmentList(left: readonly DraftAttachment[] = [], right: readonly DraftAttachment[] = []): boolean {
  if (left.length !== right.length) return false
  const remaining = [...right]
  for (const file of left) {
    const match = remaining.findIndex(candidate => sameAttachment(file, candidate))
    if (match < 0) return false
    remaining.splice(match, 1)
  }
  return remaining.length === 0
}

function appendUnique(base: readonly DraftAttachment[], additions: readonly DraftAttachment[]): DraftAttachment[] {
  const result = [...base]
  for (const file of additions) if (!result.some(existing => sameAttachment(file, existing))) result.push(file)
  return result
}

function attachmentObserved(file: DraftAttachment, candidate: DraftAttachment): boolean {
  if (file.name !== candidate.name || file.mediaType !== candidate.mediaType) return false
  if (file.contentBase64 !== undefined && candidate.contentBase64 !== undefined) return hashBytes(file.contentBase64) === hashBytes(candidate.contentBase64)
  return file.id !== undefined && candidate.id !== undefined && file.id === candidate.id
}

function attachmentsObserved(files: readonly DraftAttachment[], baseline: readonly DraftAttachment[]): boolean {
  const remaining = [...baseline]
  for (const file of files) {
    const match = remaining.findIndex(candidate => attachmentObserved(file, candidate))
    if (match < 0) return false
    remaining.splice(match, 1)
  }
  return true
}

function appendPayloadEqual(left: readonly DraftAttachment[], right: readonly DraftAttachment[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function fieldUnchangedFrom(field: keyof DraftSaveFields, value: unknown, baseline: DraftProjection): boolean {
  return draftChanges({ [field]: value } as DraftSaveFields, baseline)[field] === undefined
}

function advanceConfirmedBase(job: DraftSaveJob, latestBase: DraftProjection | undefined, confirmed: DraftProjection): DraftProjection {
  const changed = draftChanges(job.fields, job.base)
  if (!job.base) return confirmed
  let base = { ...(latestBase ?? job.base) }
  for (const field of Object.keys(changed) as (keyof DraftSaveFields)[]) {
    if (changed[field] === undefined) continue
    base = { ...base, [field]: confirmed[field] }
  }
  // A durable append changes Gmail's attachment field even when the claimed
  // revision had no editor replacement field for attachments.
  if (pendingAppends(job).length) base = { ...base, attachments: confirmed.attachments }
  return base
}

/** Accepted draft commands belong to mail. A local acknowledgment is never a Gmail confirmation. */
export class DraftSaveQueue {
  static readonly accountWorkerLimit = 4
  #workers = new Map<string, Promise<void>>()
  #resolvingAccounts = new Set<string>()
  #priorityDrafts = new Map<string, Set<string>>()
  #flushWaiters = new Set<() => void>()
  #stopped = false
  #paused = false
  #workerRetryAt = new Map<string, number>()
  #workerRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(readonly store: LocalMailStore, readonly gateway: DraftSaveGateway, readonly changed: () => void, readonly now = Date.now) {}
  get active(): boolean { return this.#workers.size > 0 }
  stop(): void {
    this.#stopped = true
    this.#wakeFlushes()
    for (const timer of this.#workerRetryTimers.values()) clearTimeout(timer)
    this.#workerRetryTimers.clear()
  }
  pause(value: boolean): void {
    this.#paused = value
    this.#wakeFlushes()
    if (!value) this.#kick()
  }
  /** Pause new claims and wait for every already claimed provider operation to finish. */
  async drain(): Promise<void> {
    this.#paused = true
    this.#wakeFlushes()
    await this.#waitForWorkers()
  }
  owns(accountId: string, id: string): boolean { return Boolean(this.store.draftSave(accountId, id)) }
  origin(accountId: string, id: string): string | undefined { return this.store.draftSaves().find(job => job.accountId === accountId && job.remoteId === id && job.state === 'saved')?.id }
  pendingRemote(accountId: string, id: string): DraftSaveJob | undefined { return this.pending(accountId).find(job => job.remoteId === id) }
  editorFields(accountId: string, id: string, fields: DraftSaveFields): DraftSaveFields {
    const job = this.store.draftSave(accountId, id)
    if (!job) return fields
    // An offline partial command may not have loaded omitted fields yet. The editor's
    // empty placeholders must not become instructions to erase those Gmail fields.
    const result = { ...fields }
    for (const key of ['to', 'cc', 'bcc', 'subject', 'bodyMarkdown', 'attachments'] as const) {
      const shown = key === 'to' ? job.draft.to.map(item => item.address).join(', ') : job.draft[key] ?? (key === 'attachments' ? [] : '')
      if (job.fields[key] === undefined && JSON.stringify(result[key]) === JSON.stringify(shown)) delete result[key]
    }
    return result
  }
  cancelled(): DraftSaveJob[] { return this.store.draftSaves().filter(job => job.state === 'cancelled' && !job.cleanupDone) }
  retryNow(): void {
    for (const job of this.pending()) if (job.state === 'pending') this.store.putDraftSave({ ...job, retryAt: 0 })
    this.#kick()
  }
  pending(accountId?: string): DraftSaveJob[] { return this.store.draftSaves().filter(job => ['pending', 'failed'].includes(job.state) && (!accountId || job.accountId === accountId)) }

  enqueue(accountId: string, messageId: string, fields: DraftSaveFields, remoteId?: string, seed?: DraftProjection, clientDraftId?: string): DraftProjection {
    // The editor recovery UUID and Codex creation UUID need not be the same.
    // A supplied draft ID identifies the existing record; a recovery key only
    // supplies an idempotent identity when creating a new draft.
    const identified = remoteId ? this.store.draftSave(accountId, remoteId) ?? this.store.draftSaves().find(job => job.accountId === accountId && job.remoteId === remoteId && job.state !== 'cancelled') : undefined
    const client = clientDraftId ? this.store.draftSave(accountId, `queued-${clientDraftId}`) : undefined
    if (identified && client && identified.id !== client.id) throw new Error('Draft identities refer to different drafts')
    if (remoteId && client && !identified && client.remoteId !== remoteId && client.id !== remoteId) throw new Error('Draft identities refer to different drafts')
    const prior = identified ?? client ?? (!remoteId && !clientDraftId ? this.pending(accountId).find(job => !job.remoteId && job.messageId === messageId && JSON.stringify(job.fields) === JSON.stringify(fields)) : undefined)
    if (remoteId?.startsWith('queued-') && !prior) throw new Error('Queued draft was not found')
    if (prior?.state === 'cancelled') throw new Error('Draft was discarded')
    const id = prior?.id ?? `queued-${clientDraftId ?? randomUUID()}`
    const pendingPrior = prior?.state === 'pending' || prior?.state === 'failed'
    const conflictedPrior = hasUnresolvedConflict(prior)
    const conflictRemote = prior?.conflictRemote ?? prior?.draft.conflict?.remote
    const conflictFields = prior?.conflictFields ?? prior?.draft.conflict?.fields
    const previous = prior?.draft ?? seed
    const editorBase = seed ?? (pendingPrior ? prior?.base ?? previous : prior?.state === 'saved' ? prior.draft : undefined)
    const acceptedFields: DraftSaveFields = { ...fields }
    if (editorBase && remoteId) {
      for (const key of ['to', 'cc', 'bcc', 'subject', 'bodyMarkdown', 'attachments'] as const) {
        const value = fields[key]
        if (value === undefined) continue
        const unchangedFromEditorBase = fieldUnchangedFrom(key, value, editorBase)
        const unchangedFromLatestProjection = previous ? fieldUnchangedFrom(key, value, previous) : false
        const hasPriorIntent = pendingPrior && prior?.fields[key] !== undefined
        const priorAttachmentTarget = prior?.fields.attachments ?? prior?.base?.attachments
        const knownAppends = projectedAppendFiles(prior?.attachmentAppends)
        const staleAppendSnapshot = key === 'attachments' && pendingPrior && Array.isArray(value) && priorAttachmentTarget
          && sameAttachmentList(value, priorAttachmentTarget)
          && knownAppends.some(file => !priorAttachmentTarget.some(existing => attachmentObserved(file, existing)))
          && knownAppends.some(file => !seed?.attachments.some(existing => attachmentObserved(file, existing)))
        // Editors submit complete projections. Drop untouched fields so stale snapshots cannot
        // become replacement commands. Keep a changed value that reverses an earlier local intent.
        if (staleAppendSnapshot || (pendingPrior && unchangedFromLatestProjection) || (pendingPrior && !hasPriorIntent && unchangedFromEditorBase)
          || (!pendingPrior && unchangedFromEditorBase)) delete acceptedFields[key]
      }
    }
    let attachmentAppends = prior?.attachmentAppends
    const replacement = acceptedFields.attachments
    if (replacement && editorBase && !attachmentsObserved(editorBase.attachments, replacement)) {
      // An explicit editor replacement supersedes an unapplied append whose full
      // payload was visible in the editor baseline. Keep the original operation
      // payload and ID durable; retained files now travel through the replacement.
      attachmentAppends = (attachmentAppends ?? []).map(intent => {
        if (intent.applied || intent.cancelled) return intent
        const projected = intent.attachments.map((file, index) => ({ ...file, id: appendProjectionId(intent.operationId, index) }))
        const observed = attachmentsObserved(projected, editorBase.attachments)
        const removesPart = !attachmentsObserved(projected, replacement)
        return observed && removesPart ? { ...intent, cancelled: true } : intent
      })
    }
    const supersedesObservedAppend = Boolean(editorBase && pendingAppends(prior).some(intent =>
      attachmentsObserved(intent.attachments.map((file, index) => ({ ...file, id: appendProjectionId(intent.operationId, index) })), editorBase.attachments)))
    const merged: DraftSaveFields = { ...(pendingPrior ? prior?.fields : {}), ...acceptedFields }
    const projected = projectDraft({ id, accountId, inReplyToMessageId: messageId || previous?.inReplyToMessageId || '',
      to: merged.to === undefined ? previous?.to ?? [] : addresses(merged.to), cc: merged.cc ?? previous?.cc, bcc: merged.bcc ?? previous?.bcc,
      subject: merged.subject ?? previous?.subject ?? '', bodyMarkdown: merged.bodyMarkdown ?? previous?.bodyMarkdown ?? '', attachments: merged.attachments ?? previous?.attachments })
    const pendingFiles = projectedAppendFiles(attachmentAppends)
    const draft: DraftProjection = withConflict({ ...projected,
      bodyHtml: merged.bodyMarkdown === undefined && previous ? previous.bodyHtml : projected.bodyHtml,
      bodyText: merged.bodyMarkdown === undefined && previous ? previous.bodyText : projected.bodyText,
      attachments: appendUnique(projected.attachments, pendingFiles),
      gmailThreadId: previous?.gmailThreadId, gmailMessageId: previous?.gmailMessageId }, conflictRemote, conflictFields)
    let base = pendingPrior
      ? prior.base
      : prior?.state === 'saved' ? prior.base ?? prior.draft
        : remoteId && !remoteId.startsWith('queued-') ? seed : undefined
    if (base && editorBase) {
      const changedEditorBase = prior?.editorBase ? draftChanges(editableFields(editorBase), prior.editorBase) : undefined
      for (const key of ['to', 'cc', 'bcc', 'subject', 'bodyMarkdown', 'attachments'] as const) {
        const value = acceptedFields[key]
        // An editor can keep typing from its original snapshot after Gmail confirms
        // our save (and appends reply history). Retain that confirmation until the
        // editor actually observes a different baseline. External edits still
        // compare against the last confirmed Gmail copy in the worker.
        if (value !== undefined && !fieldUnchangedFrom(key, value, editorBase)
          && (!changedEditorBase || changedEditorBase[key] !== undefined)) base = { ...base, [key]: editorBase[key] }
      }
      // The editor baseline may contain locally projected bytes that Gmail has
      // not confirmed. Keep the prior remote baseline until append readback wins.
      if (supersedesObservedAppend) base = { ...base, attachments: prior?.base?.attachments ?? base.attachments }
    }
    this.store.putDraftSave({ id, accountId, messageId: messageId || prior?.messageId || previous?.inReplyToMessageId || '', remoteId: prior?.remoteId ?? (remoteId?.startsWith('queued-') ? undefined : remoteId),
      fields: merged, draft, base, editorBase: !prior && !remoteId ? draft : editorBase ?? draft, revision: (prior?.revision ?? 0) + 1, state: conflictedPrior ? 'failed' : 'pending', retryAt: 0,
      attempts: conflictedPrior ? prior?.attempts ?? 0 : 0, reconnect: conflictedPrior ? prior?.reconnect ?? false : false,
      error: conflictedPrior ? prior?.error : undefined, createdAt: prior?.createdAt ?? new Date(this.now()).toISOString(), started: prior?.started,
      attachmentAppends, conflictRemote, conflictFields })
    this.#changed()
    this.#kick()
    return this.projection(this.store.draftSave(accountId, id)!)
  }

  /** Persist an idempotent append command alongside the draft's ordinary replacement fields. */
  enqueueAttachmentAppend(accountId: string, draftId: string, attachments: readonly DraftAttachment[], operationId: string, seed?: DraftProjection): DraftProjection {
    if (!accountId || !draftId || !operationId.trim() || !attachments.length) throw new Error('Account, draft, operation ID and files are required')
    if (attachments.some(file => !file.name || !file.mediaType || !hasBytes(file))) throw new Error('Draft attachment append is missing file bytes')
    let prior = this.store.draftSave(accountId, draftId) ?? this.store.draftSaves().find(job => job.accountId === accountId && job.remoteId === draftId && job.state !== 'cancelled')
    if (draftId.startsWith('queued-') && !prior) throw new Error('Queued draft was not found')
    if (prior?.state === 'cancelled') throw new Error('Draft was discarded')
    const previous = prior?.draft ?? seed ?? (draftId.startsWith('queued-') ? undefined : projectDraft({ id: draftId, accountId, inReplyToMessageId: '', to: [], subject: '', bodyMarkdown: '' }))
    if (!previous || previous.accountId !== accountId) throw new Error('Draft baseline belongs to a different Gmail account')
    const existing = (prior?.attachmentAppends ?? []).find(intent => intent.operationId === operationId)
    if (existing) {
      if (!appendPayloadEqual(existing.attachments, attachments)) throw new Error('Draft attachment operation ID was reused with different files')
      const latest = this.store.draftSave(accountId, prior!.id)!
      if (!existing.applied && !existing.cancelled && latest.state === 'pending' && latest.retryAt > 0) {
        const retried = { ...latest, retryAt: 0 }
        this.store.putDraftSave(retried)
        this.#kick()
        return this.projection(retried)
      }
      return this.projection(latest)
    }
    const id = prior?.id ?? `queued-${randomUUID()}`
    const intent: DraftAttachmentAppendIntent = { operationId, attachments: [...attachments], createdAt: new Date(this.now()).toISOString() }
    const appends = [...(prior?.attachmentAppends ?? []), intent]
    const conflictedPrior = hasUnresolvedConflict(prior)
    const conflictRemote = prior?.conflictRemote ?? prior?.draft.conflict?.remote
    const conflictFields = prior?.conflictFields ?? prior?.draft.conflict?.fields
    const draft = withConflict({ ...previous, id, accountId, attachments: appendUnique(previous.attachments, projectedAppendFiles(appends)) }, conflictRemote, conflictFields)
    const remoteId = prior?.remoteId ?? (draftId.startsWith('queued-') ? undefined : draftId)
    const base = prior?.state === 'pending' || prior?.state === 'failed'
      ? prior.base
      : prior?.state === 'saved' ? prior.base ?? prior.draft
        : remoteId ? seed : undefined
    this.store.putDraftSave({ id, accountId, messageId: prior?.messageId ?? previous.inReplyToMessageId ?? '', remoteId, fields: prior?.fields ?? {}, draft, base,
      revision: (prior?.revision ?? 0) + 1, state: conflictedPrior ? 'failed' : 'pending', retryAt: 0,
      attempts: conflictedPrior ? prior?.attempts ?? 0 : 0, reconnect: conflictedPrior ? prior?.reconnect ?? false : false,
      error: conflictedPrior ? prior?.error : undefined,
      createdAt: prior?.createdAt ?? new Date(this.now()).toISOString(), started: prior?.started, attachmentAppends: appends,
      conflictRemote, conflictFields })
    this.#changed()
    this.#kick()
    return this.projection(this.store.draftSave(accountId, id)!)
  }

  projection(job: DraftSaveJob): DraftProjection {
    return { ...job.draft, id: job.id, draftRevision: job.revision, syncState: job.state === 'failed' ? 'failed' : 'pending', reconnectRequired: job.reconnect,
      syncError: job.error, cachedAt: undefined }
  }
  async read(accountId: string, id: string): Promise<DraftProjection> {
    const job = this.store.draftSave(accountId, id)
    if (!job || job.state === 'cancelled') throw Object.assign(new Error('Draft was discarded'), { code: 'gmail_draft_not_found' })
    if (job.state !== 'saved' || !job.remoteId) return this.projection(job)
    const fresh = await this.gateway.read(accountId, job.remoteId)
    if (fresh.accountId !== accountId || !fresh.id) throw new Error('Gmail returned a different draft account or missing identity')
    if (fresh.id !== job.remoteId) {
      const latest = this.store.draftSave(accountId, id)
      // Gmail can replace a saved draft. Record the confirmed alias without
      // overwriting a newer local edit or cancellation accepted during the read.
      if (latest && latest.state !== 'cancelled' && latest.remoteId === job.remoteId) {
        this.store.putDraftSave({ ...latest, remoteId: fresh.id,
          ...(latest.state === 'saved' && latest.revision === job.revision ? { draft: { ...fresh, id } } : {}),
          base: latest.base ? { ...latest.base, id: fresh.id } : undefined })
        this.#changed()
      }
    }
    return { ...fresh, resolvedFromDraftId: id, draftRevision: job.revision }
  }
  async discard(accountId: string, id: string): Promise<void> {
    const job = this.store.draftSave(accountId, id)
    if (!job) throw new Error('Queued draft was not found')
    const noProviderWork = !job.started && !job.remoteId
    this.store.putDraftSave({ ...job, state: 'cancelled', retryAt: 0, cleanupDone: noProviderWork || job.cleanupDone })
    this.#changed()
    // Cancellation is durable immediately; exact provider cleanup runs in the worker.
    this.#kick()
  }
  async resolveConflict(accountId: string, id: string, choice: 'keep-local' | 'use-remote', expectedRevision?: number): Promise<DraftProjection> {
    const initial = this.store.draftSave(accountId, id)
    if (!initial) throw new Error('Queued draft was not found')
    const revision = expectedRevision ?? initial.revision
    if (expectedRevision !== undefined && initial.revision !== expectedRevision) throw Object.assign(new Error('Draft changed before conflict resolution'), { code: 'draft_revision_changed' })
    if (this.#resolvingAccounts.has(accountId)) throw new Error('Draft conflict resolution is already in progress for this account')
    this.#resolvingAccounts.add(accountId)
    try {
      const active = this.#workers.get(accountId)
      if (active) await active
      if (this.#stopped) throw new Error('Draft queue stopped before conflict resolution')
      const latest = this.store.draftSave(accountId, id)
      if (!latest || latest.state === 'cancelled') throw new Error('Draft was discarded')
      if (latest.revision !== revision) throw Object.assign(new Error('Draft changed before conflict resolution'), { code: 'draft_revision_changed' })
      const capturedRemote = latest.conflictRemote ?? latest.draft.conflict?.remote
      const fields = latest.conflictFields ?? latest.draft.conflict?.fields
      if (!capturedRemote || !fields?.length || !latest.remoteId) throw new Error('Draft has no unresolved Gmail conflict')

      // The conflict preview is a snapshot, not a lock on Gmail. Re-read before archiving or
      // accepting a choice so a later external edit is shown instead of overwritten.
      const remote = await this.gateway.read(accountId, latest.remoteId)
      if (this.#stopped) throw new Error('Draft queue stopped before conflict resolution')
      const afterRead = this.store.draftSave(accountId, id)
      if (!afterRead || afterRead.state === 'cancelled') throw new Error('Draft was discarded')
      if (afterRead.revision !== revision) throw Object.assign(new Error('Draft changed while resolving the Gmail conflict. Read the latest draft and choose again.'), { code: 'draft_revision_changed' })
      const changedRemoteFields = Object.keys(draftChanges(editableFields(remote), capturedRemote))
      if (changedRemoteFields.length) {
        const refreshedFields = [...new Set([...fields, ...changedRemoteFields])]
        const refreshed = { ...afterRead, conflictRemote: remote, conflictFields: refreshedFields,
          draft: withConflict(afterRead.draft, remote, refreshedFields), revision: revision + 1, state: 'failed' as const,
          retryAt: 0, error: 'Gmail draft changed after the conflict preview. Read the latest version and choose again.' }
        this.store.putDraftSave(refreshed)
        this.#changed()
        throw Object.assign(new Error('Gmail draft changed after the conflict preview. Read the latest version and choose again.'), { code: 'draft_revision_changed' })
      }

      // Preserve both exact versions before changing the active queue record.
      this.store.putConflictCopy(accountId, id, latest.draft, remote, choice)
      const nextRevision = latest.revision + 1
      const withoutConflict = (draft: DraftProjection): DraftProjection => {
        const { conflict: _conflict, ...clean } = draft
        return clean
      }
      if (choice === 'keep-local') {
        const resolved = { ...latest, draft: withoutConflict(latest.draft), base: remote,
          conflictRemote: undefined, conflictFields: undefined, revision: nextRevision,
          state: 'pending' as const, retryAt: 0, attempts: 0, reconnect: false, error: undefined }
        this.store.putDraftSave(resolved)
        this.#changed()
        return this.projection(resolved)
      }

      const terminalAppends = (latest.attachmentAppends ?? []).map(intent => intent.applied ? intent : { ...intent, cancelled: true })
      const draft = withoutConflict({ ...remote, id: latest.id, accountId })
      const resolved = { ...latest, draft, base: remote, fields: {}, attachmentAppends: terminalAppends,
        conflictRemote: undefined, conflictFields: undefined, revision: nextRevision, state: 'saved' as const,
        retryAt: 0, attempts: 0, reconnect: false, error: undefined }
      this.store.putDraftSave(resolved)
      this.#changed()
      return { ...remote, resolvedFromDraftId: id, draftRevision: nextRevision }
    } finally {
      this.#resolvingAccounts.delete(accountId)
      this.#scheduleWorkers()
    }
  }
  async flush(): Promise<void> {
    if (this.#stopped || this.#paused) return
    while (!this.#stopped && !this.#paused) {
      this.#scheduleWorkers()
      const workers = [...this.#workers.values()]
      if (!workers.length) return
      const results = await Promise.allSettled(workers)
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
    }
  }
  /** Drain only one account, using the same bounded worker pool as ordinary flushes. */
  async flushAccount(accountId: string): Promise<void> {
    if (!accountId) throw new Error('Gmail account is required')
    if (this.#stopped || this.#paused) return
    while (!this.#stopped && !this.#paused) {
      this.#scheduleWorkers(accountId)
      const target = this.#workers.get(accountId)
      if (target) { await target; continue }
      const runnable = this.store.draftSaves().some(job => job.accountId === accountId && this.#hasRunnable(job))
      if (!runnable) return
      const workers = [...this.#workers.values()]
      if (!workers.length) return
      await Promise.race(workers.map(worker => worker.then(() => undefined, () => undefined)))
    }
  }
  /** Send waits for its own confirmed revision, not every draft in the account. */
  async flushDraft(accountId: string, draftId: string): Promise<void> {
    const id = this.store.draftSave(accountId, draftId)?.id ?? this.pendingRemote(accountId, draftId)?.id
    if (!id) return
    const priority = this.#priorityDrafts.get(accountId) ?? new Set<string>()
    priority.add(id)
    this.#priorityDrafts.set(accountId, priority)
    try {
      while (!this.#stopped && !this.#paused) {
        const job = this.store.draftSave(accountId, id)
        if (!job || job.state !== 'pending' || !this.#hasRunnable(job)) return
        await new Promise<void>(resolve => {
          const wake = () => { this.#flushWaiters.delete(wake); resolve() }
          this.#flushWaiters.add(wake)
          this.#scheduleWorkers(accountId)
        })
      }
    } finally {
      priority.delete(id)
      if (!priority.size) this.#priorityDrafts.delete(accountId)
    }
  }
  #wakeFlushes(): void { for (const wake of [...this.#flushWaiters]) wake() }
  #changed(): void {
    try { this.changed() } finally { this.#wakeFlushes() }
  }
  #kick(): void {
    setImmediate(() => { void this.flush().catch(error => console.error('Dispatch draft queue could not schedule durable work:', error)) })
  }
  #hasRunnable(job: DraftSaveJob): boolean {
    if ((this.#workerRetryAt.get(job.accountId) ?? 0) > this.now()) return false
    if (job.state === 'cancelled') return Boolean(job.started || job.remoteId) && !job.cleanupDone && job.retryAt <= this.now()
    return job.state === 'pending' && !hasUnresolvedConflict(job) && job.retryAt <= this.now()
  }
  #deferWorkerFailure(accountId: string, error: unknown): void {
    const retryAt = this.now() + 3_000
    this.#workerRetryAt.set(accountId, retryAt)
    const previous = this.#workerRetryTimers.get(accountId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      if (this.#workerRetryAt.get(accountId) !== retryAt) return
      this.#workerRetryAt.delete(accountId)
      this.#workerRetryTimers.delete(accountId)
      this.#kick()
    }, 3_000)
    timer.unref?.()
    this.#workerRetryTimers.set(accountId, timer)
    console.error(`Dispatch draft queue worker failed for account ${accountId}; durable jobs remain queued for retry:`, error)
  }
  #clearWorkerFailure(accountId: string): void {
    this.#workerRetryAt.delete(accountId)
    const timer = this.#workerRetryTimers.get(accountId)
    if (timer) clearTimeout(timer)
    this.#workerRetryTimers.delete(accountId)
  }
  #scheduleWorkers(onlyAccountId?: string): void {
    if (this.#stopped || this.#paused || this.#workers.size >= DraftSaveQueue.accountWorkerLimit) return
    const accounts = [...new Set(this.store.draftSaves().filter(job => this.#hasRunnable(job) && (!onlyAccountId || job.accountId === onlyAccountId)).map(job => job.accountId))]
    for (const accountId of accounts) {
      if (this.#workers.size >= DraftSaveQueue.accountWorkerLimit) break
      if (this.#resolvingAccounts.has(accountId)) continue
      if (this.#workers.has(accountId)) continue
      const worker = this.#runAccount(accountId).catch(error => {
        this.#deferWorkerFailure(accountId, error)
      }).finally(() => {
        this.#workers.delete(accountId)
        this.#scheduleWorkers()
        this.#wakeFlushes()
      })
      this.#clearWorkerFailure(accountId)
      this.#workers.set(accountId, worker)
    }
  }
  async #waitForWorkers(): Promise<void> {
    while (this.#workers.size) {
      const results = await Promise.allSettled([...this.#workers.values()])
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
    }
  }
  async #runAccount(accountId: string): Promise<void> {
    while (!this.#stopped && !this.#paused) {
      const runnable = this.store.draftSaves().filter(item => item.accountId === accountId && this.#hasRunnable(item))
      const priority = this.#priorityDrafts.get(accountId)
      const job = runnable.find(item => priority?.has(item.id)) ?? runnable[0]
      if (!job) return
      if (job.state === 'cancelled') {
        if (!await this.#cleanupCancelled(accountId, job.id)) return
        continue
      }
      await this.#saveRevision(accountId, job.id, job.revision)
    }
  }
  async #cleanupCancelled(accountId: string, draftId: string): Promise<boolean> {
    let latest = this.store.draftSave(accountId, draftId)
    if (!latest || latest.state !== 'cancelled' || latest.cleanupDone) return true
    if (!latest.started && !latest.remoteId) {
      this.store.putDraftSave({ ...latest, cleanupDone: true })
      this.#changed()
      return true
    }
    try {
      let remoteId = latest.remoteId
      if (!remoteId) {
        if (this.#stopped) return false
        remoteId = await this.gateway.findCreated(accountId, draftId)
        if (this.#stopped) return false
        latest = this.store.draftSave(accountId, draftId)
        if (!latest || latest.state !== 'cancelled') return true
      }
      if (remoteId) {
        if (this.#stopped) return false
        await this.gateway.discard(accountId, remoteId)
        if (this.#stopped) return false
      }
      latest = this.store.draftSave(accountId, draftId)
      if (!latest || latest.state !== 'cancelled') return true
      this.store.putDraftSave({ ...latest, remoteId, cleanupDone: true, retryAt: 0 })
      this.#changed()
      return true
    } catch {
      if (!this.#stopped) {
        latest = this.store.draftSave(accountId, draftId)
        if (latest?.state === 'cancelled') this.store.putDraftSave({ ...latest, retryAt: this.now() + 3_000 })
      }
      return false
    }
  }
  async #saveRevision(accountId: string, draftId: string, revision: number): Promise<void> {
    let latest = this.store.draftSave(accountId, draftId)
    if (!latest || latest.state !== 'pending' || latest.revision !== revision || latest.retryAt > this.now()) return
    const claimed: DraftSaveJob = { ...latest, started: true }
    this.store.putDraftSave(claimed)
    let remoteId = claimed.remoteId
    try {
      let saved: DraftProjection
      if (remoteId) {
        if (this.#stopped) return
        const current = await this.gateway.read(accountId, remoteId)
        if (this.#stopped) return
        latest = this.store.draftSave(accountId, draftId)
        if (!latest) return
        if (latest.state === 'cancelled') { await this.#cleanupCancelled(accountId, draftId); return }
        if (latest.state !== 'pending' || latest.revision !== claimed.revision) return
        if (this.#stopped) return
        saved = await this.gateway.update(claimed, current)
      } else {
        if (this.#stopped) return
        saved = await this.gateway.create(claimed)
      }
      if (this.#stopped) return
      remoteId = saved.id
      latest = this.store.draftSave(accountId, draftId)
      if (!latest) return
      this.store.putDraftSave({ ...latest, remoteId, draft: { ...saved, ...latest.draft,
        gmailThreadId: saved.gmailThreadId ?? latest.draft.gmailThreadId, gmailMessageId: saved.gmailMessageId ?? latest.draft.gmailMessageId } })
      if (latest.state === 'cancelled') { await this.#cleanupCancelled(accountId, draftId); return }
      if (latest.state !== 'pending') return
      if (this.#stopped) return
      const confirmed = await this.gateway.read(accountId, remoteId)
      if (this.#stopped) return
      latest = this.store.draftSave(accountId, draftId)
      if (!latest) return
      if (latest.state === 'cancelled') { await this.#cleanupCancelled(accountId, draftId); return }
      if (latest.state !== 'pending') return
      this.#verify(claimed, saved, confirmed)
      const appliedIds = new Set(pendingAppends(claimed).map(intent => intent.operationId))
      const attachmentAppends = (latest.attachmentAppends ?? []).map(intent => appliedIds.has(intent.operationId) ? { ...intent, applied: true } : intent)
      const stillPendingAppends = attachmentAppends.some(intent => !intent.applied && !intent.cancelled)
      const newerRevision = latest.revision !== claimed.revision
      let fields = latest.fields
      if (!claimed.remoteId && newerRevision && stillPendingAppends && claimed.fields.attachments !== undefined
        && latest.fields.attachments !== undefined && sameAttachmentList(claimed.fields.attachments, confirmed.attachments)
        && sameAttachmentList(latest.fields.attachments, claimed.fields.attachments)) {
        // The create's confirmed attachment target is no longer an editor command.
        // An append accepted during create follows it and must not be erased by that
        // old empty/full list on the append worker's next revision.
        fields = { ...latest.fields }
        delete fields.attachments
      }
      this.store.putDraftSave({ ...latest, remoteId, fields, base: newerRevision ? advanceConfirmedBase(claimed, latest.base, confirmed) : confirmed, draft: withConflict(newerRevision ? { ...latest.draft,
        gmailThreadId: confirmed.gmailThreadId ?? latest.draft.gmailThreadId, gmailMessageId: confirmed.gmailMessageId ?? latest.draft.gmailMessageId } : confirmed, latest.conflictRemote, latest.conflictFields), attachmentAppends,
        state: newerRevision || stillPendingAppends ? 'pending' : 'saved', retryAt: newerRevision || stillPendingAppends ? 0 : latest.retryAt,
        reconnect: false, error: undefined })
      this.#changed()
    } catch (error) {
      if (this.#stopped) return
      latest = this.store.draftSave(accountId, draftId)
      if (!latest || latest.state === 'cancelled') {
        if (latest?.state === 'cancelled') await this.#cleanupCancelled(accountId, draftId)
        return
      }
      // A failure from a superseded command does not own the newer revision's state.
      if (latest.revision !== claimed.revision) return
      const detail = error instanceof Error ? error.message : String(error)
      const conflict = conflictDetails(error)
      const errorCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
      const invalid = Boolean(conflict) || errorCode === 'draft_attachment_too_large'
        || /Unknown Gmail account|invalid.arguments|invalid.params|argument.binding|Invalid draft|gmail_draft_not_found|missing file bytes|draft_conflict/i.test(detail)
      const reconnect = /token_revoked|invalidated oauth|unauthorized|refresh.*(?:expired|revoked|invalid)|Reconnect your Codex/i.test(detail)
      const attempts = latest.attempts + 1
      const conflictRemote = conflict?.remote ?? latest.conflictRemote
      const conflictFields = conflict?.fields ?? latest.conflictFields
      this.store.putDraftSave({ ...latest, remoteId, attempts, state: invalid ? 'failed' : 'pending', reconnect,
        draft: withConflict(latest.draft, conflictRemote, conflictFields), conflictRemote, conflictFields,
        error: conflict ? detail : reconnect ? 'Sign in again to sync this draft.' : invalid ? detail : 'Draft is saved on this device. Waiting for Gmail.',
        retryAt: invalid ? 0 : this.now() + Math.min(60_000, 3_000 * 2 ** Math.min(attempts - 1, 5)) })
      this.#changed()
    }
  }
  #verify(job: DraftSaveJob, saved: DraftProjection, confirmed: DraftProjection): void {
    const expectedFields = draftChanges(job.fields, job.base)
    for (const key of ['to', 'cc', 'bcc'] as const) {
      const wanted = expectedFields[key]
      const actual = key === 'to' ? confirmed.to.map(item => item.address).join(',') : confirmed[key]
      if (wanted !== undefined && addressKey(actual) !== addressKey(wanted)) throw new Error(`Gmail has not confirmed draft ${key}`)
    }
    if (expectedFields.subject !== undefined && confirmed.subject !== expectedFields.subject) throw new Error('Gmail has not confirmed the draft subject')
    if (expectedFields.bodyMarkdown !== undefined) {
      const wanted = normalized(expectedFields.bodyMarkdown)
      const actual = normalized(confirmed.bodyMarkdown)
      // Gmail's reply create may append quoted history. Updates must match the full
      // requested text: an older, longer body sharing a prefix is not confirmation.
      const quoted = !job.remoteId && actual.startsWith(wanted) && /^(?:>\s*)?On .+ wrote:/.test(actual.slice(wanted.length).trim())
      if (actual !== wanted && !quoted) throw new Error('Gmail has not confirmed the draft text')
    }
    const appendIntents = pendingAppends(job)
    if (expectedFields.attachments !== undefined) {
      const expected = [...expectedFields.attachments]
      for (const intent of appendIntents) for (const file of intent.attachments) {
        if (!expected.some(existing => sameAttachment(file, existing))) expected.push(file)
      }
      const remaining = [...confirmed.attachments]
      for (const file of expected) this.#consumeAttachment(remaining, file, saved)
      if (remaining.length) throw new Error('Gmail has not confirmed attachment removal')
    } else {
      const remaining = [...confirmed.attachments]
      const seen: DraftAttachment[] = []
      for (const intent of appendIntents) for (const file of intent.attachments) {
        if (seen.some(existing => sameAttachment(file, existing))) continue
        this.#consumeAttachment(remaining, file, saved)
        seen.push(file)
      }
    }
  }
  #consumeAttachment(remaining: DraftAttachment[], file: DraftAttachment, saved: DraftProjection): void {
    const savedFile = saved.attachments.find(item => item.name === file.name && item.mediaType === file.mediaType && (file.id === undefined || item.id === file.id))
    const expectedBytes = file.contentBase64 ?? savedFile?.contentBase64
    const match = remaining.findIndex(item => item.name === file.name && item.mediaType === file.mediaType
      && (expectedBytes === undefined || (item.contentBase64 !== undefined && hashBytes(item.contentBase64) === hashBytes(expectedBytes)))
      && (expectedBytes !== undefined || file.id === undefined || item.id === undefined || item.id === file.id))
    if (match < 0) throw new Error(`Gmail has not confirmed draft attachment ${file.name}`)
    remaining.splice(match, 1)
  }
}
