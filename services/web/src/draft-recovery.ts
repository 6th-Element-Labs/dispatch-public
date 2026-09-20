import type { DraftProjection } from './contracts.js'
type Attachment = DraftProjection['attachments'][number]
export interface RecoveryDraft {
  gmailThreadId?: string
  key: string; updatedAt: string; revision: number; accountId?: string; accountLabel?: string; gmailDraftId: string; inReplyToMessageId: string
  to: string; cc: string; bcc: string; subject: string; bodyMarkdown: string
  attachments: (Omit<Attachment, 'contentBase64'> & { blobKey?: string; contentPending?: boolean })[]
}
const KEY = 'dispatch.editor-recovery.v1'

/** Local editor outbox, separate from Gmail's authoritative drafts. Text is synchronous;
 * file bytes are committed to IndexedDB before an attachment is added to the editor. */
export class DraftRecovery {
  #blobKeys = new Map<string, string>()
  #database?: Promise<IDBDatabase>
  constructor(private storage: Storage = localStorage) {}
  list(): RecoveryDraft[] {
    const raw = this.storage.getItem(KEY)
    if (!raw) return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error('Local draft recovery data is invalid; it was not overwritten.')
    if (value.some(item => !item || typeof item.key !== 'string' || typeof item.bodyMarkdown !== 'string' || !Array.isArray(item.attachments))) throw new Error('A local recovery record is invalid; it was not overwritten.')
    return (value as RecoveryDraft[])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  #db(): Promise<IDBDatabase> {
    this.#database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('dispatch-editor-recovery', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('files') }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('Local attachment recovery storage could not be opened.'))
    })
    return this.#database
  }
  async cacheFiles(attachments: readonly Attachment[]): Promise<void> {
    const files = attachments.filter(file => file.contentBase64 && !this.#blobKeys.has(file.contentBase64))
    if (!files.length) return
    const db = await this.#db()
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
  save(value: Omit<RecoveryDraft, 'attachments'>, attachments: readonly Attachment[]): void {
    const records = this.list().filter(item => item.key !== value.key)
    const files = attachments.map(file => {
      const { contentBase64, ...metadata } = file
      const blobKey = contentBase64 ? this.#blobKeys.get(contentBase64) : undefined
      return { ...metadata, ...(blobKey ? { blobKey } : {}), ...(contentBase64 && !blobKey ? { contentPending: true } : {}) }
    })
    this.storage.setItem(KEY, JSON.stringify([{ ...value, attachments: files }, ...records]))
  }
  bindGmailIdentity(key: string, accountId: string, draftId: string, gmailThreadId?: string): void {
    const records = this.list()
    const record = records.find(item => item.key === key && item.accountId === accountId)
    if (!record || (record.gmailDraftId && record.gmailDraftId !== draftId)) return
    record.gmailDraftId = draftId
    if (gmailThreadId) record.gmailThreadId = gmailThreadId
    this.storage.setItem(KEY, JSON.stringify(records))
  }
  /** Forgets a Gmail draft id Gmail no longer knows, so the next sync creates or re-finds the draft instead of updating a ghost. */
  clearGmailIdentity(key: string, accountId: string): void {
    const records = this.list()
    const record = records.find(item => item.key === key && item.accountId === accountId)
    if (!record?.gmailDraftId) return
    record.gmailDraftId = ''
    this.storage.setItem(KEY, JSON.stringify(records))
  }
  remove(key: string): void { this.storage.setItem(KEY, JSON.stringify(this.list().filter(item => item.key !== key))) }
  removeSavedRevision(key: string, revision: number): void {
    const item = this.list().find(record => record.key === key)
    if (item?.revision === revision) this.remove(key)
  }
  async restore(key: string): Promise<{ record: RecoveryDraft; attachments: Attachment[]; missing: string[] }> {
    const record = this.list().find(item => item.key === key)
    if (!record) throw new Error('This local draft is no longer available.')
    const missing: string[] = []
    const attachments = await Promise.all(record.attachments.map(async file => {
      const { blobKey, contentPending, ...metadata } = file
      if (contentPending) missing.push(metadata.name)
      if (!blobKey) return metadata
      const db = await this.#db()
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
