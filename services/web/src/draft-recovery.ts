import type { DraftProjection } from './contracts.js'

type Attachment = DraftProjection['attachments'][number]
type StoredAttachment = Omit<Attachment, 'contentBase64'> & { blobKey?: string; contentPending?: boolean }

export interface RecoveryDraft {
  gmailThreadId?: string
  key: string; updatedAt: string; revision: number; accountId?: string; accountLabel?: string; gmailDraftId: string; inReplyToMessageId: string
  to: string; cc: string; bcc: string; subject: string; bodyMarkdown: string
  base?: DraftProjection
  conflict?: DraftProjection['conflict']
  draftRevision?: number
  attachmentsChanged?: boolean
  attachments: StoredAttachment[]
}

const LEGACY_KEY = 'dispatch.editor-recovery.v1'
const RECORD_PREFIX = 'dispatch.editor-recovery.v2.record:'
const ACK_PREFIX = 'dispatch.editor-recovery.v2.ack:'

type RecordSource = 'legacy' | 'live'
interface StoredRecordKey { key: string; revision: number; source: RecordSource }
interface AcknowledgmentKey { key: string; revision: number }

function recordStorageKey(key: string, revision: number, source: RecordSource): string {
  return `${RECORD_PREFIX}${encodeURIComponent(key)}:${revision}:${source}`
}

function acknowledgmentStorageKey(key: string, revision: number): string {
  return `${ACK_PREFIX}${encodeURIComponent(key)}:${revision}`
}

function parseRecordStorageKey(storageKey: string): StoredRecordKey | undefined {
  if (!storageKey.startsWith(RECORD_PREFIX)) return undefined
  const suffix = storageKey.slice(RECORD_PREFIX.length)
  const sourceSeparator = suffix.lastIndexOf(':')
  const revisionSeparator = suffix.lastIndexOf(':', sourceSeparator - 1)
  const source = suffix.slice(sourceSeparator + 1)
  const revision = Number(suffix.slice(revisionSeparator + 1, sourceSeparator))
  if (revisionSeparator < 0 || !Number.isSafeInteger(revision) || revision < 0 || (source !== 'legacy' && source !== 'live')) {
    throw invalidRecovery('A local draft recovery key is damaged.')
  }
  let key: string
  try { key = decodeURIComponent(suffix.slice(0, revisionSeparator)) }
  catch { throw invalidRecovery('A local draft recovery key is damaged.') }
  return { key, revision, source }
}

function parseAcknowledgmentStorageKey(storageKey: string): AcknowledgmentKey | undefined {
  if (!storageKey.startsWith(ACK_PREFIX)) return undefined
  const suffix = storageKey.slice(ACK_PREFIX.length)
  const separator = suffix.lastIndexOf(':')
  const revision = Number(suffix.slice(separator + 1))
  if (separator < 0 || !Number.isSafeInteger(revision) || revision < 0) {
    throw invalidRecovery('A local draft recovery acknowledgment is damaged.')
  }
  let key: string
  try { key = decodeURIComponent(suffix.slice(0, separator)) }
  catch { throw invalidRecovery('A local draft recovery acknowledgment is damaged.') }
  return { key, revision }
}

function invalidRecovery(message = 'Local draft recovery data is damaged. Keep Dispatch open and contact support before clearing browser data.'): Error {
  return new Error(message)
}

