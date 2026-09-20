import { LocalMailStore, type SendReceipt, type ReceiptDetails, type OfflineDownload } from './local-mail-store.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ResumeClock } from './resume-clock.js'
import { groupConversations, projectConversation, conversationForMailbox } from './conversation.js'
import { plainBodyFromMessage, projectDraft } from './draft.js'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolveAttachmentBytes } from './open-attachment.js'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, basename, extname } from 'node:path'
import { folderFlagsFromLabels, GmailIndex, type GmailSyncStatus, type IndexedGmailMessage, type IndexStreamFlag } from './gmail-index.js'
import type { AttachmentProjection, ConversationProjection, ConversationSummary, DraftAttachment, DraftProjection, GmailConversationAction, GmailMailbox, MailAddress, MailStateFilter, MailboxCounts, MessageProjection, MessageSummary } from './model.js'
import { decodeRawMessage, findPart, parseMime } from './mime-part.js'

export interface GmailAccountProjection {
  readonly id: string
  readonly connectorId: string
  readonly name: string
  readonly email: string
}

type UnknownRecord = Record<string, unknown>

interface GmailSyncProgress {
  accountCount: number
  accountsCompleted: number
  pagesFetched: number
  fetchedMessages: number
  currentAccount: string | null
}

interface GmailDraftSummary {
  readonly metadata: UnknownRecord
  readonly draftId: string
  readonly messageId: string
  readonly threadId: string
  readonly to: string
  readonly cc: string
  readonly bcc: string
  readonly subject: string
  readonly hasAttachment: boolean
}

function defaultIndexPath(): string {
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Dispatch', 'gmail-index.sqlite')
    : resolve(process.cwd(), '.dispatch-data', 'gmail-index.sqlite')
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** The connector reports an unreadable type inside a 200 with `isError` and `error_data.code`. */
export function unsupportedAttachmentType(value: unknown): boolean {
  const content = structured(value)
  return text(record(content.error_data)?.code) === 'unsupported_attachment_type'
    || text(record(content.error_data)?.reason) === 'unsupported_attachment_type'
}

function structured(value: unknown): UnknownRecord {
  const root = record(value)
  return record(root?.structuredContent) ?? {}
}

export const INDEX_STREAMS = [
  { flag: 'inbox', query: '-in:spam -in:trash', labelIds: ['INBOX'] },
  { flag: 'unread', query: '-in:spam -in:trash', labelIds: ['UNREAD'] },
  { flag: 'sent', query: '-in:trash', labelIds: ['SENT'] },
  { flag: 'drafts', query: '-in:trash', labelIds: ['DRAFT'] },
  { flag: 'spam', query: 'in:spam', labelIds: ['SPAM'] },
  { flag: 'trash', query: 'in:trash', labelIds: ['TRASH'] },
  { flag: 'archive', query: '-in:inbox -in:sent -in:drafts -in:spam -in:trash', labelIds: [] },
] as const satisfies readonly { flag: IndexStreamFlag; query: string; labelIds: readonly string[] }[]

function queueSearchSpec(state: MailStateFilter): { query: string; labels: readonly string[] } {
  if (state === 'unread') return { query: 'in:inbox is:unread -in:spam -in:trash -in:drafts', labels: ['INBOX', 'UNREAD'] }
  if (state === 'read') return { query: 'in:inbox is:read -in:spam -in:trash', labels: ['INBOX'] }
  return { query: 'in:inbox -in:spam -in:trash -in:drafts', labels: ['INBOX'] }
}

export function mergeIndexedMessages(messages: readonly IndexedGmailMessage[]): IndexedGmailMessage[] {
  const merged = new Map<string, IndexedGmailMessage>()
  for (const message of messages) {
    const existing = merged.get(message.id)
    const next = existing
      ? {
          ...message,
          unread: existing.unread || message.unread,
          inInbox: existing.inInbox || message.inInbox,
          inSent: existing.inSent || message.inSent,
          inDrafts: existing.inDrafts || message.inDrafts,
          inSpam: existing.inSpam || message.inSpam,
          inTrash: existing.inTrash || message.inTrash,
          inArchive: existing.inArchive || message.inArchive,
          hasAttachment: existing.hasAttachment === true || message.hasAttachment === true,
        }
      : message
    merged.set(message.id, {
      ...next,
      inArchive: next.inArchive && !next.inInbox && !next.inSent && !next.inDrafts && !next.inSpam && !next.inTrash,
    })
  }
  return [...merged.values()]
}

/** The connector wraps Gmail's 404 in a tool error; the draft is gone or replaced. */
function isGmailNotFound(error: unknown): boolean {
  return /HTTP status: 404|not[ _]found/i.test(error instanceof Error ? error.message : String(error))
}

function draftConnectorError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  if (/html|mime_type|text\/html/i.test(detail)) return Object.assign(new Error(detail), { code: 'gmail_html_unsupported' })
  if (/attach/i.test(detail)) return Object.assign(new Error(detail), { code: 'gmail_attachment_unsupported' })
  if (/discard|delete_draft/i.test(detail)) return Object.assign(new Error(detail), { code: 'gmail_draft_discard_unavailable' })
  if (/gmail_draft_list_unavailable/i.test(detail)) return Object.assign(new Error(detail), { code: 'gmail_draft_open_unavailable' })
  return error instanceof Error ? error : new Error(detail)
}

function draftRecipientHeader(value: unknown, field: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((address) => typeof address === 'string')) return value.join(', ')
  throw new Error(`Gmail draft ${field} must be a string or an array of recipient strings`)
}

function gmailDraftSummary(value: unknown): GmailDraftSummary {
  const draft = record(value) ?? {}
  const draftId = text(draft.draft_id)
  const messageId = text(draft.message_id)
  if (!draftId || !messageId) throw new Error('Gmail draft list row is missing draft_id or message_id')
  return {
    draftId,
    metadata: draft,
    messageId,
    threadId: text(draft.thread_id),
    to: draftRecipientHeader(draft.to, 'To'),
    cc: draftRecipientHeader(draft.cc, 'Cc'),
    bcc: draftRecipientHeader(draft.bcc, 'Bcc'),
    subject: text(draft.subject),
    hasAttachment: draft.has_attachment === true,
  }
}

function missingAttachmentBytes(): Error {
  return Object.assign(new Error('Gmail draft attachment is missing file bytes'), { code: 'gmail_attachment_bytes_required' })
}

async function attachmentBytes(value: unknown): Promise<string> {
  try {
    return (await resolveAttachmentBytes(value)).toString('base64')
  } catch (error) {
    throw Object.assign(missingAttachmentBytes(), { cause: error })
  }
}

function connectorAttachments(items: readonly DraftAttachment[]): Array<{ filename: string; mime_type: string; data: string; contentId?: string }> {
  return items.map((item) => {
    if (!item.contentBase64) throw missingAttachmentBytes()
    return { filename: item.name, mime_type: item.mediaType, data: item.contentBase64, ...item.contentId ? { contentId: item.contentId } : {} }
  })
}

function draftAttachmentsFromMessage(message: MessageProjection): readonly DraftAttachment[] {
  return message.attachments.map((item) => ({
    id: item.id,
    name: item.name,
    mediaType: item.mediaType,
    sizeLabel: item.sizeLabel,
    sourceMessageId: message.id,
    ...item.contentId ? { contentId: item.contentId } : {},
  }))
}

function headers(payload: UnknownRecord): Map<string, string> {
  const result = new Map<string, string>()
  for (const item of array(payload.headers)) {
    const header = record(item)
    const name = text(header?.name).toLowerCase()
    if (name) result.set(name, text(header?.value))
  }
  return result
}

function sender(value: string): MailAddress {
  const bracketed = /^\s*([^<]*)<([^>]+)>\s*$/.exec(value)
  const flattened = bracketed ? undefined : /^\s*(.+?)\s+([^\s<>]+@[^\s<>]+)\s*$/.exec(value)
  const name = (bracketed?.[1]?.trim() || bracketed?.[2] || flattened?.[1] || value).trim().replace(/^"|"$/g, '')
  const address = (bracketed?.[2] || flattened?.[2] || value).trim()
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '@'
  return { name, address, initials }
}

function addressList(value: string): readonly MailAddress[] {
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((item) => item.trim()).filter(Boolean).map(sender)
}

function parts(payload: UnknownRecord): readonly UnknownRecord[] {
  const children = array(payload.parts).flatMap((part) => {
    const value = record(part)
    return value ? [value, ...parts(value)] : []
  })
  return children
}

function body(payload: UnknownRecord): MessageProjection['body'] {
  const all = [payload, ...parts(payload)]
  const html = all.find((part) => text(part.mime_type).toLowerCase() === 'text/html')
  const plain = all.find((part) => text(part.mime_type).toLowerCase() === 'text/plain')
  const htmlContent = text(record(html?.body)?.content)
  if (htmlContent) return { kind: 'sanitized-html', content: htmlContent }
  const plainContent = text(record(plain?.body)?.content) || text(record(payload.body)?.content)
  return { kind: 'plain-text', content: plainContent || 'This message has no readable text body.' }
}

function partContentId(part: UnknownRecord): string {
  return (headers(part).get('content-id') ?? '').replace(/^<|>$/g, '')
}

