import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConversationProjection, DraftProjection } from './model.js'

export interface ReceiptDetails { to: string[]; cc: string[]; bcc: string[]; subject: string; attachments: { name: string; mediaType: string; sizeLabel?: string }[] }
export interface SendReceipt {
  id: string; accountId: string; accountLabel: string; draftId?: string; messageId?: string
  status: 'preparing' | 'sending' | 'accepted' | 'verified' | 'failed' | 'unknown'
  requestedAt: string; acceptedAt?: string; verifiedAt?: string; sentAt?: string
  detailsSource: 'draft' | 'sent-message' | 'unavailable'; details?: ReceiptDetails; intended?: ReceiptDetails
  error?: string; warnings?: string[]
}
export interface OfflineDownload { id: string; state: 'running' | 'complete' | 'partial' | 'cancelled' | 'interrupted'; mailbox: string; accountId?: string; total: number; completed: number; errors: string[]; startedAt: string }

/** Mail alone owns downloaded message bodies and provider send receipts. */
export class LocalMailStore {
  readonly #db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS conversations(account_id TEXT NOT NULL, thread_id TEXT NOT NULL, cached_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account_id,thread_id));
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, draft_id TEXT, message_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS receipt_draft ON receipts(account_id,draft_id);
      CREATE INDEX IF NOT EXISTS receipt_message ON receipts(account_id,message_id);
      CREATE TABLE IF NOT EXISTS local_state(key TEXT PRIMARY KEY,payload TEXT NOT NULL);`)
    this.#db.exec('CREATE TABLE IF NOT EXISTS saved_drafts(account_id TEXT NOT NULL, draft_id TEXT NOT NULL, thread_id TEXT, message_id TEXT, confirmed_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account_id,draft_id))')
    for (const receipt of this.#db.prepare("SELECT payload FROM receipts WHERE status IN ('sending','preparing')").all().map(row => JSON.parse(String(row.payload)) as SendReceipt)) if (receipt.status === 'sending') this.putReceipt({ ...receipt, status: 'unknown', error: 'Dispatch restarted before the send response arrived. Check Sent before retrying.' })
    for (const receipt of this.#db.prepare("SELECT payload FROM receipts WHERE status IN ('sending','preparing')").all().map(row => JSON.parse(String(row.payload)) as SendReceipt)) if (receipt.status === 'preparing') this.putReceipt({ ...receipt, status: 'failed', error: 'Dispatch stopped before issuing the send.' })
    const job = this.download()
    if (job?.state === 'running') this.putDownload({ ...job, state: 'interrupted' })
  }
  close(): void { this.#db.close() }
  putDraft(draft: DraftProjection): void {
    if (!draft.accountId || !draft.id) return
    const { cachedAt: _cached, ...saved } = draft
    this.#db.prepare('INSERT OR REPLACE INTO saved_drafts VALUES(?,?,?,?,?,?)').run(draft.accountId, draft.id, draft.gmailThreadId ?? '', draft.gmailMessageId ?? '', new Date().toISOString(), JSON.stringify(saved))
  }
  draft(accountId: string, draftId: string): DraftProjection | undefined {
    const row = this.#db.prepare('SELECT payload,confirmed_at FROM saved_drafts WHERE account_id=? AND draft_id=?').get(accountId, draftId)
    return row ? { ...JSON.parse(String(row.payload)), cachedAt: String(row.confirmed_at) } : undefined
  }
  draftForMessage(accountId: string, messageId: string, threadId: string): DraftProjection | undefined {
    const row = this.#db.prepare("SELECT payload,confirmed_at FROM saved_drafts WHERE account_id=? AND (message_id=? OR (thread_id<>'' AND thread_id=?)) ORDER BY confirmed_at DESC LIMIT 1").get(accountId, messageId, threadId)
    return row ? { ...JSON.parse(String(row.payload)), cachedAt: String(row.confirmed_at) } : undefined
  }
  removeDraft(accountId: string, draftId: string): void { this.#db.prepare('DELETE FROM saved_drafts WHERE account_id=? AND draft_id=?').run(accountId, draftId) }
  pruneDrafts(accountId: string, ids: readonly string[], requestedAt: string): void {
    const keep = new Set(ids)
    for (const row of this.#db.prepare('SELECT draft_id FROM saved_drafts WHERE account_id=? AND confirmed_at<?').all(accountId, requestedAt)) if (!keep.has(String(row.draft_id))) this.removeDraft(accountId, String(row.draft_id))
  }
  retryAfter(accountId: string): number {
    const row = this.#db.prepare('SELECT payload FROM local_state WHERE key=?').get(`retry-after:${accountId}`)
    return row ? Number(row.payload) : 0
  }
  putRetryAfter(accountId: string, timestamp: number): void {
    this.#db.prepare('INSERT OR REPLACE INTO local_state VALUES (?,?)').run(`retry-after:${accountId}`, String(timestamp))
  }
  draftCreate(accountId: string, clientId: string): { draftId?: string; rejected?: boolean } | undefined {
    const row = this.#db.prepare('SELECT payload FROM local_state WHERE key=?').get(`draft-create:${accountId}:${clientId}`)
    return row ? JSON.parse(String(row.payload)) : undefined
  }
  putDraftCreate(accountId: string, clientId: string, value: { draftId?: string; rejected?: boolean }): void {
    this.#db.prepare('INSERT OR REPLACE INTO local_state VALUES(?,?)').run(`draft-create:${accountId}:${clientId}`, JSON.stringify(value))
  }
  removeDraftCreate(accountId: string, clientId: string): void { this.#db.prepare('DELETE FROM local_state WHERE key=?').run(`draft-create:${accountId}:${clientId}`) }
  cache(conversation: ConversationProjection): string {
    if (!conversation.accountId) throw new Error('A downloaded conversation requires an account')
    const cachedAt = new Date().toISOString()
    const { availability: _availability, ...payload } = conversation
    this.#db.prepare('INSERT OR REPLACE INTO conversations VALUES(?,?,?,?)').run(conversation.accountId, conversation.threadId, cachedAt, JSON.stringify(payload))
    return cachedAt
  }
  conversation(accountId: string, threadId: string): { conversation: ConversationProjection; cachedAt: string } | undefined {
    const row = this.#db.prepare('SELECT payload,cached_at FROM conversations WHERE account_id=? AND thread_id=?').get(accountId, threadId)
    return row ? { conversation: JSON.parse(String(row.payload)), cachedAt: String(row.cached_at) } : undefined
  }
  cachedKeys(): Set<string> { return new Set(this.#db.prepare('SELECT account_id,thread_id FROM conversations').all().map(row => `${row.account_id}:${row.thread_id}`)) }
  stats(): { conversations: number; bytes: number } {
    const row = this.#db.prepare('SELECT COUNT(*) count, COALESCE(SUM(length(CAST(payload AS BLOB))),0) bytes FROM conversations').get()!
    return { conversations: Number(row.count), bytes: Number(row.bytes) }
  }
  pruneAccounts(ids: readonly string[]): void {
    for (const row of this.#db.prepare('SELECT DISTINCT account_id FROM conversations').all()) if (!ids.includes(String(row.account_id))) this.#db.prepare('DELETE FROM conversations WHERE account_id=?').run(row.account_id!)
  }
  putReceipt(receipt: SendReceipt): void {
    this.#db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?,?,?,?,?,?)').run(receipt.id, receipt.accountId, receipt.draftId ?? null, receipt.messageId ?? null, receipt.status, receipt.requestedAt, JSON.stringify(receipt))
  }
  receipt(id: string): SendReceipt | undefined { const row = this.#db.prepare('SELECT payload FROM receipts WHERE id=?').get(id); return row ? JSON.parse(String(row.payload)) : undefined }
  receiptForDraft(accountId: string, draftId: string): SendReceipt | undefined { const row = this.#db.prepare('SELECT payload FROM receipts WHERE account_id=? AND draft_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1').get(accountId, draftId); return row ? JSON.parse(String(row.payload)) : undefined }
  receiptForMessage(accountId: string, messageId: string): SendReceipt | undefined { const row = this.#db.prepare('SELECT payload FROM receipts WHERE account_id=? AND message_id=? LIMIT 1').get(accountId, messageId); return row ? JSON.parse(String(row.payload)) : undefined }
  receipts(): SendReceipt[] { return this.#db.prepare('SELECT payload FROM receipts ORDER BY requested_at DESC,rowid DESC LIMIT 100').all().map(row => JSON.parse(String(row.payload))) }
  putDownload(job: OfflineDownload): void { this.#db.prepare('INSERT OR REPLACE INTO local_state VALUES(?,?)').run('download', JSON.stringify(job)) }
  download(): OfflineDownload | undefined { const row = this.#db.prepare('SELECT payload FROM local_state WHERE key=?').get('download'); return row ? JSON.parse(String(row.payload)) : undefined }
}