function normalizeBaseline(value: unknown): DraftProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRecovery('The saved Gmail baseline in local draft recovery is damaged.')
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || typeof item.inReplyToMessageId !== 'string' || typeof item.subject !== 'string'
    || typeof item.bodyMarkdown !== 'string' || !Array.isArray(item.to) || !Array.isArray(item.attachments)) {
    throw invalidRecovery('The saved Gmail baseline in local draft recovery is damaged.')
  }
  if (item.accountId !== undefined && typeof item.accountId !== 'string') throw invalidRecovery('The saved Gmail baseline account in local draft recovery is damaged.')
  for (const field of ['cc', 'bcc'] as const) if (item[field] !== undefined && typeof item[field] !== 'string') throw invalidRecovery('The saved Gmail baseline in local draft recovery is damaged.')
  const to = item.to.map((address): DraftProjection['to'][number] => {
    if (!address || typeof address !== 'object' || typeof (address as { address?: unknown }).address !== 'string') throw invalidRecovery('A recipient in the saved Gmail baseline is damaged.')
    const value = address as { address: string; name?: unknown; initials?: unknown }
    return { address: value.address, name: typeof value.name === 'string' ? value.name : value.address, initials: typeof value.initials === 'string' ? value.initials : '@' }
  })
  const attachments = item.attachments.map((attachment): Attachment => {
    if (!attachment || typeof attachment !== 'object' || typeof (attachment as { name?: unknown }).name !== 'string'
      || typeof (attachment as { mediaType?: unknown }).mediaType !== 'string') throw invalidRecovery('An attachment in the saved Gmail baseline is damaged.')
    const { contentBase64: _contentBase64, ...metadata } = attachment as Record<string, unknown>
    return metadata as Attachment
  })
  return {
    id: item.id,
    ...(typeof item.accountId === 'string' ? { accountId: item.accountId } : {}),
    inReplyToMessageId: item.inReplyToMessageId,
    to,
    cc: typeof item.cc === 'string' ? item.cc : '',
    bcc: typeof item.bcc === 'string' ? item.bcc : '',
    subject: item.subject,
    bodyMarkdown: item.bodyMarkdown,
    bodyText: item.bodyMarkdown,
    bodyHtml: '',
    attachments,
    state: 'draft',
  }
}

function normalizeRecord(value: unknown): RecoveryDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRecovery('A local draft recovery record is damaged.')
  const item = value as Record<string, unknown>
  if (typeof item.key !== 'string' || typeof item.bodyMarkdown !== 'string' || !Array.isArray(item.attachments)) {
    throw invalidRecovery('A local draft recovery record is damaged.')
  }
  if (item.updatedAt !== undefined && typeof item.updatedAt !== 'string') throw invalidRecovery('A local draft recovery timestamp is damaged.')
  if (item.revision !== undefined && (!Number.isSafeInteger(item.revision) || Number(item.revision) < 0)) throw invalidRecovery('A local draft recovery revision is damaged.')
  if (item.draftRevision !== undefined && (!Number.isSafeInteger(item.draftRevision) || Number(item.draftRevision) < 1)) throw invalidRecovery('A local draft save revision is damaged.')
  if (item.attachmentsChanged !== undefined && typeof item.attachmentsChanged !== 'boolean') throw invalidRecovery('The local draft attachment intent is damaged.')
  for (const name of ['accountId', 'accountLabel', 'gmailThreadId', 'gmailDraftId', 'inReplyToMessageId', 'to', 'cc', 'bcc', 'subject'] as const) {
    if (item[name] !== undefined && typeof item[name] !== 'string') throw invalidRecovery('A local draft recovery field is damaged.')
  }
  const attachments = item.attachments.map((attachment): StoredAttachment => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment) || typeof (attachment as { name?: unknown }).name !== 'string') {
      throw invalidRecovery('A local draft attachment recovery record is damaged.')
    }
    const file = attachment as Record<string, unknown>
    if (file.contentBase64 !== undefined) throw invalidRecovery('A local draft attachment is not stored in the expected recovery format.')
    if (file.blobKey !== undefined && typeof file.blobKey !== 'string') throw invalidRecovery('A local draft attachment recovery key is damaged.')
    if (file.contentPending !== undefined && typeof file.contentPending !== 'boolean') throw invalidRecovery('A local draft attachment recovery state is damaged.')
    return file as StoredAttachment
  })
  return {
    ...(typeof item.gmailThreadId === 'string' ? { gmailThreadId: item.gmailThreadId } : {}),
    key: item.key,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    revision: typeof item.revision === 'number' ? item.revision : 0,
    ...(typeof item.accountId === 'string' ? { accountId: item.accountId } : {}),
    ...(typeof item.accountLabel === 'string' ? { accountLabel: item.accountLabel } : {}),
    gmailDraftId: typeof item.gmailDraftId === 'string' ? item.gmailDraftId : '',
    inReplyToMessageId: typeof item.inReplyToMessageId === 'string' ? item.inReplyToMessageId : '',
    to: typeof item.to === 'string' ? item.to : '',
    cc: typeof item.cc === 'string' ? item.cc : '',
    bcc: typeof item.bcc === 'string' ? item.bcc : '',
    subject: typeof item.subject === 'string' ? item.subject : '',
    bodyMarkdown: item.bodyMarkdown,
    ...(item.base !== undefined ? { base: normalizeBaseline(item.base) } : {}),
    ...(item.conflict !== undefined ? { conflict: normalizeConflict(item.conflict) } : {}),
    ...(typeof item.draftRevision === 'number' ? { draftRevision: item.draftRevision } : {}),
    ...(typeof item.attachmentsChanged === 'boolean' ? { attachmentsChanged: item.attachmentsChanged } : {}),
    attachments,
  }
}