function attachments(payload: UnknownRecord): readonly AttachmentProjection[] {
  return parts(payload).flatMap((part) => {
    const filename = text(part.filename)
    const contentId = partContentId(part)
    if (!filename && text(part.mime_type) === 'text/plain' && /^dispatch-[a-zA-Z0-9-]+@draft\.dispatch\.local$/.test(contentId)) return []
    if (!filename && !contentId) return []
    const partBody = record(part.body)
    const size = typeof partBody?.size === 'number' ? partBody.size : 0
    return [{
      id: text(partBody?.attachment_id) || text(part.part_id) || filename || contentId,
      name: filename || contentId,
      mediaType: text(part.mime_type) || 'application/octet-stream',
      sizeLabel: size > 1_000_000 ? `${(size / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1000))} KB`,
      ...contentId ? { contentId } : {},
    }]
  })
}

function rewriteCidImages(html: string, messageId: string, accountId: string, items: readonly AttachmentProjection[]): string {
  const mailBase = process.env.DISPATCH_MAIL_URL ?? 'http://127.0.0.1:8411'
  return html.replace(/cid:([^"'>\s]+)/gi, (match, rawId: string) => {
    const id = rawId.replace(/^<|>$/g, '')
    const attachment = items.find((item) => item.contentId === id)
    if (!attachment) return match
    return `${mailBase}/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}?account=${encodeURIComponent(accountId)}&filename=${encodeURIComponent(attachment.name)}`
  })
}

function received(value: string, context?: { messageId?: string; account?: string }): { iso: string; label: string; fullLabel: string } {
  const numeric = Number(value)
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    const subject = context?.messageId ? `Gmail message ${context.messageId}` : 'Gmail message'
    const where = context?.account ? ` in ${context.account}` : ''
    throw new Error(`${subject}${where} has an invalid or missing received timestamp (got ${JSON.stringify(value)})`)
  }
  return {
    iso: date.toISOString(),
    label: new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date),
    fullLabel: new Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'short' }).format(date),
  }
}

export function projectGmailMessage(value: unknown, includeBody: boolean, account?: GmailAccountProjection): MessageProjection {
  const message = structured(value)
  const payload = record(message.payload) ?? {}
  const messageHeaders = headers(payload)
  if (message.label_ids !== null && message.label_ids !== undefined && !Array.isArray(message.label_ids)) throw new Error('Gmail message label_ids must be an array or null')
  if (!messageHeaders.get('from')) throw new Error('Gmail message is missing its From header')
  const receivedAt = received(text(message.internal_date) || messageHeaders.get('date') || '', { messageId: text(message.id), account: account?.email })
  const projection: MessageProjection = {
    id: text(message.id),
    threadId: text(message.thread_id),
    sender: sender(messageHeaders.get('from')!),
    subject: messageHeaders.get('subject') || '(No subject)',
    receivedAt: receivedAt.iso,
    receivedLabel: receivedAt.label,
    receivedFullLabel: receivedAt.fullLabel,
    preview: text(message.snippet),
    unread: array(message.label_ids).includes('UNREAD'),
    body: includeBody ? body(payload) : { kind: 'plain-text', content: '' },
    attachments: includeBody ? attachments(payload) : [],
    to: addressList(messageHeaders.get('to') ?? ''),
    cc: addressList(messageHeaders.get('cc') ?? ''),
    bcc: addressList(messageHeaders.get('bcc') ?? ''),
    labels: array(message.label_ids).filter((value): value is string => typeof value === 'string'),
    source: 'gmail',
    accountId: account?.id,
    accountLabel: account?.email || account?.name,
  }
  if (!projection.id || !projection.threadId) throw new Error('Gmail response is missing stable message identity')
  if (projection.body.kind === 'sanitized-html' && account?.id) {
    return {
      ...projection,
      body: {
        kind: 'sanitized-html',
        content: rewriteCidImages(projection.body.content, projection.id, account.id, projection.attachments),
      },
    }
  }
  return projection
}

export function projectGmailSearchEmail(value: unknown, account: GmailAccountProjection): MessageSummary {
  const email = record(value) ?? {}
  if (!Array.isArray(email.labels)) throw new Error('Gmail search result is missing labels')
  if (!text(email.from_)) throw new Error('Gmail search result is missing from_')
  const id = text(email.id)
  const threadId = text(email.thread_id)
  if (!id || !threadId) throw new Error('Gmail search result is missing stable message identity')
  const receivedAt = received(text(email.email_ts), { messageId: id, account: account.email || account.name })
  return {
    id,
    threadId,
    sender: sender(text(email.from_)),
    subject: text(email.subject) || '(No subject)',
    receivedAt: receivedAt.iso,
    receivedLabel: receivedAt.label,
    receivedFullLabel: receivedAt.fullLabel,
    preview: text(email.snippet),
    unread: array(email.labels).includes('UNREAD'),
    hasAttachment: email.has_attachment === true,
    accountId: account.id,
    accountLabel: account.email || account.name,
  }
}

export class GmailConnectorProvider {
  readonly #agentBase: string
  readonly #index: GmailIndex | undefined
  readonly #local: LocalMailStore
  readonly #sendFlights = new Map<string, Promise<unknown>>()
  #download: OfflineDownload | undefined
  readonly #syncIntervalMs: number
  readonly #refreshIntervalMs: number
  #syncPromise: Promise<void> | undefined
  readonly #syncContext = new AsyncLocalStorage<AbortSignal>()
  #syncController: AbortController | undefined
  #syncKind: 'heads' | 'full' | undefined
  #syncStarted = 0
  #lastWakeRefresh = Number.NEGATIVE_INFINITY
  #wakeController: AbortController | undefined
  #wakeTimer: ReturnType<typeof setInterval> | undefined
  #mailRevision = Date.now()
  #syncTimer: ReturnType<typeof setInterval> | undefined
  #refreshTimer: ReturnType<typeof setInterval> | undefined
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #stopped = false
  readonly #drafts = new Map<string, DraftProjection>()
  readonly #draftCreates = new Map<string, Promise<DraftProjection>>()
  readonly #gmailBackoff = new Map<string, number>()
  readonly #connectorFlights = new Map<string, Promise<unknown>>()
  readonly #draftRefreshFlights = new Map<string, Promise<void>>()
  readonly #draftRefreshAt = new Map<string, number>()
  #draftsRevision = Date.now()
  #draftCacheSequence = 0
  /** Gmail's draft list lags a fresh create or update by a few seconds; a miss is rechecked once after this long. */
  readonly #draftListLagMs: number
  readonly #draftCacheRequests = new Map<string, number>()
  #actionFlight: Promise<void> | undefined
  #actionTimer: ReturnType<typeof setInterval> | undefined
  #syncProgress: GmailSyncProgress = { accountCount: 0, accountsCompleted: 0, pagesFetched: 0, fetchedMessages: 0, currentAccount: null }

  constructor(
    agentBase = process.env.DISPATCH_AGENT_URL ?? 'http://127.0.0.1:8412',
    options: { localPath?: string; indexPath?: string | false; syncIntervalMs?: number; refreshIntervalMs?: number; draftListLagMs?: number } = {},
  ) {
    this.#agentBase = agentBase
    const indexPath = options.indexPath === false
      ? undefined
      : options.indexPath ?? process.env.DISPATCH_MAIL_DB ?? defaultIndexPath()
    this.#index = indexPath ? new GmailIndex(indexPath) : undefined
    this.#draftListLagMs = options.draftListLagMs ?? 1_500
    this.#local = new LocalMailStore(options.localPath ?? (indexPath && indexPath !== ':memory:' ? `${indexPath}.local` : ':memory:'))
    this.#download = this.#local.download()
    this.#syncIntervalMs = options.syncIntervalMs ?? 6 * 60 * 60 * 1000
    this.#refreshIntervalMs = options.refreshIntervalMs ?? 60_000
  }

  startBackgroundSync(): void {
    if (!this.#index || this.#syncTimer) return
    this.#stopped = false
    const clock = new ResumeClock()
    this.#wakeTimer = setInterval(() => { if (clock.observe()) this.requestRefresh('wake') }, 5_000)
    this.#wakeTimer.unref()
    void this.flushActions()
    this.#actionTimer = setInterval(() => { void this.flushActions() }, 5_000)
    this.#actionTimer.unref()
    if (this.#index.count() > 0) this.requestRefresh('startup')
    else this.#scheduleSync(0, true)
    this.#syncTimer = setInterval(() => { this.#scheduleSync(0, true) }, this.#syncIntervalMs)
    this.#syncTimer.unref()
    this.#refreshTimer = setInterval(() => { this.requestRefresh('periodic') }, this.#refreshIntervalMs)
    this.#refreshTimer.unref()
  }

  stopBackgroundSync(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#syncController?.abort()
    if (this.#wakeTimer) clearInterval(this.#wakeTimer)
    if (this.#actionTimer) clearInterval(this.#actionTimer)
    if (this.#syncTimer) clearInterval(this.#syncTimer)
    if (this.#refreshTimer) clearInterval(this.#refreshTimer)
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#syncTimer = undefined
    this.#refreshTimer = undefined
    this.#retryTimer = undefined
    this.cancelOfflineDownload()
    this.#index?.close()
    this.#local.close()
  }

  syncStatus(): (GmailSyncStatus & Partial<GmailSyncProgress>) | undefined {
    const indexedStatus = this.#index?.status()
    const status = indexedStatus ? { ...indexedStatus, draftsRevision: this.#draftsRevision, mailRevision: this.#mailRevision } : undefined
    const pending = this.#index?.pendingActions() ?? []
    if (status && pending.length) return { ...status, ...this.#syncProgress, state: 'partial', error: pending.find(job => job.error)?.error ?? `${pending.length} mail changes waiting to sync` }
    return status ? { ...status, ...this.#syncProgress } : undefined
  }

  async syncNow(): Promise<void> {
    return this.#synchronize(100, true)
  }

  requestRefresh(reason = 'manual'): void {
    if (this.#stopped) return
    const syncAge = Date.now() - this.#syncStarted
    if (reason === 'wake') {
      const now = Date.now()
      // Join another wake detector's replacement, never an arbitrary pre-wake scan.
      if (this.#syncPromise && this.#wakeController === this.#syncController && now >= this.#lastWakeRefresh && now - this.#lastWakeRefresh < 15_000) return
      this.#lastWakeRefresh = now
    }
    if (this.#syncPromise && (reason === 'wake' || (reason !== 'periodic' && this.#syncKind === 'full') || syncAge > 180_000)) {
      this.#syncController?.abort()
      this.#syncPromise = undefined
    }
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = undefined }
    void this.refreshNow().catch(error => {
      if (error?.name === 'AbortError' || this.#stopped) return
      this.#scheduleSync(/fetch failed|ECONN|network/i.test(String(error)) ? 5_000 : 60_000)
    })
    if (reason === 'wake') this.#wakeController = this.#syncController
  }

  #runSync(kind: 'heads' | 'full', work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController()
    this.#syncController = controller; this.#syncKind = kind; this.#syncStarted = Date.now()
    const timeout = setTimeout(() => controller.abort(new Error('Gmail synchronization timed out; retrying.')), kind === 'heads' ? 180_000 : 900_000)
    timeout.unref()
    const flight = this.#syncContext.run(controller.signal, () => work(controller.signal)).catch(error => {
      if (!this.#stopped && this.#syncController === controller && error?.name !== 'AbortError') this.#index?.failSync(String(error))
      throw error
    }).finally(() => {
      clearTimeout(timeout)
      if (this.#syncPromise === flight) { this.#syncPromise = undefined; this.#syncController = undefined; this.#syncKind = undefined }
    })
    this.#syncPromise = flight
    return flight
  }

  async refreshNow(): Promise<void> {
    if (!this.#index) return
    if (this.#syncPromise) return this.#syncPromise
    return this.#runSync('heads', async (signal) => {
      const startedAt = new Date().toISOString()
      const runId = `${startedAt}:${randomUUID()}`
      this.#index!.beginSync(startedAt)
      try {
        const accounts = await this.accounts()
        signal.throwIfAborted()
        if (accounts.length === 0) throw new Error('Cannot refresh Gmail: no connector accounts are available')
        this.#index!.replaceAccounts(accounts, startedAt)
        this.#syncProgress = { accountCount: accounts.length, accountsCompleted: 0, pagesFetched: 0, fetchedMessages: 0, currentAccount: null }
        const pages = await Promise.allSettled(accounts.map(async (account) => {
          const streams = []
          for (const stream of INDEX_STREAMS) {
            const page = await this.#searchPage(account, 50, stream.query, stream.labelIds, '')
            signal.throwIfAborted()
            streams.push({ stream, page })
            this.#index!.replaceAccount(account.id, mergeIndexedMessages(streams.flatMap(item => item.page.messages)), runId, false)
            if (!page.nextPageToken) this.#index!.reconcileStream(account.id, stream.flag, page.messages.map(message => message.id), runId)
            this.#syncProgress.pagesFetched++; this.#syncProgress.fetchedMessages += page.messages.length
            this.#mailRevision++
          }
          this.#syncProgress.accountsCompleted++
          return { account, streams, messages: mergeIndexedMessages(streams.flatMap((item) => item.page.messages)) }
        }))
        signal.throwIfAborted()
        for (const result of pages) {
          if (result.status !== 'fulfilled') continue
          const page = result.value
          this.#syncProgress.currentAccount = page.account.name
          this.#index!.replaceAccount(page.account.id, page.messages, runId, false)
          for (const item of page.streams) {
            if (!item.page.nextPageToken) this.#index!.reconcileStream(page.account.id, item.stream.flag, item.page.messages.map((message) => message.id), runId)
          }
        }
        this.#syncProgress.currentAccount = null
        this.#index!.pruneAccounts(accounts.map((account) => account.id))
        this.#local.pruneAccounts(accounts.map((account) => account.id))
        const failed = pages.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed.length) throw new Error(failed.map(result => String(result.reason)).join('; '))
        this.#index!.completeSync(new Date().toISOString(), true)
      } catch (error) {
        throw error
      }
    })
  }

  cachedAccounts(): readonly GmailAccountProjection[] { return this.#index?.accounts() ?? [] }
  runtimeStatus(): { activeOperations: number } { return { activeOperations: this.#sendFlights.size + this.#draftCreates.size } }

  async accounts(): Promise<readonly GmailAccountProjection[]> {
    try {
      const signal = this.#syncContext.getStore()
      const response = await fetch(`${this.#agentBase}/v1/connectors/gmail`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
      const value = await response.json() as unknown
      if (!response.ok) throw new Error(`Gmail inventory failed (${response.status})`)
      const inventory = record(value)
      return array(inventory?.accounts).map((account) => {
        const item = record(account)
        const id = text(item?.linkId)
        if (!id) throw new Error('Gmail inventory contains an account without linkId')
        return { id, connectorId: text(item?.connectorId), name: text(item?.name) || 'Gmail', email: text(item?.email) }
      })
    } catch (error) {
      this.#syncContext.getStore()?.throwIfAborted()
      const indexed = this.#index?.accounts() ?? []
      if (indexed.length === 0) throw error
      this.#index?.failSync(`Gmail account refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      return indexed
    }
  }

  async listMessages(accountId: string, maxResults = 10): Promise<readonly MessageSummary[]> {
    if (this.#index) {
      await this.#ensureIndex()
      return this.#index.messages(accountId).filter((message) => message.inInbox)
    }
    const account = await this.#account(accountId)
    return this.#searchAccountMessages(account, maxResults, '-in:spam -in:trash', ['INBOX'])
  }

  async listUnifiedMessages(maxResultsPerAccount = 10): Promise<readonly MessageSummary[]> {
    if (this.#index) {
      await this.#ensureIndex()
      return this.#index.messages().filter((message) => message.inInbox)
    }
    const accounts = await this.accounts()
    const lists = await Promise.all(accounts.map((account) => this.#searchAccountMessages(account, maxResultsPerAccount, '-in:spam -in:trash', ['INBOX'])))
    return lists
      .flat()
      .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
  }

  async listConversations(accountId: string, state: MailStateFilter, maxResults = 20): Promise<readonly ConversationSummary[]> {
    if (this.#index) {
      await this.#ensureIndex()
      return this.#index.conversations(state, accountId)
    }
    const account = await this.#account(accountId)
    return groupConversations(await this.#listAccountMessages(account, maxResults, state), state)
  }

  async listUnifiedConversations(state: MailStateFilter, maxResultsPerAccount = 20): Promise<readonly ConversationSummary[]> {
    if (this.#index) {
      await this.#ensureIndex()
      return this.#index.conversations(state)
    }
    const accounts = await this.accounts()
    const lists = await Promise.all(accounts.map((account) => this.#listAccountMessages(account, maxResultsPerAccount, state)))
    return groupConversations(lists.flat(), state)
  }

  async searchConversations(query: string, state: MailStateFilter, accountId?: string): Promise<readonly ConversationSummary[]> {
    if (!this.#index) throw new Error('Durable Gmail index is required for search')
    await this.#ensureIndex()
    return this.#index.searchConversations(query, state, accountId)
  }

  async listRecipients(query: string, accountId?: string): Promise<readonly MailAddress[]> {
    if (!this.#index) return []
    await this.#ensureIndex()
    return this.#index.recipients(query, accountId)
  }

  async mailboxCounts(accountId?: string): Promise<MailboxCounts> {
    if (!this.#index) throw new Error('Durable Gmail index is required for mailbox counts')
    await this.#ensureIndex()
    return this.#index.mailboxCounts(accountId)
  }

  async listMailboxConversations(mailbox: GmailMailbox, state: MailStateFilter, accountId?: string, query = ''): Promise<readonly ConversationSummary[]> {
    if (!this.#index) throw new Error('Durable Gmail index is required for mailbox lists')
    await this.#ensureIndex()
    if (mailbox === 'drafts') void this.refreshDrafts(accountId).catch(error => { if (!this.#stopped) this.#index?.failSync(String(error)) })
    return query
      ? this.#index.searchMailboxConversations(mailbox, query, state, accountId)
      : this.#index.mailboxConversations(mailbox, state, accountId)
  }

  /**
   * Gmail search lags minutes behind for a draft that was just created, so
   * the Drafts folder is refreshed from Gmail's own drafts list, which is
   * immediate: drafts the index has not seen are read and upserted, and
   * drafts Gmail no longer lists are dropped. A connector failure leaves the
   * indexed view as it was.
   */
  async #syncLiveDrafts(accountId?: string): Promise<void> {
    const index = this.#index
    if (!index) return
    const accounts = (await this.accounts()).filter((account) => !accountId || account.id === accountId)
    await Promise.all(accounts.map(async (account) => {
      const requestedAt = new Date().toISOString()
      let summaries: GmailDraftSummary[]
      try {
        summaries = await this.#listGmailDrafts(account.id)
      } catch (error) {
        if (this.#stopped) return
        index.failSync(String(error))
        process.stderr.write(`dispatch-mail: live drafts unavailable for ${account.email || account.name}: ${error instanceof Error ? error.message : String(error)}\n`)
        return
      }
      if (this.#stopped) return
      const indexed = new Map(index.messages(account.id).map((message) => [message.id, message]))
      const rows: IndexedGmailMessage[] = []
      for (const summary of summaries) {
        if (text(summary.metadata.email_ts) && text(summary.metadata.from_) && Array.isArray(summary.metadata.labels)) {
          rows.push({ ...projectGmailSearchEmail({ ...summary.metadata, id: summary.messageId, thread_id: summary.threadId }, account), ...folderFlagsFromLabels(array(summary.metadata.labels)) })
          continue
        }
        const known = indexed.get(summary.messageId)
        if (known) {
          rows.push({ ...known, inDrafts: true, inTrash: false, inSpam: false })
          continue
        }
        try {
          const message = await this.readMessage(account.id, summary.messageId)
          rows.push({ ...messageSummaryOf(message), inInbox: false, inSent: false, inDrafts: true, inArchive: false, inSpam: false, inTrash: false })
        } catch (error) {
          process.stderr.write(`dispatch-mail: could not read draft ${summary.messageId}: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
      const runId = `drafts:${new Date().toISOString()}:${randomUUID()}`
      if (this.#stopped) return
      index.replaceAccount(account.id, rows, runId, false)
      index.reconcileStream(account.id, 'drafts', summaries.map((row) => row.messageId), runId)
      this.#local.pruneDrafts(account.id, summaries.map(row => row.draftId), requestedAt)
      this.#draftsRevision = Math.max(Date.now(), this.#draftsRevision + 1)
    }))
  }

  /** Draft lists are local reads. Provider reconciliation runs once per scope. */
  async refreshDrafts(accountId?: string, force = false): Promise<void> {
    const key = accountId ?? '*'
    const running = this.#draftRefreshFlights.get(key)
    if (running) return running
    if (!force && Date.now() - (this.#draftRefreshAt.get(key) ?? 0) < 15_000) return
    this.#draftRefreshAt.set(key, Date.now())
    const flight = this.#syncLiveDrafts(accountId).finally(() => { this.#draftRefreshFlights.delete(key) })
    this.#draftRefreshFlights.set(key, flight)
    return flight
  }

  #rememberDraft(draft: DraftProjection, write = false, request?: number): void {
    if (!draft.accountId) return
    const key = `${draft.accountId}:${draft.id}`
    if (request !== undefined && this.#draftCacheRequests.get(key) !== request) return
    if (write) this.#draftCacheRequests.set(key, ++this.#draftCacheSequence)
    this.#drafts.set(`${draft.accountId}:${draft.id}`, draft)
    this.#local.putDraft(draft)
    if (write && this.#index && draft.gmailMessageId && draft.gmailThreadId) {
      const account = this.#index.accounts().find(item => item.id === draft.accountId)
      if (!account?.email) return
      const date = received(new Date().toISOString(), { messageId: draft.gmailMessageId, account: draft.accountId })
      this.#index.replaceAccount(draft.accountId, [{ id: draft.gmailMessageId, threadId: draft.gmailThreadId, accountId: draft.accountId, accountLabel: account?.email ?? draft.accountId, sender: sender(account?.email ?? ''), subject: draft.subject, receivedAt: date.iso, receivedLabel: date.label, receivedFullLabel: date.fullLabel, preview: draft.bodyText.slice(0,200), unread: false, inInbox: false, inSent: false, inDrafts: true, inArchive: false, inSpam: false, inTrash: false, hasAttachment: draft.attachments.length > 0 }], `draft-save:${Date.now()}`, false)
      this.#draftsRevision = Math.max(Date.now(), this.#draftsRevision + 1)
    }
  }

  async #listGmailDrafts(accountId: string): Promise<GmailDraftSummary[]> {
    const drafts: GmailDraftSummary[] = []
    let nextPageToken = ''
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      let value: unknown
      try {
        value = await this.#post('/v1/connectors/gmail/drafts/list', { linkId: accountId, maxResults: 100, nextPageToken })
      } catch (error) {
        throw draftConnectorError(error)
      }
      const content = structured(value)
      if (content.error !== undefined || record(value)?.isError === true) throw new Error(`Gmail drafts list failed: ${text(content.error) || 'connector error'}`)
      drafts.push(...array(content.drafts).map(gmailDraftSummary))
      const next = text(content.next_page_token)
      if (!next) return drafts
      if (next === nextPageToken) throw new Error(`Gmail draft pagination repeated page token ${next}`)
      nextPageToken = next
    }
    throw new Error('Gmail draft pagination exceeded 100 pages')
  }

  async #listAccountMessages(account: GmailAccountProjection, maxResults: number, state: MailStateFilter): Promise<readonly MessageSummary[]> {
    const spec = queueSearchSpec(state)
    return this.#searchAccountMessages(account, maxResults, spec.query, spec.labels)
  }

  async #searchAccountMessages(account: GmailAccountProjection, maxResults: number, query: string, labelIds: readonly string[]): Promise<readonly MessageSummary[]> {
    return (await this.#searchPage(account, maxResults, query, labelIds, '')).messages
  }

  async #searchPage(
    account: GmailAccountProjection,
    maxResults: number,
    query: string,
    labelIds: readonly string[],
    nextPageToken: string,
  ): Promise<{ messages: readonly IndexedGmailMessage[]; nextPageToken: string }> {
    const search = await this.#post('/v1/connectors/gmail/search-messages', {
      linkId: account.id, query, labelIds, maxResults, nextPageToken,
    })
    const content = structured(search)
    const messages: IndexedGmailMessage[] = []
    for (const email of array(content.emails)) {
      const value = record(email)
      const labels = array(value?.labels)
      const completed = text(value?.email_ts) ? email : await this.#withMessageTimestamp(account, value ?? {})
      messages.push({ ...projectGmailSearchEmail(completed, account), ...folderFlagsFromLabels(labels) })
    }
    return { messages, nextPageToken: text(content.next_page_token) }
  }

  /**
   * The connector's search projection omits email_ts for some messages, seen on
   * calendar auto-replies in Sent. The full message still carries Gmail's
   * internal date, so read it rather than failing the whole synchronization.
   * The fallback is named on stderr; a message with no timestamp anywhere still
   * fails with its id and account in the error.
   */
  async #withMessageTimestamp(account: GmailAccountProjection, email: UnknownRecord): Promise<UnknownRecord> {
    const messageId = text(email.id)
    if (!messageId) throw new Error(`Gmail search result in ${account.email || account.name} has no email_ts and no id`)
    const message = await this.readMessage(account.id, messageId)
    process.stderr.write(`dispatch-mail: search result ${messageId} in ${account.email || account.name} had no email_ts; using the message internal date ${message.receivedAt}\n`)
    return { ...email, email_ts: message.receivedAt }
  }

  async #ensureIndex(): Promise<void> {
    if (!this.#index) return
    const status = this.#index.status()
    if (this.#index.count() === 0) {
      if (status.state === 'idle') this.#scheduleSync(0, true)
      return
    }
    // Reads must not continually restart a failed account scan. The background
    // timer and explicit refresh own retries.
  }

  #scheduleSync(delayMs = 0, full = false): void {
    if (!this.#index || this.#retryTimer || this.#stopped) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      void (full ? this.syncNow() : this.refreshNow()).catch(error => { if (error?.name !== 'AbortError') this.#scheduleSync(60_000) })
    }, delayMs)
    this.#retryTimer.unref()
  }

  async #synchronize(maxPagesPerStream: number, requireComplete: boolean): Promise<void> {
    if (!this.#index) return
    if (this.#syncPromise) return this.#syncPromise
    return this.#runSync('full', async (signal) => {
      const startedAt = new Date().toISOString()
      const runId = `${startedAt}:${randomUUID()}`
      this.#index!.beginSync(startedAt)
      try {
        const accounts = await this.accounts()
        signal.throwIfAborted()
        if (accounts.length === 0) throw new Error('Cannot synchronize Gmail: no connector accounts are available')
        this.#index!.replaceAccounts(accounts, startedAt)
        this.#syncProgress = { accountCount: accounts.length, accountsCompleted: 0, pagesFetched: 0, fetchedMessages: 0, currentAccount: null }
        const completion: boolean[] = []
        for (const account of accounts) {
          this.#syncProgress.currentAccount = account.name
          const messages: IndexedGmailMessage[] = []
          const completeStreams: Array<{ flag: IndexStreamFlag; ids: string[] }> = []
          let complete = true
          for (const stream of INDEX_STREAMS) {
            let token = ''
            const streamIds: string[] = []
            for (let pageNumber = 0; pageNumber < maxPagesPerStream; pageNumber += 1) {
              const page = await this.#searchPage(account, 50, stream.query, stream.labelIds, token)
              signal.throwIfAborted()
              this.#syncProgress.pagesFetched += 1
              this.#syncProgress.fetchedMessages += page.messages.length
              messages.push(...page.messages)
              streamIds.push(...page.messages.map((message) => message.id))
              if (!page.nextPageToken) {
                token = ''
                break
              }
              if (page.nextPageToken === token) throw new Error(`Gmail pagination repeated a page token for account ${account.name}`)
              token = page.nextPageToken
            }
            if (token) {
              complete = false
              if (requireComplete) throw new Error(`Gmail pagination exceeded ${maxPagesPerStream} pages for account ${account.name}`)
            } else {
              completeStreams.push({ flag: stream.flag, ids: streamIds })
            }
          }
          this.#index!.replaceAccount(account.id, mergeIndexedMessages(messages), runId, complete)
          this.#mailRevision++
          for (const stream of completeStreams) this.#index!.reconcileStream(account.id, stream.flag, stream.ids, runId)
          completion.push(complete)
          this.#syncProgress.accountsCompleted += 1
        }
        this.#syncProgress.currentAccount = null
        this.#index!.pruneAccounts(accounts.map((account) => account.id))
        this.#local.pruneAccounts(accounts.map((account) => account.id))
        this.#index!.completeSync(new Date().toISOString(), completion.every(Boolean))
      } catch (error) {
        throw error
      }
    })
  }

  async readMessage(accountId: string, messageId: string): Promise<MessageProjection> {
    const account = await this.#account(accountId)
    const value = await this.#post('/v1/connectors/gmail/read', { linkId: accountId, messageId, format: 'full' })
    return projectGmailMessage(value, true, account)
  }

  async readConversation(accountId: string, threadId: string, downloadedOnly = false, mailbox: GmailMailbox = 'inbox'): Promise<ConversationProjection> {
    const cached = this.#local.conversation(accountId, threadId)
    if (downloadedOnly) {
      if (!cached) throw Object.assign(new Error('This conversation has not been downloaded. Go online and open it or download the mailbox.'), { code: 'not_downloaded' })
      return { ...conversationForMailbox(cached.conversation, mailbox), availability: { mode: 'downloaded', cachedAt: cached.cachedAt } }
    }
    try {
      const account = await this.#account(accountId)
      const value = await this.#post('/v1/connectors/gmail/read-thread', { linkId: accountId, threadId, maxMessages: 100 })
      const thread = structured(value)
      const messages = array(thread.messages).map((message) => projectGmailMessage({ structuredContent: message }, true, account))
      if (messages.length === 0) throw new Error('Gmail thread contains no readable messages')
      const conversation = projectConversation(messages, 'gmail')
      const cachedAt = this.#stopped ? new Date().toISOString() : this.#local.cache(conversation)
      return { ...conversationForMailbox(conversation, mailbox), availability: { mode: 'live', cachedAt } }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!cached || /not found|unknown account|401|403|404/i.test(detail) || !/timeout|timed out|fetch failed|aborted|ECONN|ENOTFOUND|503|unavailable/i.test(detail)) throw error
      return { ...conversationForMailbox(cached.conversation, mailbox), availability: { mode: 'downloaded', cachedAt: cached.cachedAt, reason: 'Gmail could not be reached.' } }
    }
  }

  offlineStatus() { return { ...this.#local.stats(), download: this.#download } }
  downloadedConversations(mailbox: GmailMailbox, state: MailStateFilter, accountId?: string, query = ''): readonly ConversationSummary[] {
    if (!this.#index) return []
    const keys = this.#local.cachedKeys()
    const conversations = query ? this.#index.searchMailboxConversations(mailbox, query, state, accountId) : this.#index.mailboxConversations(mailbox, state, accountId)
    return conversations.map(conversation => ({ ...conversation, downloaded: keys.has(`${conversation.accountId}:${conversation.threadId}`) }))
  }
  startOfflineDownload(mailbox: GmailMailbox, accountId?: string): OfflineDownload {
    if (this.#download?.state === 'running') return this.#download
    if (!this.#index) throw new Error('The Gmail index is required to download a mailbox')
    const queue = this.#index.mailboxConversations(mailbox, 'all', accountId)
    const job: OfflineDownload = { id: randomUUID(), state: 'running', mailbox, accountId, total: queue.length, completed: 0, errors: [], startedAt: new Date().toISOString() }
    this.#download = job; this.#local.putDownload(job)
    void (async () => {
      for (const conversation of queue) {
        if (job.state !== 'running' || this.#stopped) return
        try {
          const cached = this.#local.conversation(conversation.accountId!, conversation.threadId)
          let saved: ConversationProjection | undefined
          if (cached) { try { saved = conversationForMailbox(cached.conversation, mailbox) } catch {} }
          if (!saved || saved.latestMessageId !== conversation.latestMessageId || saved.messages.length < conversation.messageCount) {
            const loaded = await this.readConversation(conversation.accountId!, conversation.threadId, false, mailbox)
            if (loaded.availability?.mode === 'downloaded') throw new Error('Gmail is offline; the existing saved copy was kept.')
            if (loaded.messages.length < conversation.messageCount) throw new Error(`Only ${loaded.messages.length} of ${conversation.messageCount} indexed messages were returned. This conversation download is incomplete.`)
          }
          job.completed += 1
        } catch (error) { job.errors.push(`${conversation.subject}: ${error instanceof Error ? error.message : String(error)}`) }
        if (!this.#stopped && this.#download === job) this.#local.putDownload(job)
      }
      if (job.state === 'running' && !this.#stopped && this.#download === job) { job.state = job.errors.length ? 'partial' : 'complete'; this.#local.putDownload(job) }
    })()
    return job
  }
  cancelOfflineDownload(): void { if (this.#download?.state === 'running') { this.#download.state = 'cancelled'; this.#local.putDownload(this.#download) } }

  async setConversationUnread(accountId: string, threadId: string, unread: boolean, suppliedMessageIds?: readonly string[]): Promise<{ messageIds: readonly string[]; unread: boolean }> {
    if (!this.#index) throw new Error('Durable Gmail index is required for read-state mutations')
    const messageIds = suppliedMessageIds?.length ? suppliedMessageIds : this.#index.threadMessageIds(accountId, threadId)
    if (messageIds.length === 0) throw new Error('Conversation is not present in the Gmail index')
    this.#index.setUnread(accountId, messageIds, unread, true)
    void this.flushActions()
    return { messageIds, unread }
  }

  async mutateConversation(accountId: string, threadId: string, messageIds: readonly string[], action: GmailConversationAction): Promise<void> {
    if (!accountId || !threadId) throw new Error('Gmail conversation action requires account and thread identity')
    const effectiveMessageIds = messageIds.length ? messageIds : this.#index?.threadMessageIds(accountId, threadId) ?? []
    if (this.#index && effectiveMessageIds.length) {
      this.#index.applyConversationAction(accountId, effectiveMessageIds, action, true)
      void this.flushActions()
      return
    }
    if (action !== 'archive' && effectiveMessageIds.length === 0) throw new Error('Gmail conversation action found no indexed messages for this thread. Refresh Gmail and retry.')
    if (action === 'archive') await this.#post('/v1/connectors/gmail/archive', { linkId: accountId, threadIds: [threadId] })
    else if (action === 'trash') await this.#post('/v1/connectors/gmail/delete', { linkId: accountId, messageIds: effectiveMessageIds })
    else await this.#post('/v1/connectors/gmail/modify', {
      linkId: accountId,
      messageIds: effectiveMessageIds,
      addLabels: action === 'spam' ? ['SPAM'] : ['INBOX'],
      removeLabels: action === 'spam' ? ['INBOX'] : ['SPAM', 'TRASH'],
    })
    if (this.#index && effectiveMessageIds.length) this.#index.applyConversationAction(accountId, effectiveMessageIds, action)
    this.#scheduleSync(1_000)
  }

  /** Local acceptance is durable; idempotent label commands replay in order per account. */
  async flushActions(): Promise<void> {
    if (this.#actionFlight) return this.#actionFlight
    this.#actionFlight = (async () => {
      const blocked = new Set<string>()
      for (const job of this.#index?.pendingActions() ?? []) {
        if (this.#stopped) break
        if (blocked.has(job.accountId) || (this.#gmailBackoff.get(job.accountId) ?? 0) > Date.now()) continue
        try {
          const value = await this.#post('/v1/connectors/gmail/modify', {
            linkId: job.accountId, messageIds: job.messageIds,
            addLabels: job.action === 'unread' ? ['UNREAD'] : job.action === 'trash' ? ['TRASH'] : job.action === 'spam' ? ['SPAM'] : job.action === 'inbox' ? ['INBOX'] : [],
            removeLabels: job.action === 'read' ? ['UNREAD'] : job.action === 'unread' ? [] : job.action === 'inbox' ? ['TRASH', 'SPAM'] : ['INBOX'],
          })
          if (/"success":false/.test(JSON.stringify(value))) throw new Error('Gmail did not accept every message change')
          if (this.#stopped) return
          this.#index!.finishAction(job.id)
          this.#scheduleSync(1_000)
        } catch (error) {
          if (this.#stopped) return
          this.#index!.failAction(job.id, /429|RATE_LIMITED|temporarily unavailable/.test(String(error)) ? 'Waiting for Gmail to sync mail changes' : 'Mail changes are saved on this device but could not sync. Check the account connection.')
          blocked.add(job.accountId)
        }
      }
    })().finally(() => { this.#actionFlight = undefined })
    return this.#actionFlight
  }

  async createGmailDraft(accountId: string, messageId: string, to: string, cc: string, bcc: string, subject: string, bodyMarkdown: string, draftAttachments: readonly DraftAttachment[] = [], clientId?: string): Promise<DraftProjection> {
    if (!clientId) return this.#createGmailDraft(accountId, messageId, to, cc, bcc, subject, bodyMarkdown, draftAttachments)
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(clientId)) throw new Error('Invalid draft save identity')
    const key = `${accountId}:${clientId}`
    while (this.#draftCreates.has(key)) await this.#draftCreates.get(key)!.catch(() => undefined)
    const operation = (async () => {
      const prior = this.#local.draftCreate(accountId, clientId)
      let id = prior?.draftId
      if (prior && !id) {
        id = await this.#findDraftByClientMarker(accountId, clientId)
        if (!id && !prior.rejected) throw Object.assign(new Error('Waiting for Gmail to confirm the existing draft save.'), { code: 'draft_sync_pending' })
        if (id) this.#local.putDraftCreate(accountId, clientId, { draftId: id })
        else this.#local.removeDraftCreate(accountId, clientId)
      }
      if (id) {
        const existing = await this.readGmailDraft(accountId, id)
        return this.updateGmailDraft({ ...projectDraft({ id, accountId, inReplyToMessageId: messageId, to: addressList(to), cc, bcc, subject, bodyMarkdown, attachments: draftAttachments }), gmailThreadId: existing.gmailThreadId, gmailMessageId: existing.gmailMessageId })
      }
      // Resolve account/connectivity before recording a provider write intent.
      await this.#account(accountId)
      const retryAt = Math.max(this.#gmailBackoff.get(accountId) ?? 0, this.#local.retryAfter(accountId))
      if (retryAt > Date.now()) throw new Error(`Gmail is temporarily unavailable. Retry after ${new Date(retryAt).toISOString()}`)
      const readyAttachments = await this.#resolveDraftAttachments(accountId, draftAttachments)
      this.#local.putDraftCreate(accountId, clientId, {})
      try {
        const saved = await this.#createGmailDraft(accountId, messageId, to, cc, bcc, subject, bodyMarkdown, readyAttachments, `dispatch-${clientId}@draft.dispatch.local`)
        this.#local.putDraftCreate(accountId, clientId, { draftId: saved.id })
        return saved
      } catch (error) {
        if ((error as { code?: string }).code === 'gmail_backoff' || /HTTP status: (429|5\d\d)|RATE_LIMITED/.test(String(error))) this.#local.putDraftCreate(accountId, clientId, { rejected: true })
        const connectionCode = (error as { cause?: { code?: string } })?.cause?.code
        if (connectionCode === 'ECONNREFUSED' || connectionCode === 'ENOTFOUND' || /invalid.arguments|invalid.params|argument.binding|gmail_draft_create_unavailable|gmail_html_unsupported/i.test(String(error))) this.#local.removeDraftCreate(accountId, clientId)
        throw error
      }
    })()
    this.#draftCreates.set(key, operation)
    try { return await operation } finally { this.#draftCreates.delete(key) }
  }

  async #createGmailDraft(accountId: string, messageId: string, to: string, cc: string, bcc: string, subject: string, bodyMarkdown: string, draftAttachments: readonly DraftAttachment[], draftContentId?: string): Promise<DraftProjection> {
    const attachments = await this.#resolveDraftAttachments(accountId, draftAttachments)
    const draft = projectDraft({ id: '', inReplyToMessageId: messageId, to: addressList(to), cc, bcc, subject, bodyMarkdown, attachments, accountId })
    try {
      const value = structured(await this.#post('/v1/connectors/gmail/drafts/create', {
        linkId: accountId, replyMessageId: messageId || null, to, cc, bcc, subject,
        bodyMarkdown, bodyHtml: draft.bodyHtml, bodyText: bodyMarkdown,
        ...(draftContentId ? { draftContentId } : {}),
        ...attachments.length > 0 ? { attachments: connectorAttachments(attachments) } : {},
      }))
      const id = text(value.draft_id) || text(value.id)
      if (!id) throw new Error('Gmail did not return a draft ID')
      const returnedMessage = record(value.message)
      const saved = { ...draft, id, gmailMessageId: text(returnedMessage?.id) || text(value.message_id) || undefined, gmailThreadId: text(returnedMessage?.thread_id) || text(returnedMessage?.threadId) || text(value.thread_id) || undefined }
      this.#rememberDraft(saved, true)
      void this.#refreshIndexedDrafts(accountId)
      return saved
    } catch (error) {
      throw draftConnectorError(error)
    }
  }

  async updateGmailDraft(draft: DraftProjection, clientId?: string): Promise<DraftProjection> {
    if (!draft.accountId) throw new Error('Gmail draft is missing account identity')
    const existing = this.#drafts.get(`${draft.accountId}:${draft.id}`) ?? this.#local.draft(draft.accountId, draft.id)
    const attachments = await this.#resolveDraftAttachments(draft.accountId, draft.attachments, existing?.attachments ?? [])
    let saved = { ...draft, cachedAt: undefined, gmailThreadId: draft.gmailThreadId ?? existing?.gmailThreadId, gmailMessageId: draft.gmailMessageId ?? existing?.gmailMessageId, attachments }
    try {
      const result = structured(await this.#post('/v1/connectors/gmail/drafts/update', {
        linkId: draft.accountId, draftId: draft.id, to: draft.to.map((item) => item.address).join(', '),
        cc: draft.cc ?? '', bcc: draft.bcc ?? '', subject: draft.subject,
        bodyMarkdown: draft.bodyMarkdown, bodyHtml: draft.bodyHtml, bodyText: draft.bodyText,
        ...attachments.length > 0 ? { attachments: connectorAttachments(attachments) } : {},
      }))
      const message = record(result.message)
      saved = { ...saved, gmailMessageId: text(message?.id) || saved.gmailMessageId, gmailThreadId: text(message?.thread_id) || text(message?.threadId) || saved.gmailThreadId }
      this.#rememberDraft(saved, true)
      void this.#refreshIndexedDrafts(draft.accountId)
      return saved
    } catch (error) {
      if (isGmailNotFound(error)) {
        const replacement = await this.#replacementDraftId(draft.accountId, draft.id, saved.gmailThreadId, clientId)
        if (replacement) {
          this.#drafts.delete(`${draft.accountId}:${draft.id}`)
          this.#local.removeDraft(draft.accountId, draft.id)
          return this.updateGmailDraft({ ...draft, id: replacement })
        }
        this.#local.removeDraft(draft.accountId, draft.id)
        throw Object.assign(new Error(`Gmail draft ${draft.id} was not found`), { code: 'gmail_draft_not_found' })
      }
      throw draftConnectorError(error)
    }
  }

  async patchGmailDraft(accountId: string, draftId: string, fields: { to?: string; cc?: string; bcc?: string; subject?: string }): Promise<DraftProjection> {
    if (!accountId || !draftId || !Object.keys(fields).length) throw new Error('Draft identity and at least one header are required')
    await this.#post('/v1/connectors/gmail/drafts/update', { linkId: accountId, draftId, preserveContent: true, ...fields })
    return this.readGmailDraft(accountId, draftId)
  }

  async attachDraftFiles(accountId: string, draftId: string, paths: readonly string[]) {
    if (!paths.length || paths.some(path => !isAbsolute(path))) throw new Error('Supply absolute file paths to attach.')
    const media: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    const additions: DraftAttachment[] = []
    for (const path of paths) {
      const info = await stat(path)
      if (!info.isFile() || info.size > 25_000_000) throw new Error(`Not an attachable file (maximum 25 MB): ${basename(path)}`)
      additions.push({ name: basename(path), mediaType: media[extname(path).toLowerCase()] ?? 'application/octet-stream', contentBase64: (await readFile(path)).toString('base64') })
    }
    const summary = await this.#findGmailDraft(accountId, item => item.draftId === draftId)
    if (!summary) throw new Error('The draft no longer exists. Nothing was attached.')
    const raw = await this.#post('/v1/connectors/gmail/read', { linkId: accountId, messageId: summary.messageId, format: 'full' })
    const message = projectGmailMessage(raw, true, await this.#account(accountId))
    const originalBody = body(record(structured(raw).payload) ?? {})
    const existing = await this.#resolveDraftAttachments(accountId, draftAttachmentsFromMessage(message))
    const attachments = [...existing, ...additions]
    if (attachments.reduce((total, file) => total + Buffer.from(file.contentBase64!, 'base64').length, 0) > 25_000_000) throw new Error('Combined attachments exceed 25 MB. Nothing was attached.')
    const draft = this.#projectGmailDraft(summary, message, '', accountId)
    await this.updateGmailDraft({ ...draft, attachments, bodyHtml: originalBody.kind === 'sanitized-html' ? originalBody.content : draft.bodyHtml })
    const savedSummary = await this.#findGmailDraft(accountId, item => item.draftId === draftId)
    if (!savedSummary) throw new Error('Attachment update returned, but the saved draft could not be verified. Check Drafts before retrying.')
    const savedMessage = await this.readMessage(accountId, savedSummary.messageId)
    const savedFiles = await this.#resolveDraftAttachments(accountId, draftAttachmentsFromMessage(savedMessage))
    const hash = (file: DraftAttachment) => createHash('sha256').update(Buffer.from(file.contentBase64!, 'base64')).digest('hex')
    const remaining = [...savedFiles]
    for (const file of attachments) {
      const match = remaining.findIndex(saved => saved.name === file.name && hash(saved) === hash(file))
      if (match < 0) throw new Error(`The saved attachment bytes could not be verified for ${file.name}. Check Drafts before retrying.`)
      remaining.splice(match, 1)
    }
    return { draft: { ...this.#projectGmailDraft(savedSummary, savedMessage, '', accountId), attachments: savedFiles.map(({ contentBase64: _bytes, ...file }) => file) }, verifiedFiles: additions.map(file => ({ name: file.name, bytes: Buffer.from(file.contentBase64!, 'base64').length, sha256: hash(file) })) }
  }

  async readGmailDraft(accountId: string, draftId: string): Promise<DraftProjection> {
    const key = `${accountId}:${draftId}`
    const request = ++this.#draftCacheSequence
    this.#draftCacheRequests.set(key, request)
    let summary = await this.#findGmailDraft(accountId, (draft) => draft.draftId === draftId)
    if (!summary && this.#draftListLagMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#draftListLagMs))
      summary = await this.#findGmailDraft(accountId, (draft) => draft.draftId === draftId)
    }
    if (!summary) {
      if (this.#draftCacheRequests.get(key) !== request && this.#drafts.has(key)) return this.#drafts.get(key)!
      this.#local.removeDraft(accountId, draftId)
      throw Object.assign(new Error(`Gmail draft ${draftId} was not found`), { code: 'gmail_draft_not_found' })
    }
    const message = await this.readMessage(accountId, summary.messageId)
    const existing = this.#drafts.get(`${accountId}:${draftId}`)
    const draft = this.#projectGmailDraft(summary, message, existing?.inReplyToMessageId ?? summary.messageId, accountId, existing)
    this.#rememberDraft(draft, false, request)
    return this.#draftCacheRequests.get(key) === request ? draft : this.#drafts.get(key) ?? draft
  }

  /**
   * Every update_draft gives the draft a new message id, so the id the index
   * remembers goes stale between syncs. The thread id survives, so the draft is
   * matched by either.
   */
  async openGmailDraft(accountId: string, messageId: string, threadId = ''): Promise<DraftProjection> {
    const cached = this.#local.draftForMessage(accountId, messageId, threadId)
    if (cached) return cached
    const request = ++this.#draftCacheSequence
    const summary = await this.#findGmailDraft(accountId, (draft) => draft.messageId === messageId || draft.threadId === messageId || (threadId !== '' && draft.threadId === threadId))
    if (!summary) {
      const newer = this.#local.draftForMessage(accountId, messageId, threadId)
      if (newer) return newer
      // Gmail has no such draft any more (sent or deleted); stop listing it.
      this.#index?.discardDraftMessages(accountId, [messageId])
      throw Object.assign(new Error('This draft no longer exists in Gmail. It was sent or deleted.'), { code: 'gmail_draft_not_found' })
    }
    const message = await this.readMessage(accountId, summary.messageId)
    const draft = this.#projectGmailDraft(summary, message, messageId, accountId)
    const key = `${accountId}:${draft.id}`
    if ((this.#draftCacheRequests.get(key) ?? 0) < request) this.#draftCacheRequests.set(key, request)
    this.#rememberDraft(draft, false, request)
    return this.#draftCacheRequests.get(key) === request ? draft : this.#drafts.get(key) ?? draft
  }

  async discardGmailDraft(accountId: string, draftId: string): Promise<void> {
    const summary = await this.#findGmailDraft(accountId, (draft) => draft.draftId === draftId).catch(() => undefined)
    try {
      try {
        const result = await this.#post('/v1/connectors/gmail/drafts/discard', { linkId: accountId, draftId })
        if (record(result)?.isError || structured(result).error) throw new Error('Gmail did not confirm discarding the draft')
      } catch (error) {
        // Some installed connectors expose message Trash but no delete_draft.
        // Resolve the exact draft message first; never trash the whole thread.
        if (!summary || !String(error).includes('gmail_draft_discard_unavailable')) throw error
        const result = await this.#post('/v1/connectors/gmail/delete', { linkId: accountId, messageIds: [summary.messageId] })
        const confirmed = array(structured(result).responses).some(item => record(item)?.message_id === summary.messageId && record(item)?.success === true)
        if (record(result)?.isError || !confirmed) throw new Error('Gmail did not confirm moving the draft to Trash')
        if (await this.#findGmailDraft(accountId, candidate => candidate.draftId === draftId)) throw new Error('The draft was moved to Trash but Gmail still lists it. Refresh before retrying.')
      }
      this.#drafts.delete(`${accountId}:${draftId}`)
      this.#local.removeDraft(accountId, draftId)
      if (this.#index && summary) this.#index.discardDraftMessages(accountId, [summary.messageId])
      void this.#refreshIndexedDrafts(accountId)
    } catch (error) {
      throw draftConnectorError(error)
    }
  }

  sendReceipts(): SendReceipt[] { return this.#local.receipts() }
  sendReceipt(id: string): SendReceipt | undefined { return this.#local.receipt(id) }

  async verifySendReceipt(id: string): Promise<SendReceipt> {
    const receipt = this.#local.receipt(id)
    if (!receipt) throw new Error('Send receipt not found')
    if (!receipt.messageId || receipt.status === 'verified') return receipt
    try {
      const message = await this.readMessage(receipt.accountId, receipt.messageId)
      if (!message.labels?.includes('SENT')) throw new Error('The returned message is not marked Sent by Gmail.')
      const details: ReceiptDetails = { to: (message.to ?? []).map(item => item.address), cc: (message.cc ?? []).map(item => item.address), bcc: (message.bcc ?? []).map(item => item.address), subject: message.subject, attachments: message.attachments.map(item => ({ name: item.name, mediaType: item.mediaType, sizeLabel: item.sizeLabel })) }
      if (!details.to.length && !details.cc.length && !details.bcc.length) throw new Error('The sent copy has no verifiable recipients.')
      const warnings: string[] = []
      const expected = receipt.intended
      const same = (a: string[], b: string[]) => JSON.stringify(a.map(value => value.toLowerCase()).sort()) === JSON.stringify(b.map(value => value.toLowerCase()).sort())
      if (expected && (!same(expected.to, details.to) || !same(expected.cc, details.cc) || !same(expected.bcc, details.bcc))) warnings.push('Sent recipients differ from the saved draft snapshot.')
      if (expected && !same(expected.attachments.map(item => item.name), details.attachments.map(item => item.name))) warnings.push('Sent attachments differ from the saved draft snapshot.')
      const current = this.#stopped ? receipt : this.#local.receipt(id)
      if (current?.status === 'verified' || current?.messageId !== receipt.messageId) return current ?? receipt
      const verified: SendReceipt = { ...receipt, status: 'verified', detailsSource: 'sent-message', details, sentAt: message.receivedAt, verifiedAt: new Date().toISOString(), accountLabel: message.accountLabel ?? receipt.accountLabel, error: undefined, warnings }
      if (!this.#stopped) this.#local.putReceipt(verified)
      return verified
    } catch (error) {
      const current = this.#stopped ? receipt : this.#local.receipt(id)
      if (current?.status === 'verified' || current?.messageId !== receipt.messageId) return current ?? receipt
      const pending = { ...receipt, error: `Gmail accepted the send, but sent details could not be verified: ${error instanceof Error ? error.message : String(error)}` }
      if (!this.#stopped) this.#local.putReceipt(pending)
      return pending
    }
  }

  recordExternalSend(accountId: string, messageId: string, draftId?: string): SendReceipt {
    if (!accountId || !messageId) throw new Error('Account and Gmail message ID are required')
    const existing = this.#local.receiptForMessage(accountId, messageId) ?? (draftId ? this.#local.receiptForDraft(accountId, draftId) : undefined)
    if (existing?.status === 'verified') return existing
    const now = new Date().toISOString()
    const receipt: SendReceipt = { id: existing?.id ?? randomUUID(), accountId, accountLabel: existing?.accountLabel ?? this.#index?.accounts().find(account => account.id === accountId)?.email ?? accountId, draftId, requestedAt: existing?.requestedAt ?? now, acceptedAt: now, ...existing, messageId, status: 'accepted', detailsSource: existing?.detailsSource ?? 'unavailable', error: undefined }
    this.#local.putReceipt(receipt)
    void this.verifySendReceipt(receipt.id)
    return receipt
  }

  async sendGmailDraft(accountId: string, draftId: string): Promise<unknown> {
    if (!accountId || !draftId) throw new Error('Account and draft ID are required')
    const key = `${accountId}:${draftId}`
    const flight = this.#sendFlights.get(key)
    if (flight) return flight
    const previous = this.#local.receiptForDraft(accountId, draftId)
    if (previous && previous.status !== 'failed') return { structuredContent: { id: previous.messageId ?? null }, receipt: previous }
    const operation = this.#sendWithReceipt(accountId, draftId)
    this.#sendFlights.set(key, operation)
    try { return await operation } finally { this.#sendFlights.delete(key) }
  }

  async #sendWithReceipt(accountId: string, draftId: string): Promise<unknown> {
    let receipt: SendReceipt = { id: randomUUID(), accountId, accountLabel: accountId, draftId, requestedAt: new Date().toISOString(), status: 'preparing', detailsSource: 'unavailable' }
    this.#local.putReceipt(receipt)
    try {
      const draft = await this.readGmailDraft(accountId, draftId)
      const details: ReceiptDetails = { to: draft.to.map(item => item.address), cc: addressList(draft.cc ?? '').map(item => item.address), bcc: addressList(draft.bcc ?? '').map(item => item.address), subject: draft.subject, attachments: draft.attachments.map(item => ({ name: item.name, mediaType: item.mediaType, sizeLabel: item.sizeLabel })) }
      if (!details.to.length && !details.cc.length && !details.bcc.length) throw new Error('The saved Gmail draft has no recipients.')
      receipt = { ...receipt, details, intended: details, detailsSource: 'draft', accountLabel: (await this.#account(accountId)).email || accountId, status: 'sending' }
      // Durable intent is recorded before the provider call. A restart makes it unknown, never a retry.
      this.#local.putReceipt(receipt)
      const result = await this.#post('/v1/connectors/gmail/drafts/send', { linkId: accountId, draftId })
      const messageId = text(structured(result).id)
      if (record(result)?.isError || structured(result).error || !messageId) throw new Error('Gmail did not return a confirmed sent message ID.')
      receipt = { ...receipt, messageId, status: 'accepted', acceptedAt: new Date().toISOString() }
      this.#local.removeDraft(accountId, draftId)
      if (!this.#stopped) {
        this.#local.putReceipt(receipt)
        void this.verifySendReceipt(receipt.id)
        void this.#refreshIndexedDrafts()
      }
      return { ...(record(result) ?? {}), receipt }
    } catch (error) {
      receipt = { ...receipt, status: receipt.status === 'preparing' ? 'failed' : 'unknown', error: error instanceof Error ? error.message : String(error) }
      if (!this.#stopped) this.#local.putReceipt(receipt)
      return { receipt }
    }
  }

  async #refreshIndexedDrafts(accountId?: string): Promise<void> {
    try {
      if (accountId) await this.refreshDrafts(accountId, true)
      else await this.refreshNow()
    } catch {
      this.#scheduleSync(5_000)
    }
  }
  async readAttachment(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<unknown> {
    // The connector selects by attachment id. Sending the filename as well makes
    // the selector ambiguous when a message carries several files with one name.
    try {
      return await this.#post('/v1/connectors/gmail/attachment', { linkId: accountId, messageId, attachmentId })
    } catch (error) {
      if (!unsupportedAttachmentType((error as { connectorPayload?: unknown }).connectorPayload)) throw error
    }
    // The connector refuses types it cannot extract text from (calendar invites among them).
    // The raw RFC 2822 message still carries the bytes, so cut the part out of that.
    return this.#attachmentFromRawMessage(accountId, messageId, attachmentId, filename)
  }

  async #attachmentFromRawMessage(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<unknown> {
    const message = await this.readMessage(accountId, messageId)
    const target = message.attachments.find((item) => item.id === attachmentId) ?? message.attachments.find((item) => item.name === filename)
    if (!target) throw Object.assign(new Error(`Attachment ${filename || attachmentId} is not part of this message`), { code: 'attachment_not_found' })
    const twins = message.attachments.filter((item) => item.name === target.name && item.mediaType === target.mediaType)
    const ordinal = Math.max(0, twins.indexOf(target))
    const raw = text(structured(await this.#post('/v1/connectors/gmail/read', { linkId: accountId, messageId, format: 'raw' })).raw)
    if (!raw) throw new Error('Gmail did not return the raw message, so the attachment could not be read')
    const part = findPart(parseMime(decodeRawMessage(raw)), { filename: target.name, mimeType: target.mediaType, ordinal })
    if (!part) throw Object.assign(new Error(`Attachment ${target.name} was not found in the raw message`), { code: 'attachment_not_found' })
    return { structuredContent: { base64_url_content: part.body.toString('base64url'), mime_type: part.mimeType, size_bytes: part.body.length } }
  }

  async #account(accountId: string): Promise<GmailAccountProjection> {
    const account = (await this.accounts()).find((candidate) => candidate.id === accountId)
    if (!account) throw new Error('Unknown Gmail account')
    return account
  }

  /** Drafts Dispatch creates carry a Content-ID marker, so a draft whose Gmail id went stale can still be found. */
  async #findDraftByClientMarker(accountId: string, clientId: string): Promise<string | undefined> {
    const candidates: GmailDraftSummary[] = []
    await this.#findGmailDraft(accountId, draft => { candidates.push(draft); return false })
    for (const candidate of candidates) {
      const raw = await this.#post('/v1/connectors/gmail/read', { linkId: accountId, messageId: candidate.messageId, format: 'full' })
      const mime = record(structured(raw).payload) ?? {}
      if ([mime, ...parts(mime)].some(part => partContentId(part) === `dispatch-${clientId}@draft.dispatch.local`)) return candidate.draftId
    }
    return undefined
  }

  /**
   * A Gmail draft id goes stale when Gmail replaces the draft (a Codex update,
   * another client). The thread survives and Dispatch's own drafts carry a
   * marker, so the replacement can usually be found before giving up.
   */
  async #replacementDraftId(accountId: string, staleId: string, gmailThreadId?: string, clientId?: string): Promise<string | undefined> {
    if (gmailThreadId) {
      const byThread = await this.#findGmailDraft(accountId, (draft) => draft.threadId === gmailThreadId && draft.draftId !== staleId)
      if (byThread) return byThread.draftId
    }
    if (clientId) {
      const byMarker = await this.#findDraftByClientMarker(accountId, clientId)
      if (byMarker && byMarker !== staleId) return byMarker
    }
    return undefined
  }

  async #findGmailDraft(accountId: string, matches: (draft: GmailDraftSummary) => boolean): Promise<GmailDraftSummary | undefined> {
    let nextPageToken = ''
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      let value: unknown
      try {
        value = await this.#post('/v1/connectors/gmail/drafts/list', {
          linkId: accountId,
          maxResults: 100,
          nextPageToken,
        })
      } catch (error) {
        throw draftConnectorError(error)
      }
      const content = structured(value)
      const match = array(content.drafts).map(gmailDraftSummary).find(matches)
      if (match) return match
      const next = text(content.next_page_token)
      if (!next) return undefined
      if (next === nextPageToken) throw new Error(`Gmail draft pagination repeated page token ${next}`)
      nextPageToken = next
    }
    throw new Error('Gmail draft pagination exceeded 100 pages')
  }

  async #resolveDraftAttachments(accountId: string, items: readonly DraftAttachment[], stored: readonly DraftAttachment[] = []): Promise<DraftAttachment[]> {
    return Promise.all(items.map(async (item) => {
      if (item.contentBase64) return item
      const cached = stored.find((candidate) => candidate.contentBase64 && candidate.name === item.name && (candidate.id === item.id || !item.id))
      if (cached?.contentBase64) return { ...item, contentBase64: cached.contentBase64 }
      if (item.sourceMessageId && item.id) {
        return { ...item, contentBase64: await attachmentBytes(await this.readAttachment(accountId, item.sourceMessageId, item.id, item.name)) }
      }
      throw missingAttachmentBytes()
    }))
  }

  #projectGmailDraft(summary: GmailDraftSummary, message: MessageProjection, inReplyToMessageId: string, accountId: string, existing?: DraftProjection): DraftProjection {
    return { ...projectDraft({
      id: summary.draftId,
      inReplyToMessageId,
      to: addressList(summary.to),
      cc: summary.cc,
      bcc: summary.bcc,
      subject: summary.subject,
      bodyMarkdown: plainBodyFromMessage(message),
      attachments: existing?.attachments.length ? existing.attachments : draftAttachmentsFromMessage(message),
      accountId,
    }), gmailMessageId: summary.messageId, gmailThreadId: summary.threadId }
  }

  async #post(path: string, bodyValue: UnknownRecord): Promise<unknown> {
    const linkId = text(bodyValue.linkId)
    // A slow scan must not hold up a save. Lanes share account backoff.
    const lane = `${linkId}:${path.includes('search') ? 'sync' : /create|update|modify|archive|delete|discard|send/.test(path) ? 'write' : `${path}:${JSON.stringify(bodyValue)}`}`
    const previous = this.#connectorFlights.get(lane)
    const signal = this.#syncContext.getStore()
    const flight = (async () => { await previous?.catch(() => undefined); signal?.throwIfAborted(); return this.#postNow(path, bodyValue) })()
    this.#connectorFlights.set(lane, flight)
    try { return await flight } finally { if (this.#connectorFlights.get(lane) === flight) this.#connectorFlights.delete(lane) }
  }

  async #postNow(path: string, bodyValue: UnknownRecord): Promise<unknown> {
    const linkId = text(bodyValue.linkId)
    const retryAt = Math.max(this.#gmailBackoff.get(linkId) ?? 0, this.#local.retryAfter(linkId))
    if (retryAt > Date.now()) throw Object.assign(new Error(`Gmail is temporarily unavailable. Retry after ${new Date(retryAt).toISOString()}`), { code: 'gmail_backoff' })
    const response = await fetch(`${this.#agentBase}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyValue), signal: this.#syncContext.getStore() ? AbortSignal.any([this.#syncContext.getStore()!, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    const value = await response.json() as unknown
    if (response.status === 429 || /RATE_LIMITED|rateLimitExceeded|HTTP status: 429/.test(JSON.stringify(value))) {
      const date = /Retry after (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(JSON.stringify(value))?.[1]
      const retryAt = date ? Math.max(Date.now() + 60_000, Date.parse(date)) : Date.now() + 60_000
      this.#gmailBackoff.set(linkId, retryAt)
      if (!this.#stopped) this.#local.putRetryAfter(linkId, retryAt)
    }
    if (!response.ok) throw new Error(`Gmail connector request failed (${response.status}): ${JSON.stringify(value)}`)
    if (record(value)?.isError || structured(value).error) throw Object.assign(new Error(`Gmail connector rejected the request: ${JSON.stringify(value)}`), { connectorPayload: value })
    return value
  }
}

function messageSummaryOf(message: MessageProjection): MessageSummary {
  const { body: _body, attachments: _attachments, source: _source, to: _to, cc: _cc, ...summary } = message
  return summary
}