function normalizeConflict(value: unknown): NonNullable<RecoveryDraft['conflict']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRecovery('The Gmail conflict in local draft recovery is damaged.')
  const item = value as Record<string, unknown>
  if (!Array.isArray(item.fields) || !item.fields.every(field => typeof field === 'string')) throw invalidRecovery('The Gmail conflict fields in local draft recovery are damaged.')
  return { fields: item.fields as string[], remote: normalizeBaseline(item.remote) }
}

/** Local editor outbox, separate from Gmail's authoritative drafts. Text is synchronous;
 * file bytes are committed to IndexedDB before an attachment is added to the editor. */
export class DraftRecovery {
  #blobKeys = new Map<string, string>()
  #database?: Promise<IDBDatabase>
  constructor(private storage: Storage = localStorage) {}

  list(): RecoveryDraft[] {
    this.#migrateLegacy()
    const keys = this.#storageKeys()
    const acknowledged = this.#acknowledgedRevisions(keys)
    this.#compactAcknowledgments(keys, acknowledged)
    const current = new Map<string, { record: RecoveryDraft; source: RecordSource }>()
    for (const storageKey of keys) {
      const recordKey = parseRecordStorageKey(storageKey)
      if (!recordKey || recordKey.revision <= (acknowledged.get(recordKey.key) ?? -1)) continue
      const record = this.#readRecord(storageKey, recordKey)
      if (!record) continue
      const previous = current.get(record.key)
      if (!previous || record.revision > previous.record.revision
        || (record.revision === previous.record.revision && recordKey.source === 'live' && previous.source !== 'live')
        || (record.revision === previous.record.revision && recordKey.source === previous.source && record.updatedAt > previous.record.updatedAt)) {
        current.set(record.key, { record, source: recordKey.source })
      }
    }
    return [...current.values()].map(item => item.record).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  #storageKeys(): string[] {
    const keys: string[] = []
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index)
      if (key?.startsWith(RECORD_PREFIX) || key?.startsWith(ACK_PREFIX)) keys.push(key)
    }
    return keys
  }

  #acknowledgedRevisions(keys: readonly string[]): Map<string, number> {
    const acknowledged = new Map<string, number>()
    for (const storageKey of keys) {
      const item = parseAcknowledgmentStorageKey(storageKey)
      if (!item) continue
      acknowledged.set(item.key, Math.max(item.revision, acknowledged.get(item.key) ?? -1))
    }
    return acknowledged
  }

  #compactAcknowledgments(keys: readonly string[], acknowledged: ReadonlyMap<string, number>): void {
    for (const storageKey of keys) {
      const item = parseAcknowledgmentStorageKey(storageKey)
      if (item && item.revision < (acknowledged.get(item.key) ?? -1)) this.storage.removeItem(storageKey)
    }
  }

  #readRecord(storageKey: string, identity: StoredRecordKey): RecoveryDraft | undefined {
    const raw = this.storage.getItem(storageKey)
    if (raw === null) return undefined
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { throw invalidRecovery(`Local draft recovery for “${identity.key}” cannot be read. Keep Dispatch open and contact support before clearing browser data.`) }
    const record = normalizeRecord(parsed)
    if (record.key !== identity.key || record.revision !== identity.revision) {
      throw invalidRecovery(`Local draft recovery for “${identity.key}” does not match its storage key. Keep Dispatch open and contact support before clearing browser data.`)
    }
    return record
  }

  #migrateLegacy(): void {
    const raw = this.storage.getItem(LEGACY_KEY)
    if (raw === null) return
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { throw invalidRecovery('The older local draft recovery list cannot be read. It has not been changed; keep Dispatch open and contact support before clearing browser data.') }
    if (!Array.isArray(parsed)) throw invalidRecovery('The older local draft recovery list is damaged. It has not been changed; keep Dispatch open and contact support before clearing browser data.')
    const records = parsed.map(normalizeRecord)
    try {
      for (const record of records) {
        const acknowledged = this.#acknowledgedRevisions(this.#storageKeys()).get(record.key) ?? -1
        if (record.revision <= acknowledged) continue
        const target = recordStorageKey(record.key, record.revision, 'legacy')
        // The migration copy has its own key. A live checkpoint written at the same
        // revision always wins if another window is editing while migration runs.
        const existing = this.storage.getItem(target)
        if (existing === null) this.storage.setItem(target, JSON.stringify(record))
        else this.#readRecord(target, { key: record.key, revision: record.revision, source: 'legacy' })
      }
    } catch {
      throw invalidRecovery('The older local draft recovery list could not be copied. The original data is still intact; keep Dispatch open and contact support before clearing browser data.')
    }
    // Every valid record is copied before the old shared list is removed. If a write
    // fails, the original array stays available for the next launch to retry.
    if (this.storage.getItem(LEGACY_KEY) === raw) this.storage.removeItem(LEGACY_KEY)
  }

  #databaseConnection(): Promise<IDBDatabase> {
    this.#database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('dispatch-editor-recovery', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('files') }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('Local attachment recovery storage could not be opened.'))
    })
    return this.#database
  }

  async cacheFiles(attachments: readonly Attachment[]): Promise<void> {
    const files = attachments.filter(file => file.contentBase64 !== undefined && !this.#blobKeys.has(file.contentBase64))
    if (!files.length) return
    const db = await this.#databaseConnection()
    const keys = files.map(file => ({ file, key: crypto.randomUUID() }))
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      for (const { file, key } of keys) tx.objectStore('files').put(file.contentBase64, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error('The attachment could not be saved for local recovery. It has not been added.'))
      tx.onabort = tx.onerror
    })
    for (const { file, key } of keys) this.#blobKeys.set(file.contentBase64!, key)
  }

  /** Store one synchronous checkpoint under this draft and revision only. */
  save(value: Omit<RecoveryDraft, 'attachments'>, attachments: readonly Attachment[]): void {
    const acknowledged = this.#acknowledgedRevisions(this.#storageKeys()).get(value.key) ?? -1
    if (value.revision <= acknowledged) return
    const files = attachments.map(file => {
      const { contentBase64, ...metadata } = file
      const blobKey = contentBase64 !== undefined ? this.#blobKeys.get(contentBase64) : undefined
      return { ...metadata, ...(blobKey ? { blobKey } : {}), ...(contentBase64 !== undefined && !blobKey ? { contentPending: true } : {}) }
    })
    const base = value.base ? normalizeBaseline(value.base) : undefined
    const conflict = value.conflict ? normalizeConflict(value.conflict) : undefined
    this.storage.setItem(recordStorageKey(value.key, value.revision, 'live'), JSON.stringify({ ...value, ...(base ? { base } : {}), ...(conflict ? { conflict } : {}), attachments: files }))
    this.#removeOlderRevisions(value.key, value.revision)
  }

  #removeOlderRevisions(key: string, revision: number): void {
    for (const storageKey of this.#storageKeys()) {
      const record = parseRecordStorageKey(storageKey)
      if (record?.key === key && record.revision < revision) this.storage.removeItem(storageKey)
    }
  }

  bindGmailIdentity(key: string, accountId: string, draftId: string, gmailThreadId?: string): void {
    const record = this.list().find(item => item.key === key && item.accountId === accountId)
    if (!record || (record.gmailDraftId && record.gmailDraftId !== draftId)) return
    record.gmailDraftId = draftId
    if (gmailThreadId) record.gmailThreadId = gmailThreadId
    this.storage.setItem(recordStorageKey(key, record.revision, 'live'), JSON.stringify(record))
  }

  /** Forgets a Gmail draft id that Gmail no longer knows, so the next sync creates or re-finds the draft instead of updating a ghost. */
  clearGmailIdentity(key: string, accountId: string): void {
    const record = this.list().find(item => item.key === key && item.accountId === accountId)
    if (!record?.gmailDraftId) return
    record.gmailDraftId = ''
    this.storage.setItem(recordStorageKey(key, record.revision, 'live'), JSON.stringify(record))
  }

  remove(key: string): void {
    this.#migrateLegacy()
    const keys = this.#storageKeys()
    const revisions = keys.map(parseRecordStorageKey).filter((item): item is StoredRecordKey => item?.key === key).map(item => item.revision)
    const acknowledged = this.#acknowledgedRevisions(keys).get(key) ?? -1
    const through = Math.max(acknowledged, ...revisions)
    if (through < 0) return
    this.#acknowledge(key, through)
    this.#removeThroughRevision(key, through)
  }

  /** A Gmail acknowledgment clears this revision and any obsolete earlier checkpoint. */
  removeSavedRevision(key: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('The saved draft revision is invalid.')
    this.#acknowledge(key, revision)
    this.#removeThroughRevision(key, revision)
  }

  #acknowledge(key: string, revision: number): void {
    const before = this.#acknowledgedRevisions(this.#storageKeys()).get(key) ?? -1
    if (before < revision) this.storage.setItem(acknowledgmentStorageKey(key, revision), '1')
    const keys = this.#storageKeys()
    const acknowledged = this.#acknowledgedRevisions(keys)
    this.#compactAcknowledgments(keys, acknowledged)
  }

  #removeThroughRevision(key: string, revision: number): void {
    for (const storageKey of this.#storageKeys()) {
      const record = parseRecordStorageKey(storageKey)
      if (record?.key === key && record.revision <= revision) this.storage.removeItem(storageKey)
    }
  }

  async restore(key: string): Promise<{ record: RecoveryDraft; attachments: Attachment[]; missing: string[] }> {
    const record = this.list().find(item => item.key === key)
    if (!record) throw new Error('This local draft is no longer available.')
    const missing: string[] = []
    const attachments = await Promise.all(record.attachments.map(async file => {
      const { blobKey, contentPending, ...metadata } = file
      if (contentPending) missing.push(metadata.name)
      if (!blobKey) return metadata
      const db = await this.#databaseConnection()
      const content = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction('files', 'readonly').objectStore('files').get(blobKey)
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      if (typeof content !== 'string') { missing.push(metadata.name); return metadata }
      this.#blobKeys.set(content, blobKey)
      return { ...metadata, contentBase64: content }
    }))
    return { record, attachments, missing }
  }
}
