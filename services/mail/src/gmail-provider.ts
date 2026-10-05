import { LocalMailStore, type SendReceipt, type ReceiptDetails, type OfflineDownload, type DraftConflictCopy } from './local-mail-store.js'
import { DraftSaveQueue, type DraftSaveFields, type DraftSaveJob } from './draft-save-queue.js'
import { conflictingDraftFields, draftChanges, DraftConflictError } from './draft-conflict.js'
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
import { GmailHistorySync, type GmailHistoryTransport, object as gmailObject } from './gmail-history-sync.js'
import { GmailOAuth, loadGmailOAuthConfig, type GmailDirectSyncStatus } from './gmail-oauth.js'
import type { AttachmentProjection, ConversationProjection, ConversationSummary, DraftAttachment, DraftProjection, GmailConversationAction, GmailMailbox, MailAddress, MailStateFilter, MailboxCounts, MessageProjection, MessageSummary } from './model.js'
import { decodeRawMessage, decodeText, findPart, isUnicodeCharset, mimeCharset, parseMime, partAt, UnsupportedCharsetError } from './mime-part.js'

export interface GmailAccountProjection {
  readonly id: string
  readonly connectorId: string
  readonly name: string
  readonly email: string
}

/** Normalize Google's REST casing at the adapter boundary; mail projections stay unchanged. */
export function projectGmailApiMessage(value: unknown, account: GmailAccountProjection): IndexedGmailMessage {
  const message = gmailObject(value)
  // Google omits empty repeated fields; a label-free message is valid archived mail.
  const labels = message.labelIds === undefined ? [] : message.labelIds
  if (!Array.isArray(labels) || !labels.every(label => typeof label === 'string')) throw new Error('Gmail API message has invalid labels')
  const payload = gmailObject(message.payload)
  const projection = projectGmailMessage({ structuredContent: { id: message.id, thread_id: message.threadId, label_ids: labels, internal_date: message.internalDate, snippet: message.snippet, payload } }, false, account)
  const files = (part: UnknownRecord): boolean => {
    if (typeof part.filename === 'string' && part.filename) return true
    if (part.parts !== undefined && !Array.isArray(part.parts)) throw new Error('Invalid Gmail API MIME parts')
    return Array.isArray(part.parts) && part.parts.some(child => files(gmailObject(child)))
  }
  return { ...projection, hasAttachment: files(payload), ...folderFlagsFromLabels(labels) }
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

/**
 * What each refresh checks by ID: every folder, plus Inbox's unread mail, which keeps Inbox read
 * state right past the first page of Unread. `scope` limits that check to Inbox rows.
 */
type HeadStream = { key: string; flag: IndexStreamFlag; query: string; labelIds: readonly string[]; scope?: IndexStreamFlag }
const HEAD_STREAMS: readonly HeadStream[] = [
  ...INDEX_STREAMS.slice(0, 2).map(stream => ({ ...stream, key: stream.flag })),
  { key: 'inboxUnread', flag: 'unread', scope: 'inbox', query: '-in:spam -in:trash', labelIds: ['INBOX', 'UNREAD'] },
  ...INDEX_STREAMS.slice(2).map(stream => ({ ...stream, key: stream.flag })),
]

/** Whether a message read in detail belongs in this stream, by its labels. */
function inHeadStream(message: IndexedGmailMessage, stream: HeadStream): boolean {
  const flags: Record<IndexStreamFlag, boolean> = { inbox: message.inInbox, unread: message.unread, sent: message.inSent, drafts: message.inDrafts, spam: message.inSpam, trash: message.inTrash, archive: message.inArchive }
  return flags[stream.flag] && (!stream.scope || flags[stream.scope])
}

/** A rate-limited account waits a minute, then twice as long after each further limit, up to this. */
const MAX_RATE_LIMIT_PAUSE_MS = 30 * 60_000

/** How Gmail and the connector spell a rate limit (Gmail also says userRateLimitExceeded). */
const RATE_LIMIT = /RATE_LIMITED|ratelimitexceeded|RESOURCE_EXHAUSTED|HTTP status: 429/i

/** A folder page's identity: its message IDs in any order, and whether more pages follow. */
function headKey(ids: readonly string[], nextPageToken: string): string {
  return `${[...ids].sort().join(',')}${nextPageToken ? '+more' : ''}`
}

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
  // Gmail's own error text can name the tool (delete_draft); a rate limit stays a rate limit.
  if ((error as { code?: unknown })?.code === 'gmail_backoff') return error as Error
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
    if (item.contentBase64 === undefined) throw missingAttachmentBytes()
    return { filename: item.name, mime_type: item.mediaType, data: item.contentBase64, ...item.contentId ? { contentId: item.contentId } : {} }
  })
}

function pendingAttachmentAppendFiles(job: DraftSaveJob): DraftAttachment[] {
  return (job.attachmentAppends ?? []).filter((intent) => !intent.applied && !intent.cancelled).flatMap((intent) => intent.attachments.map((file, index) => ({
    ...file,
    // Content-ID gives a Gmail-side marker for an append whose provider reply was lost.
    // The byte hash remains the fallback because connectors may strip Content-ID metadata.
    contentId: file.contentId ?? `dispatch-${intent.operationId}-${index}@draft.dispatch.local`,
  })))
}

function attachmentSha256(item: DraftAttachment): string {
  if (item.contentBase64 === undefined) throw missingAttachmentBytes()
  return createHash('sha256').update(Buffer.from(item.contentBase64, 'base64')).digest('hex')
}

function fileMatches(left: DraftAttachment, right: DraftAttachment): boolean {
  return left.name === right.name && left.mediaType === right.mediaType
    && left.contentBase64 !== undefined && right.contentBase64 !== undefined && attachmentSha256(left) === attachmentSha256(right)
}

function appendMissingFiles(existing: readonly DraftAttachment[], additions: readonly DraftAttachment[]): DraftAttachment[] {
  const result = [...existing]
  for (const file of additions) {
    // The connector may have accepted an update whose reply was lost. Re-reading the current
    // draft before retrying makes an identical name/type/hash a proof that this append landed.
    if (!result.some((saved) => fileMatches(saved, file))) result.push(file)
  }
  return result
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

/** The part the reader shows: the first HTML part with content, else the first plain-text part, else the message body. */
function bodySource(payload: UnknownRecord): { kind: MessageProjection['body']['kind']; part: UnknownRecord; content: string } | undefined {
  const all = [payload, ...parts(payload)]
  const html = all.find((part) => text(part.mime_type).toLowerCase() === 'text/html')
  const htmlContent = text(record(html?.body)?.content)
  if (html && htmlContent) return { kind: 'sanitized-html', part: html, content: htmlContent }
  const plain = all.find((part) => text(part.mime_type).toLowerCase() === 'text/plain')
  const plainContent = text(record(plain?.body)?.content)
  if (plain && plainContent) return { kind: 'plain-text', part: plain, content: plainContent }
  const messageContent = text(record(payload.body)?.content)
  return messageContent ? { kind: 'plain-text', part: payload, content: messageContent } : undefined
}

function body(payload: UnknownRecord): MessageProjection['body'] {
  const source = bodySource(payload)
  return source ? { kind: source.kind, content: source.content } : { kind: 'plain-text', content: 'This message has no readable text body.' }
}

/** Preserve Gmail's authored plain MIME alternative separately from its HTML body. */
function bodyText(payload: UnknownRecord): string | undefined {
  const all = [payload, ...parts(payload)]
  const plain = all.find((part) => text(part.mime_type).toLowerCase() === 'text/plain')
  const content = text(record(plain?.body)?.content)
  if (plain && content) return content
  const source = bodySource(payload)
  return source?.kind === 'plain-text' ? source.content : undefined
}

/**
 * The Gmail connector returns text in charsets other than UTF-8 wrongly: it
 * reads the part in its charset, then treats that UTF-8 as Latin-1, so a
 * Windows-1252 "é" arrives as "Ã©". Such a body part must be decoded from the
 * raw message instead. Returns that part, or undefined when the connector's
 * text is usable.
 */
export function bodyPartNeedingRawDecode(value: unknown): { partId: string; kind: MessageProjection['body']['kind'] } | undefined {
  const source = bodySource(record(structured(value).payload) ?? {})
  if (!source || isUnicodeCharset(mimeCharset(headers(source.part).get('content-type') ?? ''))) return undefined
  return { partId: text(source.part.part_id), kind: source.kind }
}

/** A projection with a (re)decoded body; HTML bodies point inline images at the mail service. */
function withBody(projection: MessageProjection, value: MessageProjection['body'], account?: GmailAccountProjection): MessageProjection {
  if (value.kind !== 'sanitized-html' || !account?.id) return { ...projection, body: value }
  return { ...projection, body: { kind: 'sanitized-html', content: rewriteCidImages(value.content, projection.id, account.id, projection.attachments) } }
}

function restoreDraftCidImages(html: string, message: MessageProjection): string {
  const mailBase = process.env.DISPATCH_MAIL_URL ?? 'http://127.0.0.1:8411'
  return message.attachments.reduce((content, attachment) => {
    if (!attachment.contentId || !attachment.id) return content
    const url = `${mailBase}/v1/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}?account=${encodeURIComponent(message.accountId ?? '')}&filename=${encodeURIComponent(attachment.name)}`
    return content.replaceAll(url, `cid:${attachment.contentId}`)
  }, html)
}

async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!) }
  }))
  return results
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
      id: text(partBody?.attachment_id) || (text(part.part_id) ? `mime-part:${text(part.part_id)}` : filename || contentId),
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
    bodyText: includeBody ? bodyText(payload) : undefined,
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
  return withBody(projection, projection.body, account)
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
  readonly #oauth: GmailOAuth
  readonly #history: GmailHistorySync | undefined
  readonly #draftQueue: DraftSaveQueue
  #draftQueueTimer: ReturnType<typeof setInterval> | undefined
  readonly #sendFlights = new Map<string, Promise<unknown>>()
  #download: OfflineDownload | undefined
  readonly #syncIntervalMs: number
  readonly #refreshIntervalMs: number
  #syncPromise: Promise<void> | undefined
  readonly #syncContext = new AsyncLocalStorage<AbortSignal>()
  #syncController: AbortController | undefined
  readonly #syncTimeouts = new Map<AbortSignal, ReturnType<typeof setTimeout>>()
  #inventoryError: string | undefined
  #inventorySnapshot: readonly GmailAccountProjection[] | undefined
  #inventoryRefresh: Promise<void> | undefined
  #inventoryCheckedAt = 0
  #syncKind: 'heads' | 'full' | undefined
  #syncStarted = 0
  #lastWakeRefresh = Number.NEGATIVE_INFINITY
  #wakeController: AbortController | undefined
  #wakeTimer: ReturnType<typeof setInterval> | undefined
  #mailRevision = Date.now()
  #syncTimer: ReturnType<typeof setInterval> | undefined
  #refreshTimer: ReturnType<typeof setInterval> | undefined
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #launchTimer: ReturnType<typeof setTimeout> | undefined
  readonly #launchSyncDelayMs: number
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
  /** When this service last created or updated each draft; Gmail's list can miss it for a few seconds after. */
  readonly #draftWrittenAt = new Map<string, number>()
  static readonly actionAccountWorkerLimit = 4
  #actionFlight: Promise<void> | undefined
  readonly #actionWorkers = new Map<string, Promise<void>>()
  #actionBlockedAccounts: Set<string> | undefined
  readonly #actionWakeWaiters = new Set<() => void>()
  #actionsPaused = false
  #actionTimer: ReturnType<typeof setInterval> | undefined
  #syncProgress: GmailSyncProgress = { accountCount: 0, accountsCompleted: 0, pagesFetched: 0, fetchedMessages: 0, currentAccount: null }
  /**
   * Each folder's first-page message IDs as last applied to the index, by account and stream.
   * Gmail rate limits an account that re-reads messages, so a refresh lists IDs (one cheap call)
   * and reads only messages the index lacks, does not show in that folder, or has a local change for.
   */
  readonly #heads = new Map<string, Map<string, { ids: string[]; more: boolean; recheck?: boolean }>>()
  /** Bumped when an account's copies are invalidated, so a read already in flight does not store an old copy. */
  readonly #headsEpoch = new Map<string, number>()
  /** Rate limits in a row per account; the pause doubles with each one. */
  readonly #rateLimitStreak = new Map<string, number>()
  /** Each account's drafts list as last seen, so the web reloads Drafts only when it changed. */
  readonly #draftLists = new Map<string, string>()

  constructor(
    agentBase = process.env.DISPATCH_AGENT_URL ?? 'http://127.0.0.1:8412',
    options: { historyTransport?: GmailHistoryTransport | false; localPath?: string; indexPath?: string | false; syncIntervalMs?: number; refreshIntervalMs?: number; draftListLagMs?: number; launchSyncDelayMs?: number } = {},
  ) {
    this.#agentBase = agentBase
    const indexPath = options.indexPath === false
      ? undefined
      : options.indexPath ?? process.env.DISPATCH_MAIL_DB ?? defaultIndexPath()
    this.#index = indexPath ? new GmailIndex(indexPath) : undefined
    this.#draftListLagMs = options.draftListLagMs ?? 1_500
    this.#local = new LocalMailStore(options.localPath ?? (indexPath && indexPath !== ':memory:' ? `${indexPath}.local` : ':memory:'))
    let configuration: ReturnType<typeof loadGmailOAuthConfig>
    let configurationError: string | undefined
    try { configuration = loadGmailOAuthConfig() } catch (error) { configurationError = error instanceof Error ? error.message : String(error) }
    this.#oauth = new GmailOAuth(configuration, undefined, {
      configurationError, onConnected: accountId => { this.#index?.setDirectSyncEnabled(accountId, true); this.requestRefresh('manual') },
      retryAfter: accountId => this.#local.retryAfter(accountId),
      pauseUntil: (accountId, timestamp) => this.#local.putRetryAfter(accountId, timestamp),
    })
    this.#history = this.#index && options.historyTransport !== false ? new GmailHistorySync(this.#index, options.historyTransport ?? this.#oauth, projectGmailApiMessage, 1_000, signal => {
      if (this.#syncController?.signal !== signal) return
      this.#syncKind = 'full'
      clearTimeout(this.#syncTimeouts.get(signal))
      const timeout = setTimeout(() => this.#syncController?.signal === signal && this.#syncController.abort(new Error('Gmail baseline synchronization timed out; retrying.')), 900_000)
      timeout.unref(); this.#syncTimeouts.set(signal, timeout)
    }, kind => { if (kind === 'page') this.#syncProgress.pagesFetched++; else this.#syncProgress.fetchedMessages++ }) : undefined
    this.#draftQueue = new DraftSaveQueue(this.#local, {
      create: job => this.createGmailDraft(job.accountId, job.messageId, job.fields.to ?? '', job.fields.cc ?? '', job.fields.bcc ?? '', job.fields.subject ?? '', job.fields.bodyMarkdown ?? '', appendMissingFiles(job.fields.attachments ?? [], pendingAttachmentAppendFiles(job)), job.id),
      read: (accountId, id) => this.readGmailDraft(accountId, id, true),
      update: async (job, current) => {
        const fields = draftChanges(job.fields, job.base)
        const conflicts = conflictingDraftFields(fields, job.base, current)
        if (conflicts.length) throw new DraftConflictError(conflicts, current)
        const additions = pendingAttachmentAppendFiles(job)
        if (!Object.keys(fields).length && additions.length === 0) return current
        if (fields.bodyMarkdown === undefined && fields.attachments === undefined && additions.length === 0) return this.patchGmailDraft(job.accountId, current.id, fields, true)
        if (fields.bodyMarkdown === undefined && fields.attachments === undefined && additions.length > 0
          && additions.every((file) => current.attachments.some((saved) => fileMatches(saved, file)))) return current
        const baseAttachments = fields.attachments ?? current.attachments
        const attachments = appendMissingFiles(baseAttachments, additions)
        if (attachments.reduce((total, file) => total + Buffer.from(file.contentBase64 ?? '', 'base64').length, 0) > 25_000_000) throw Object.assign(new Error('Combined attachments exceed 25 MB. Remove a file before retrying.'), { code: 'draft_attachment_too_large' })
        const projected = projectDraft({ ...current, ...fields, to: fields.to === undefined ? current.to : addressList(fields.to), attachments })
        const draft = {
          ...projected,
          bodyHtml: fields.bodyMarkdown === undefined ? current.bodyHtml : projected.bodyHtml,
          bodyText: fields.bodyMarkdown === undefined ? current.bodyText : projected.bodyText,
          gmailThreadId: current.gmailThreadId,
          gmailMessageId: current.gmailMessageId,
        }
        return this.updateGmailDraft(draft, undefined, true)
      },
      discard: (accountId, id) => this.discardGmailDraft(accountId, id, true),
      findCreated: async (accountId, id) => {
        const intent = this.#local.draftCreate(accountId, id)
        if (!intent) return undefined
        const found = intent.draftId ?? await this.#findDraftByClientMarker(accountId, id)
        if (!found && !intent.rejected) throw new Error('Waiting for Gmail to confirm a cancelled save')
        return found
      },
    }, () => { this.#draftsRevision = Math.max(Date.now(), this.#draftsRevision + 1) })
    this.#download = this.#local.download()
    this.#syncIntervalMs = options.syncIntervalMs ?? 6 * 60 * 60 * 1000
    this.#refreshIntervalMs = options.refreshIntervalMs ?? 60_000
    this.#launchSyncDelayMs = options.launchSyncDelayMs ?? 60_000
  }

  startBackgroundSync(): void {
    if (!this.#draftQueueTimer) {
      void this.#draftQueue.flush()
      this.#draftQueueTimer = setInterval(() => { void this.#draftQueue.flush() }, 3_000)
      this.#draftQueueTimer.unref()
    }
    if (!this.#index || this.#syncTimer) return
    this.#stopped = false
    const clock = new ResumeClock()
    this.#wakeTimer = setInterval(() => { if (clock.observe()) this.requestRefresh('wake') }, 5_000)
    this.#wakeTimer.unref()
    void this.flushActions()
    this.#actionTimer = setInterval(() => { void this.flushActions() }, 5_000)
    this.#actionTimer.unref()
    if (this.#index.count() > 0) {
      this.requestRefresh('startup')
      // Folder departures are judged against the last list seen, which a new process lacks: one cheap
      // ID-only full sync after launch settles what changed while Dispatch was not running.
      this.#launchTimer = setTimeout(() => { void this.#fullSyncWhenIdle() }, this.#launchSyncDelayMs)
      this.#launchTimer.unref()
    } else this.#scheduleSync(0, true)
    this.#syncTimer = setInterval(() => { void this.#fullSyncWhenIdle() }, this.#syncIntervalMs)
    this.#syncTimer.unref()
    this.#refreshTimer = setInterval(() => { this.requestRefresh('periodic') }, this.#refreshIntervalMs)
    this.#refreshTimer.unref()
  }

  stopBackgroundSync(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#actionsPaused = true
    this.#wakeActionBatch()
    this.#draftQueue.stop()
    this.#oauth.stop()
    if (this.#draftQueueTimer) clearInterval(this.#draftQueueTimer)
    this.#syncController?.abort()
    if (this.#wakeTimer) clearInterval(this.#wakeTimer)
    if (this.#actionTimer) clearInterval(this.#actionTimer)
    if (this.#syncTimer) clearInterval(this.#syncTimer)
    if (this.#launchTimer) clearTimeout(this.#launchTimer)
    if (this.#refreshTimer) clearInterval(this.#refreshTimer)
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#syncTimer = undefined
    this.#refreshTimer = undefined
    this.#retryTimer = undefined
    this.cancelOfflineDownload()
    this.#index?.close()
    this.#local.close()
  }

  syncStatus(): (GmailSyncStatus & Partial<GmailSyncProgress> & { reconnectRequired?: boolean }) | undefined {
    const indexedStatus = this.#index?.status()
    const status = indexedStatus ? { ...indexedStatus, draftsRevision: this.#draftsRevision, mailRevision: this.#mailRevision, reconnectRequired: this.#draftQueue.pending().some(job => job.reconnect) || /token_revoked|invalidated oauth|unauthorized/i.test(indexedStatus.error ?? '') } : undefined
    const pending = this.#index?.pendingActions() ?? []
    if (status && pending.length) return { ...status, ...this.#syncProgress, state: 'partial', error: pending.find(job => job.error)?.error ?? `${pending.length} mail changes waiting to sync` }
    return status ? { ...status, ...this.#syncProgress } : undefined
  }

  async syncNow(): Promise<void> {
    return this.#synchronize(100, true)
  }

  /** A full sync after whatever sync is running: joining a quick check would skip it until the next interval. */
  async #fullSyncWhenIdle(): Promise<void> {
    while (this.#syncPromise) await this.#syncPromise.catch(() => undefined)
    if (this.#stopped) return
    await this.syncNow().catch(() => undefined)
  }

  requestRefresh(reason = 'manual'): void {
    if (this.#stopped) return
    if (reason === 'manual' || reason === 'wake') this.#draftQueue.retryNow()
    const syncAge = Date.now() - this.#syncStarted
    if (reason === 'wake') {
      const now = Date.now()
      // Join another wake detector's replacement, never an arbitrary pre-wake scan.
      if (this.#syncPromise && this.#wakeController === this.#syncController && now >= this.#lastWakeRefresh && now - this.#lastWakeRefresh < 15_000) return
      this.#lastWakeRefresh = now
    }
    // A full sync takes minutes and must be allowed to finish; a stuck quick check is replaced.
    if (this.#syncPromise && (reason === 'wake' || reason === 'manual' || (this.#syncKind === 'heads' && syncAge > 180_000))) {
      this.#syncController?.abort()
      this.#syncPromise = undefined
    }
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = undefined }
    void this.refreshNow({ details: reason === 'manual' }).catch(error => {
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
    this.#syncTimeouts.set(controller.signal, timeout)
    const flight = this.#syncContext.run(controller.signal, () => work(controller.signal)).catch(error => {
      if (!this.#stopped && this.#syncController === controller && error?.name !== 'AbortError') this.#index?.failSync(String(error))
      throw error
    }).finally(() => {
      clearTimeout(timeout)
      clearTimeout(this.#syncTimeouts.get(controller.signal)); this.#syncTimeouts.delete(controller.signal)
      if (this.#syncPromise === flight) { this.#syncPromise = undefined; this.#syncController = undefined; this.#syncKind = undefined }
    })
    this.#syncPromise = flight
    return flight
  }

  /**
   * Checks every folder's first page by ID and reads only messages the index needs. An account the
   * index has never seen, or `details` (the user pressed Refresh), reads every folder's first page.
   */
  async refreshNow(options: { details?: boolean } = {}): Promise<void> {
    if (!this.#index) return
    if (this.#syncPromise) return this.#syncPromise
    return this.#runSync('heads', async (signal) => {
      const startedAt = new Date().toISOString()
      const runId = `${startedAt}:${randomUUID()}`
      this.#index!.beginSync(startedAt)
      const accounts = await this.#accountsForSync()
      signal.throwIfAborted()
      if (accounts.length === 0) throw new Error('Cannot refresh Gmail: no connector accounts are available')
      this.#index!.replaceAccounts(accounts, startedAt)
      this.#syncProgress = { accountCount: accounts.length, accountsCompleted: 0, pagesFetched: 0, fetchedMessages: 0, currentAccount: null }
      const results = await Promise.allSettled(accounts.map(async (account) => {
        if (await this.#history?.synchronize(account, signal)) {
          signal.throwIfAborted()
          this.#mailRevision++; this.#syncProgress.accountsCompleted++
          return
        }
        if (this.#inventoryError) throw new Error(this.#inventoryError)
        const fresh = options.details === true || this.#index!.count(account.id) === 0
        // Every message read in this pass, merged: each folder's page adds to it and none undoes another.
        const readThisPass: IndexedGmailMessage[] = []
        for (const stream of HEAD_STREAMS) {
          // Reading Inbox and Unread in detail already carries Inbox read state.
          if (fresh && stream.scope) continue
          const epoch = this.#headsEpoch.get(account.id) ?? 0
          let ids: string[]
          let nextPageToken: string
          let read: readonly IndexedGmailMessage[] | undefined
          // Messages read earlier in this pass: their labels may have changed since.
          const readBefore = readThisPass.slice()
          if (fresh) {
            const page = await this.#searchPage(account, 50, stream.query, stream.labelIds, '')
            signal.throwIfAborted()
            read = page.messages
            ids = page.messages.map(message => message.id)
            nextPageToken = page.nextPageToken
          } else {
            ({ ids, nextPageToken } = await this.#listIds(account, stream, ''))
            signal.throwIfAborted()
            const known = this.#heads.get(account.id)?.get(stream.key)
            // Unchanged IDs need nothing, unless a message read earlier in this pass disagrees with the list:
            // it changed between that read and this list, so the folder is judged again.
            const listedNow = new Set(ids)
            const disagrees = readBefore.some(message => inHeadStream(message, stream) !== listedNow.has(message.id) && (listedNow.has(message.id) || !nextPageToken))
            if (known && !known.recheck && !disagrees && headKey(known.ids, known.more ? 'more' : '') === headKey(ids, nextPageToken)) continue
            const needed = this.#needsDetails(account.id, stream.flag, ids).filter(position => !readThisPass.some(message => message.id === ids[position]))
            if (needed.length) {
              read = (await this.#searchPage(account, Math.max(...needed) + 1, stream.query, stream.labelIds, '')).messages
              signal.throwIfAborted()
            }
          }
          if (read) {
            readThisPass.push(...read)
            this.#index!.replaceAccount(account.id, mergeIndexedMessages(readThisPass), runId, false)
            this.#syncProgress.pagesFetched++; this.#syncProgress.fetchedMessages += read.length
          }
          // Messages that left the folder lose it. A complete list says so directly. A first page with more
          // behind it says so only for a message that was on the previous page, is missing now, and sat
          // high enough that the new arrivals could not have pushed it off the page: Gmail's own order,
          // not message dates, which senders can skew. Past the page, only a full sync can tell.
          const previous = this.#heads.get(account.id)?.get(stream.key)
          const listed = new Set(ids)
          const arrivals = ids.filter(id => !previous?.ids.includes(id)).length
          const { cleared, conflicts: left } = !nextPageToken
            ? this.#index!.reconcileStream(account.id, stream.flag, ids, runId, { scope: stream.scope, remove: false })
            : this.#index!.clearFlagFor(account.id, stream.flag, (previous?.ids ?? []).filter((id, position) => !listed.has(id) && position + arrivals < ids.length), runId, stream.scope)
          if (read?.length || cleared) this.#mailRevision++
          // A message that changed between an earlier read and this list, leaving or entering it: keep the
          // list but judge the folder again next time, when that row is no longer this pass's.
          const entered = readBefore.filter(message => listed.has(message.id) && !inHeadStream(message, stream)).length
          this.#rememberHead(account.id, stream.key, ids, nextPageToken, epoch, left + entered > 0)
        }
        // Every folder has been seen: rows left in none are gone from Gmail (deleted, Trash emptied).
        if (this.#index!.removeFolderless(account.id)) this.#mailRevision++
        this.#syncProgress.accountsCompleted++
      }))
      signal.throwIfAborted()
      this.#index!.pruneAccounts(accounts.map((account) => account.id))
      this.#local.pruneAccounts(accounts.map((account) => account.id))
      for (const accountId of this.#heads.keys()) if (!accounts.some(account => account.id === accountId)) this.#heads.delete(accountId)
      // Name each failed account: one rate-limited account must not read as every account being stale.
      const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${accounts[index]!.email || accounts[index]!.name}: ${String(result.reason)}`] : [])
      if (failed.length) throw new Error(failed.join('; '))
      this.#index!.completeSync(new Date().toISOString(), true)
    })
  }

  cachedAccounts(): readonly GmailAccountProjection[] { return this.#index?.accounts() ?? [] }
  async directSyncStatus(): Promise<GmailDirectSyncStatus> {
    const status = await this.#oauth.status(this.cachedAccounts())
    return { ...status, accounts: status.accounts.map(account => this.#index?.directSyncDisabled(account.accountId) ? { ...account, state: 'connector', error: undefined } : account) }
  }
  useConnectorSync(accountId: string): void {
    if (!this.cachedAccounts().some(account => account.id === accountId)) throw new Error('Select a connected Gmail account')
    if (this.#oauth.activeOperations) throw new Error('Finish Google sign-in or token renewal before changing the sync connection')
    this.#index?.setDirectSyncEnabled(accountId, false)
    this.requestRefresh('manual')
  }
  async connectDirectSync(accountId: string): Promise<{ authUrl: string } | { connected: true }> {
    const account = this.cachedAccounts().find(account => account.id === accountId)
    if (!account?.email) throw new Error('Select a connected Gmail account before authorizing direct sync')
    return this.#oauth.beginConnect(account)
  }
  runtimeStatus(): { activeOperations: number } { return { activeOperations: this.#sendFlights.size + this.#draftCreates.size + this.#actionWorkers.size + Number(this.#draftQueue.active) + this.#oauth.activeOperations } }

  async accounts(): Promise<readonly GmailAccountProjection[]> {
    try {
      const signal = this.#syncContext.getStore()
      const response = await fetch(`${this.#agentBase}/v1/connectors/gmail`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
      const value = await response.json() as unknown
      if (!response.ok) throw new Error(`Gmail inventory failed (${response.status})`)
      const inventory = record(value)
      this.#inventoryError = undefined
      const accounts = array(inventory?.accounts).map((account) => {
        const item = record(account)
        const id = text(item?.linkId)
        if (!id) throw new Error('Gmail inventory contains an account without linkId')
        return { id, connectorId: text(item?.connectorId), name: text(item?.name) || 'Gmail', email: text(item?.email) }
      })
      this.#inventorySnapshot = accounts
      return accounts
    } catch (error) {
      this.#syncContext.getStore()?.throwIfAborted()
      const indexed = this.#index?.accounts() ?? []
      if (indexed.length === 0) throw error
      this.#inventoryError = `Gmail account refresh failed: ${error instanceof Error ? error.message : String(error)}`
      const direct = this.#history ? await Promise.allSettled(indexed.map(account => this.#index?.directSyncDisabled(account.id) ? false : this.#history!.transport.connected(account))) : []
      if (!direct.length || direct.some(result => result.status !== 'fulfilled' || !result.value)) this.#index?.failSync(this.#inventoryError)
      return indexed
    }
  }

  async #accountsForSync(): Promise<readonly GmailAccountProjection[]> {
    const known = this.#inventorySnapshot ?? this.cachedAccounts()
    const direct = this.#history && known.length ? await Promise.allSettled(known.map(account => this.#index?.directSyncDisabled(account.id) ? false : this.#history!.transport.connected(account))) : []
    if (direct.length && direct.every(result => result.status === 'fulfilled' && result.value)) {
      // Google authorization is already bound to each durable account. Mail history need not
      // wait for App Server to restart; connector discovery continues independently.
      if (!this.#inventoryRefresh && Date.now() - this.#inventoryCheckedAt >= 60_000) {
        this.#inventoryCheckedAt = Date.now()
        this.#inventoryRefresh = this.accounts().then(() => undefined).catch(() => undefined).finally(() => { this.#inventoryRefresh = undefined })
      }
      return known
    }
    return this.accounts()
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
    const counts = this.#index.mailboxCounts(accountId)
    return { ...counts, drafts: this.#projectQueuedDrafts(this.#index.mailboxConversations('drafts', 'all', accountId), 'all', accountId).length }
  }

  async listMailboxConversations(mailbox: GmailMailbox, state: MailStateFilter, accountId?: string, query = ''): Promise<readonly ConversationSummary[]> {
    if (!this.#index) throw new Error('Durable Gmail index is required for mailbox lists')
    await this.#ensureIndex()
    if (mailbox === 'drafts') void this.refreshDrafts(accountId).catch(error => { if (!this.#stopped) this.#index?.failSync(String(error)) })
    const indexed = query
      ? this.#index.searchMailboxConversations(mailbox, query, state, accountId)
      : this.#index.mailboxConversations(mailbox, state, accountId)
    if (mailbox !== 'drafts') return indexed
    return this.#projectQueuedDrafts(indexed, state, accountId, query)
  }

  #projectQueuedDrafts(indexed: readonly ConversationSummary[], state: MailStateFilter, accountId?: string, query = ''): readonly ConversationSummary[] {
    const queued = this.#draftQueue.pending(accountId).filter(job => state !== 'unread' && (!query || `${job.draft.subject} ${job.draft.bodyMarkdown}`.toLowerCase().includes(query.toLowerCase())))
    const rows: ConversationSummary[] = queued.map(job => {
      const date = received(job.createdAt)
      const account = this.#index!.accounts().find(account => account.id === job.accountId)
      return { id: `${job.accountId}:${job.id}`, threadId: job.draft.gmailThreadId ?? job.id, latestMessageId: job.id, accountId: job.accountId,
        accountLabel: account?.email, sender: sender(account?.email ?? job.accountId), subject: job.draft.subject || '(No subject)', receivedAt: date.iso,
        receivedLabel: date.label, receivedFullLabel: date.fullLabel, preview: job.draft.bodyText, unread: false, messageCount: 1, hasAttachment: job.draft.attachments.length > 0 }
    })
    const hidden = [...queued, ...this.#draftQueue.cancelled()]
    return [...rows, ...indexed.filter(row => !hidden.some(job => job.accountId === row.accountId && job.draft.gmailThreadId && job.draft.gmailThreadId === row.threadId))].sort((a,b) => b.receivedAt.localeCompare(a.receivedAt))
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
      // The web reloads Drafts on a new revision and that reload lists drafts again: bump it only
      // when Gmail's drafts list changed, or the two keep each other going.
      const listed = summaries.map(row => `${row.draftId}:${row.messageId}`).sort().join(',')
      if (this.#draftLists.get(account.id) === listed) return
      this.#draftLists.set(account.id, listed)
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
    if (write) { this.#draftCacheRequests.set(key, ++this.#draftCacheSequence); this.#draftWrittenAt.set(key, Date.now()) }
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
      if (!Array.isArray(content.drafts)) throw new Error('Gmail drafts list returned no drafts array')
      drafts.push(...content.drafts.map(gmailDraftSummary))
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

  /** One page of a folder's message IDs: a single Gmail list call, no message reads. */
  async #listIds(account: GmailAccountProjection, stream: { query: string; labelIds: readonly string[] }, pageToken: string): Promise<{ ids: string[]; nextPageToken: string }> {
    const content = structured(await this.#post('/v1/connectors/gmail/search', {
      linkId: account.id, query: stream.query, labelIds: stream.labelIds, maxResults: 50, nextPageToken: pageToken,
    }))
    const ids = content.message_ids
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new Error(`Gmail ID search for ${account.email || account.name} returned no message_ids`)
    return { ids: ids as string[], nextPageToken: text(content.next_page_token) }
  }

  /** Positions of listed messages the index needs read: unknown, not shown in this folder, or with a local change awaiting Gmail. */
  #needsDetails(accountId: string, flag: IndexStreamFlag, ids: readonly string[]): number[] {
    const rows = this.#index!.rowsByIds(accountId, ids)
    return ids.flatMap((id, position) => {
      const row = rows.get(id)
      return !row || !row.flags[flag] || row.pending ? [position] : []
    })
  }

  #rememberHead(accountId: string, key: string, ids: readonly string[], nextPageToken: string, epoch: number, recheck = false): void {
    if ((this.#headsEpoch.get(accountId) ?? 0) !== epoch) return
    const heads = this.#heads.get(accountId) ?? new Map<string, { ids: string[]; more: boolean; recheck?: boolean }>()
    heads.set(key, { ids: [...ids], more: Boolean(nextPageToken), recheck })
    this.#heads.set(accountId, heads)
  }

  /** Makes the next refresh judge this folder again. Its last list stays: departures are read against it. */
  #forgetHead(accountId: string, flag: IndexStreamFlag): void {
    const known = this.#heads.get(accountId)?.get(flag)
    if (known) known.recheck = true
    this.#headsEpoch.set(accountId, (this.#headsEpoch.get(accountId) ?? 0) + 1)
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
        const accounts = await this.#accountsForSync()
        signal.throwIfAborted()
        if (accounts.length === 0) throw new Error('Cannot synchronize Gmail: no connector accounts are available')
        this.#index!.replaceAccounts(accounts, startedAt)
        this.#syncProgress = { accountCount: accounts.length, accountsCompleted: 0, pagesFetched: 0, fetchedMessages: 0, currentAccount: null }
        const completion: boolean[] = []
        const results = await Promise.allSettled(accounts.map(async account => {
          this.#syncProgress.currentAccount = account.name
          // Authorized accounts catch every off-head change through history. The six-hour scan
          // is unnecessary for them; only an expired checkpoint triggers a fresh baseline.
          if (await this.#history?.synchronize(account, signal)) {
            this.#mailRevision++; completion.push(true); this.#syncProgress.accountsCompleted++
            return
          }
          if (this.#inventoryError) throw new Error(this.#inventoryError)
          // An account the index has never seen is read in full. Otherwise every folder is listed by
          // ID and only messages the index lacks, or does not show in that folder, are read.
          const fresh = this.#index!.count(account.id) === 0
          const messages: IndexedGmailMessage[] = []
          const completeStreams: Array<{ flag: IndexStreamFlag; ids: string[] }> = []
          let complete = true
          for (const stream of INDEX_STREAMS) {
            let token = ''
            const seenTokens = new Set<string>()
            const streamIds: string[] = []
            for (let pageNumber = 0; pageNumber < maxPagesPerStream; pageNumber += 1) {
              let ids: string[]
              let next: string
              if (fresh) {
                const page = await this.#searchPage(account, 50, stream.query, stream.labelIds, token)
                messages.push(...page.messages)
                this.#syncProgress.fetchedMessages += page.messages.length
                ids = page.messages.map((message) => message.id)
                next = page.nextPageToken
              } else {
                ({ ids, nextPageToken: next } = await this.#listIds(account, stream, token))
                const readIds = new Set(messages.map((message) => message.id))
                const needed = this.#needsDetails(account.id, stream.flag, ids).filter(position => !readIds.has(ids[position]!))
                if (needed.length) {
                  const page = await this.#searchPage(account, Math.max(...needed) + 1, stream.query, stream.labelIds, token)
                  messages.push(...page.messages)
                  this.#syncProgress.fetchedMessages += page.messages.length
                }
              }
              signal.throwIfAborted()
              this.#syncProgress.pagesFetched += 1
              streamIds.push(...ids)
              if (!next) {
                token = ''
                break
              }
              if (seenTokens.has(next)) throw new Error(`Gmail pagination repeated a page token for account ${account.name}`)
              seenTokens.add(next)
              token = next
            }
            if (token) {
              complete = false
              if (requireComplete) throw new Error(`Gmail pagination exceeded ${maxPagesPerStream} pages for account ${account.name}`)
            } else {
              completeStreams.push({ flag: stream.flag, ids: streamIds })
            }
          }
          // Rows gone from every complete folder are deleted by reconciling each folder below.
          this.#index!.replaceAccount(account.id, mergeIndexedMessages(messages), runId, fresh && complete)
          this.#mailRevision++
          for (const stream of completeStreams) this.#index!.reconcileStream(account.id, stream.flag, stream.ids, runId)
          if (complete) this.#index!.removeFolderless(account.id)
          completion.push(complete)
          this.#syncProgress.accountsCompleted += 1
        }))
        signal.throwIfAborted()
        const failed = results.flatMap((result, position) => result.status === 'rejected' ? [`${accounts[position]!.email || accounts[position]!.name}: ${String(result.reason)}`] : [])
        if (failed.length) throw new Error(failed.join('; '))
        this.#syncProgress.currentAccount = null
        this.#index!.pruneAccounts(accounts.map((account) => account.id))
        this.#local.pruneAccounts(accounts.map((account) => account.id))
        for (const accountId of this.#heads.keys()) if (!accounts.some(account => account.id === accountId)) this.#heads.delete(accountId)
        this.#index!.completeSync(new Date().toISOString(), completion.every(Boolean))
      } catch (error) {
        throw error
      }
    })
  }

  async readMessage(accountId: string, messageId: string): Promise<MessageProjection> {
    const account = await this.#account(accountId)
    return this.#readMessage(accountId, messageId, account)
  }

  async #readMessage(accountId: string, messageId: string, account: GmailAccountProjection): Promise<MessageProjection> {
    const value = await this.#post('/v1/connectors/gmail/read', { linkId: accountId, messageId, format: 'full' })
    return this.#projectMessage(value, accountId, account)
  }

  /** Projects a full Gmail message with a correctly decoded body (see bodyPartNeedingRawDecode). */
  async #projectMessage(value: unknown, accountId: string, account?: GmailAccountProjection): Promise<MessageProjection> {
    const projection = projectGmailMessage(value, true, account)
    return bodyPartNeedingRawDecode(value) ? withBody(projection, await this.#messageBody(value, accountId), account) : projection
  }

  /** The body the connector returned, or the same part decoded from the raw message by its declared charset. */
  async #messageBody(value: unknown, accountId: string): Promise<MessageProjection['body']> {
    const needed = bodyPartNeedingRawDecode(value)
    if (!needed) return body(record(structured(value).payload) ?? {})
    const messageId = text(structured(value).id)
    const raw = text(structured(await this.#post('/v1/connectors/gmail/read', { linkId: accountId, messageId, format: 'raw' })).raw)
    if (!raw) throw new Error(`Gmail returned no raw copy of message ${messageId}`)
    const part = partAt(parseMime(decodeRawMessage(raw)), needed.partId)
    if (!part || part.children.length) throw new Error(`Gmail message ${messageId} has no text part ${JSON.stringify(needed.partId)} in its raw copy`)
    try {
      return { kind: needed.kind, content: decodeText(part) }
    } catch (error) {
      // An unknown charset is reported in place of the body, never guessed.
      if (error instanceof UnsupportedCharsetError) return { kind: 'plain-text', content: error.message }
      throw error
    }
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
      const rawMessages = array(thread.messages)
      // Raw reads for non-UTF-8 bodies run a few at a time, so a long thread does not burst Gmail.
      const initialMessages = await mapLimit(rawMessages, 4, (message) => this.#projectMessage({ structuredContent: message }, accountId, account))
      const messagesById = new Map(initialMessages.map(message => [message.id, message]))
      const indexedIds = this.#index?.threadMessageIds(accountId, threadId) ?? []
      const missingIds = indexedIds.filter(id => !messagesById.has(id))
      const supplements = await mapLimit(missingIds, 4, async id => {
        try { return { id, message: await this.#readMessage(accountId, id, account) } }
        catch (error) { return { id, error: error instanceof Error ? error.message : String(error) } }
      })
      for (const supplement of supplements) if ('message' in supplement && supplement.message) messagesById.set(supplement.id, supplement.message)
      const messages = [...messagesById.values()]
      if (messages.length === 0) throw new Error('Gmail thread contains no readable messages')
      const unavailableIds = supplements.filter((item): item is { id: string; error: string } => 'error' in item).map(item => item.id)
      const capReached = rawMessages.length >= 100
      const knownCount = Math.max(new Set(indexedIds).size, messagesById.size, rawMessages.length)
      const unresolvedKnownIds = indexedIds.filter(id => !messagesById.has(id))
      const complete = !capReached && unresolvedKnownIds.length === 0 && unavailableIds.length === 0
      const reason = complete ? undefined : unavailableIds.length || unresolvedKnownIds.length
        ? `Some known messages could not be loaded (${new Set([...unavailableIds, ...unresolvedKnownIds]).size}). Go online and reopen this conversation to retry.`
        : `Gmail returned the 100-message limit. ${knownCount} is a lower bound; reopen this conversation to check for more messages.`
      const conversation = { ...projectConversation(messages, 'gmail'), completeness: { complete, knownCount, loadedCount: messages.length, ...(reason ? { reason } : {}) } }
      const preserveCompleteCache = cached?.conversation.completeness?.complete === true
        && (!complete || messages.length < cached.conversation.messages.length)
      const cachedAt = this.#stopped || preserveCompleteCache ? cached?.cachedAt ?? new Date().toISOString() : this.#local.cache(conversation)
      return { ...conversationForMailbox(conversation, mailbox), availability: { mode: 'live', cachedAt } }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const limited = (error as { code?: unknown })?.code === 'gmail_backoff'
      if (!cached || (!limited && (/not found|unknown account|401|403|404/i.test(detail) || !/timeout|timed out|fetch failed|aborted|ECONN|ENOTFOUND|503|unavailable/i.test(detail)))) throw error
      return { ...conversationForMailbox(cached.conversation, mailbox), availability: { mode: 'downloaded', cachedAt: cached.cachedAt, reason: limited ? 'Gmail is limiting requests from this account.' : 'Gmail could not be reached.' } }
    }
  }

  async readWorkConversation(accountId: string, threadId: string): Promise<ConversationProjection> {
    const cached=this.#local.conversation(accountId,threadId)
    const ids=this.#index?.threadMessageIds(accountId,threadId) ?? []
    const conversation=await this.readConversation(accountId,threadId,Boolean(cached?.conversation.completeness?.complete && ids.length && ids.every(id=>cached.conversation.messages.some(m=>m.id===id))))
    const excluded=new Set(this.#index?.excludedWorkMessageIds(accountId,threadId)??[])
    const messages=conversation.messages.filter(m=>!excluded.has(m.id));
    if(!messages.length)throw new Error('This thread has no eligible email evidence.');
    return {...projectConversation(messages,'gmail'),completeness:conversation.completeness,availability:conversation.availability}
  }

  workChanges(cursor:number,since:string,limit:number) {
    if(!this.#index)throw new Error('The durable Gmail index is unavailable.');
    return this.#index.workChanges(cursor,since,limit);
  }

  offlineStatus() { return { ...this.#local.stats(), download: this.#download } }
  downloadedConversations(mailbox: GmailMailbox, state: MailStateFilter, accountId?: string, query = ''): readonly ConversationSummary[] {
    if (!this.#index) return []
    const conversations = query
      ? this.#index.searchDownloadedConversations(mailbox, query, state,
        this.#local.searchCachedMessageIds((query.match(/(?:[^\s"]|"[^"]*")+/g) ?? [])
          .filter(term => !/^[^:]+:/.test(term))
          .map(term => term.startsWith('"') && term.endsWith('"') ? term.slice(1, -1) : term)
          .filter(Boolean), accountId), accountId)
      : this.#index.mailboxConversations(mailbox, state, accountId)
    const completeKeys = new Set(conversations.flatMap(conversation => {
      if (!conversation.accountId) return []
      const cached = this.#local.conversation(conversation.accountId, conversation.threadId)
      return cached?.conversation.completeness?.complete === true ? [`${conversation.accountId}:${conversation.threadId}`] : []
    }))
    return conversations.map(conversation => ({ ...conversation, downloaded: completeKeys.has(`${conversation.accountId}:${conversation.threadId}`) }))
  }
  conflictCopies(accountId?: string): DraftConflictCopy[] { return this.#local.conflictCopies(accountId) }
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
          if (!saved || saved.completeness?.complete !== true || saved.latestMessageId !== conversation.latestMessageId || saved.messages.length < conversation.messageCount) {
            const loaded = await this.readConversation(conversation.accountId!, conversation.threadId, false, mailbox)
            if (loaded.availability?.mode === 'downloaded') throw new Error('Gmail is offline; the existing saved copy was kept.')
            if (loaded.completeness?.complete !== true) throw new Error(loaded.completeness?.reason ?? 'This conversation is only partially available. Go online and reopen it to retry the missing messages.')
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
    const effectiveMessageIds = [...new Set([...(this.#index?.threadMessageIds(accountId, threadId) ?? []), ...messageIds])]
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

  /** Local acceptance is durable; account workers replay commands in ID order, independently. */
  async flushActions(): Promise<void> {
    if (!this.#index || this.#stopped || this.#actionsPaused) return this.#actionFlight
    if (!this.#actionFlight) {
      this.#actionBlockedAccounts = new Set<string>()
      const flight = this.#runActionBatch()
      this.#actionFlight = flight.finally(() => {
        this.#actionFlight = undefined
        this.#actionBlockedAccounts = undefined
      })
    }
    this.#startActionWorkers(this.#actionBlockedAccounts ?? new Set())
    return this.#actionFlight
  }

  async #runActionBatch(): Promise<void> {
    while (!this.#stopped) {
      if (!this.#actionsPaused) this.#startActionWorkers(this.#actionBlockedAccounts ?? new Set())
      if (this.#actionWorkers.size === 0) return
      await new Promise<void>(resolve => this.#actionWakeWaiters.add(resolve))
    }
  }

  #startActionWorkers(blocked: Set<string>): void {
    if (!this.#index || this.#stopped || this.#actionsPaused) return
    const now = Date.now()
    const selected = new Set<string>()
    for (const job of this.#index.pendingActions()) {
      if (selected.has(job.accountId) || blocked.has(job.accountId) || this.#actionWorkers.has(job.accountId)) continue
      if (Math.max(this.#gmailBackoff.get(job.accountId) ?? 0, this.#local.retryAfter(job.accountId)) > now) continue
      if (this.#actionWorkers.size >= GmailConnectorProvider.actionAccountWorkerLimit) break
      selected.add(job.accountId)
      const flight = this.#runActionAccount(job.accountId, blocked).finally(() => {
        if (this.#actionWorkers.get(job.accountId) === flight) this.#actionWorkers.delete(job.accountId)
        this.#wakeActionBatch()
      })
      this.#actionWorkers.set(job.accountId, flight)
    }
  }

  #wakeActionBatch(): void {
    const waiters = [...this.#actionWakeWaiters]
    this.#actionWakeWaiters.clear()
    for (const wake of waiters) wake()
  }

  async #runActionAccount(accountId: string, blocked: Set<string>): Promise<void> {
    while (!this.#stopped && !this.#actionsPaused) {
      const job = this.#index?.pendingActions().find(candidate => candidate.accountId === accountId)
      if (!job) return
      if (Math.max(this.#gmailBackoff.get(accountId) ?? 0, this.#local.retryAfter(accountId)) > Date.now()) return
      try {
        const value = await this.#post('/v1/connectors/gmail/modify', {
          linkId: job.accountId, messageIds: job.messageIds,
          addLabels: job.action === 'unread' ? ['UNREAD'] : job.action === 'trash' ? ['TRASH'] : job.action === 'spam' ? ['SPAM'] : job.action === 'inbox' ? ['INBOX'] : [],
          removeLabels: job.action === 'read' ? ['UNREAD'] : job.action === 'unread' ? [] : job.action === 'inbox' ? ['TRASH', 'SPAM'] : job.action === 'trash' ? ['INBOX', 'SPAM'] : job.action === 'spam' ? ['INBOX', 'TRASH'] : ['INBOX'],
        })
        const reply = JSON.stringify(value)
        if (/"success":false/.test(reply)) {
          // A label-change reply holds only message IDs and results, so it is safe to read for a rate limit.
          if (RATE_LIMIT.test(reply)) throw Object.assign(new Error(`Gmail is rate limiting this account. Retry after ${new Date(this.#pauseAccount(job.accountId, reply)).toISOString()}`), { code: 'gmail_backoff' })
          // A message Gmail no longer has (deleted, Trash emptied) has nothing left to change.
          const failures = array(structured(value).responses).filter(item => record(item)?.success === false)
          if (!failures.length || !failures.every(item => /not.?found|\b404\b/i.test(JSON.stringify(item)))) throw new Error('Gmail did not accept every message change')
          if (this.#stopped) return
          this.#index!.forgetMessages(job.accountId, failures.map(item => text(record(item)?.message_id)).filter(Boolean))
        }
        if (this.#stopped) return
        this.#index!.finishAction(job.id)
        // Read state changes labels, not folder IDs: re-read the folders that hold these messages so Gmail
        // confirms the change (the local overlay clears only then). Moves change the IDs of both folders.
        if (job.action === 'read' || job.action === 'unread') for (const flag of this.#index!.foldersOf(job.accountId, job.messageIds)) this.#forgetHead(job.accountId, flag)
        this.#scheduleSync(1_000)
      } catch (error) {
        if (this.#stopped) return
        this.#index!.failAction(job.id, /429|RATE_LIMITED|rate limiting|temporarily unavailable/.test(String(error)) ? 'Waiting for Gmail to sync mail changes' : 'Mail changes are saved on this device but could not sync. Check the account connection.')
        // Leave this account's head command in place for the next timer/manual retry; later commands
        // for the same account cannot pass it, while other account workers continue.
        blocked.add(accountId)
        return
      }
    }
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
        return this.updateGmailDraft({ ...projectDraft({ id, accountId, inReplyToMessageId: messageId, to: addressList(to), cc, bcc, subject, bodyMarkdown, attachments: draftAttachments }), gmailThreadId: existing.gmailThreadId, gmailMessageId: existing.gmailMessageId }, undefined, true)
      }
      // Resolve account/connectivity before recording a provider write intent.
      await this.#account(accountId)
      const retryAt = Math.max(this.#gmailBackoff.get(accountId) ?? 0, this.#local.retryAfter(accountId))
      if (retryAt > Date.now()) throw Object.assign(new Error(`Gmail is rate limiting this account. Retry after ${new Date(retryAt).toISOString()}`), { code: 'gmail_backoff' })
      const readyAttachments = await this.#resolveDraftAttachments(accountId, draftAttachments)
      this.#local.putDraftCreate(accountId, clientId, {})
      try {
        const saved = await this.#createGmailDraft(accountId, messageId, to, cc, bcc, subject, bodyMarkdown, readyAttachments, `dispatch-${clientId}@draft.dispatch.local`)
        this.#local.putDraftCreate(accountId, clientId, { draftId: saved.id })
        return saved
      } catch (error) {
        if ((error as { code?: string }).code === 'gmail_backoff' || /HTTP status: 429|RATE_LIMITED|token_revoked/.test(String(error))) this.#local.putDraftCreate(accountId, clientId, { rejected: true })
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

  enqueueDraftSave(accountId: string, messageId: string, fields: DraftSaveFields, draftId?: string, clientDraftId?: string, seedOverride?: DraftProjection): DraftProjection {
    if (!accountId || !Object.keys(fields).length) throw new Error('Account and draft fields are required')
    const identity = draftId ?? (clientDraftId ? `queued-${clientDraftId}` : '')
    if (identity && [identity, this.#draftQueue.pendingRemote(accountId, identity)?.id, this.#draftQueue.origin(accountId, identity)].some(id => id && this.#sendFlights.has(`${accountId}:${id}`))) throw new Error('This message is already sending. Its submitted contents cannot be changed.')
    const accounts = this.cachedAccounts()
    if (accounts.length && !accounts.some(account => account.id === accountId)) throw new Error('Unknown Gmail account')
    if (seedOverride && seedOverride.accountId !== accountId) throw new Error('Draft baseline belongs to a different Gmail account')
    let seed = seedOverride ?? (draftId ? this.#drafts.get(`${accountId}:${draftId}`) ?? this.#local.draft(accountId, draftId) : undefined)
    if (!seed && messageId) {
      const message = this.#index?.messages(accountId).find(message => message.id === messageId)
      if (message) seed = { ...projectDraft({ id: '', accountId, inReplyToMessageId: messageId, to: [], subject: '', bodyMarkdown: '' }), gmailThreadId: message.threadId }
    }
    return this.#draftQueue.enqueue(accountId, messageId, fields, draftId, seed, clientDraftId)
  }

  async resolveDraftConflict(accountId: string, draftId: string, choice: 'keep-local' | 'use-remote', expectedRevision?: number): Promise<DraftProjection> {
    return this.#draftQueue.resolveConflict(accountId, draftId, choice, expectedRevision)
  }

  setRuntimeDraining(value: boolean): void {
    this.#actionsPaused = value
    this.#draftQueue.pause(value)
    if (value) this.#wakeActionBatch()
    else void this.flushActions()
  }

  async flushDraftSaves(accountId?: string): Promise<void> {
    if (accountId) await this.#draftQueue.flushAccount(accountId)
    else await this.#draftQueue.flush()
  }

  async updateGmailDraft(draft: DraftProjection, clientId?: string, queuedWrite = false): Promise<DraftProjection> {
    if (!queuedWrite && draft.accountId && (this.#draftQueue.owns(draft.accountId, draft.id) || this.#draftQueue.pendingRemote(draft.accountId, draft.id))) {
      return this.enqueueDraftSave(draft.accountId, draft.inReplyToMessageId, this.#draftQueue.editorFields(draft.accountId, draft.id, {
        to: draft.to.map(item => item.address).join(', '), cc: draft.cc, bcc: draft.bcc, subject: draft.subject, bodyMarkdown: draft.bodyMarkdown, attachments: draft.attachments,
      }), draft.id)
    }
    if (!draft.accountId) throw new Error('Gmail draft is missing account identity')
    const existing = this.#drafts.get(`${draft.accountId}:${draft.id}`) ?? this.#local.draft(draft.accountId, draft.id)
    const attachments = await this.#resolveDraftAttachments(draft.accountId, draft.attachments, existing?.attachments ?? [])
    let saved = { ...draft, cachedAt: undefined, gmailThreadId: draft.gmailThreadId ?? existing?.gmailThreadId, gmailMessageId: draft.gmailMessageId ?? existing?.gmailMessageId, attachments }
    try {
      const result = structured(await this.#post('/v1/connectors/gmail/drafts/update', {
        linkId: draft.accountId, draftId: draft.id, to: draft.to.map((item) => item.address).join(', '),
        cc: draft.cc ?? '', bcc: draft.bcc ?? '', subject: draft.subject,
        bodyMarkdown: draft.bodyMarkdown, bodyHtml: draft.bodyHtml, bodyText: draft.bodyText,
        attachments: connectorAttachments(attachments),
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

  async patchGmailDraft(accountId: string, draftId: string, fields: { to?: string; cc?: string; bcc?: string; subject?: string }, queuedWrite = false): Promise<DraftProjection> {
    if (!queuedWrite && (this.#draftQueue.owns(accountId, draftId) || this.#draftQueue.pendingRemote(accountId, draftId))) return this.enqueueDraftSave(accountId, '', fields, draftId)
    if (!accountId || !draftId || !Object.keys(fields).length) throw new Error('Draft identity and at least one header are required')
    await this.#post('/v1/connectors/gmail/drafts/update', { linkId: accountId, draftId, preserveContent: true, ...fields })
    return this.readGmailDraft(accountId, draftId)
  }

  async attachDraftFiles(accountId: string, draftId: string, paths: readonly string[], operationId: string = randomUUID()) {
    if (!paths.length || paths.some(path => !isAbsolute(path))) throw new Error('Supply absolute file paths to attach.')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new Error('Attachment operation ID must be a UUID.')
    const media: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    const additions: DraftAttachment[] = []
    let stagedBytes = 0
    for (const path of paths) {
      const info = await stat(path)
      if (!info.isFile() || info.size > 25_000_000) throw new Error(`Not an attachable file (maximum 25 MB): ${basename(path)}`)
      const bytes = await readFile(path)
      if (bytes.length > 25_000_000) throw new Error(`Not an attachable file (maximum 25 MB): ${basename(path)}`)
      stagedBytes += bytes.length
      if (stagedBytes > 25_000_000) throw new Error('Combined attachments exceed 25 MB. Nothing was attached.')
      additions.push({ name: basename(path), mediaType: media[extname(path).toLowerCase()] ?? 'application/octet-stream', contentBase64: bytes.toString('base64') })
    }
    // Persist intent before any provider read. Gmail may be offline when the user attaches a
    // file, and a queued creation ID is valid before it has a remote Gmail ID.
    const queued = this.#local.draftSave(accountId, draftId)
      ?? this.#local.draftSaves().find(job => job.accountId === accountId && job.remoteId === draftId && job.state !== 'cancelled')
    const seed = queued?.draft ?? this.#drafts.get(`${accountId}:${draftId}`) ?? this.#local.draft(accountId, draftId)
      ?? projectDraft({ id: draftId, accountId, inReplyToMessageId: '', to: [], subject: '', bodyMarkdown: '' })
    const accepted = this.#draftQueue.enqueueAttachmentAppend(accountId, draftId, additions, operationId, seed)
    const cancelled = () => this.#local.draftSave(accountId, accepted.id)?.attachmentAppends?.some(intent => intent.operationId === operationId && intent.cancelled) ?? false
    const throwIfCancelled = () => {
      if (cancelled()) throw Object.assign(new Error('This attachment operation was cancelled after the draft changed.'), { code: 'draft_attachment_operation_cancelled' })
    }
    throwIfCancelled()
    await this.flushDraftSaves(accountId)
    throwIfCancelled()
    const draft = await this.readGmailDraft(accountId, accepted.id)
    throwIfCancelled()
    const confirmed = draft.syncState === undefined
    if (confirmed && additions.some(file => !draft.attachments.some(saved => fileMatches(saved, file)))) {
      throw Object.assign(new Error('Gmail no longer contains one or more files from this attachment operation.'), { code: 'draft_attachment_not_present' })
    }
    return {
      draft,
      operationId,
      syncState: draft.syncState,
      verifiedFiles: confirmed ? additions.map(file => ({ name: file.name, bytes: Buffer.from(file.contentBase64!, 'base64').length, sha256: attachmentSha256(file) })) : [],
    }
  }

  async readGmailDraft(accountId: string, draftId: string, authoritative = false): Promise<DraftProjection> {
    if (['accepted', 'verified'].includes(this.existingDraftSend(accountId, draftId)?.status ?? '')) throw Object.assign(new Error('This draft was sent.'), { code: 'gmail_draft_not_found' })
    if (this.#draftQueue.owns(accountId, draftId)) return this.#draftQueue.read(accountId, draftId)
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
    let draft = this.#projectGmailDraft(summary, message, existing?.inReplyToMessageId ?? summary.messageId, accountId, authoritative ? undefined : existing)
    if (authoritative) {
      draft = { ...draft, to: message.to ?? [], cc: message.cc?.map(item => item.address).join(', ') ?? '', bcc: message.bcc?.map(item => item.address).join(', ') ?? '', subject: message.subject,
        attachments: await this.#resolveDraftAttachments(accountId, draft.attachments) }
    }
    this.#rememberDraft(draft, false, request)
    return authoritative || this.#draftCacheRequests.get(key) === request ? draft : this.#drafts.get(key) ?? draft
  }

  /**
   * Every update_draft gives the draft a new message id, so the id the index
   * remembers goes stale between syncs. The thread id survives, so the draft is
   * matched by either.
   */
  async openGmailDraft(accountId: string, messageId: string, threadId = ''): Promise<DraftProjection> {
    if (this.#draftQueue.owns(accountId, messageId)) return this.#draftQueue.read(accountId, messageId)
    const pending = this.#draftQueue.pending(accountId).find(job => job.draft.gmailMessageId === messageId || (threadId && job.draft.gmailThreadId === threadId))
    if (pending) return this.#draftQueue.projection(pending)
    const cached = this.#local.draftForMessage(accountId, messageId, threadId)
    if (cached) return { ...cached, resolvedFromDraftId: this.#draftQueue.origin(accountId, cached.id) }
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
    const result = { ...draft, resolvedFromDraftId: this.#draftQueue.origin(accountId, draft.id) }
    const key = `${accountId}:${draft.id}`
    if ((this.#draftCacheRequests.get(key) ?? 0) < request) this.#draftCacheRequests.set(key, request)
    this.#rememberDraft(draft, false, request)
    return { ...(this.#draftCacheRequests.get(key) === request ? result : this.#drafts.get(key) ?? result), resolvedFromDraftId: result.resolvedFromDraftId }
  }

  async discardGmailDraft(accountId: string, draftId: string, queuedWrite = false): Promise<void> {
    if (!queuedWrite) {
      const queued = this.#draftQueue.pendingRemote(accountId, draftId)
      if (queued || this.#draftQueue.owns(accountId, draftId)) return this.#draftQueue.discard(accountId, queued?.id ?? draftId)
    }
    // Delete by ID first: authoritative where the connector has delete_draft. Without it the
    // agent answers gmail_draft_discard_unavailable without calling Gmail.
    let deleted = false
    try {
      const result = await this.#post('/v1/connectors/gmail/drafts/discard', { linkId: accountId, draftId })
      if (record(result)?.isError || structured(result).error) throw new Error('Gmail did not confirm discarding the draft')
      deleted = true
    } catch (error) {
      if (!String(error).includes('gmail_draft_discard_unavailable') && !isGmailNotFound(error)) throw draftConnectorError(error)
    }
    if (deleted) return this.#forgetDraft(accountId, draftId, this.#drafts.get(`${accountId}:${draftId}`)?.gmailMessageId)
    // Then Gmail's drafts list decides. A draft it still does not list after the list lag was
    // already sent or deleted, so there is nothing left to discard. A list failure (such as
    // Gmail's rate limit) is reported, never read as "gone".
    let summary = await this.#findGmailDraft(accountId, (draft) => draft.draftId === draftId)
    if (!summary && this.#draftListLagMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#draftListLagMs))
      summary = await this.#findGmailDraft(accountId, (draft) => draft.draftId === draftId)
    }
    // A draft this service saved moments ago is missing from a lagging list, not gone.
    if (!summary && Date.now() - (this.#draftWrittenAt.get(`${accountId}:${draftId}`) ?? 0) < 60_000) {
      throw Object.assign(new Error('Gmail has not listed this new draft yet. Try again in a few seconds.'), { code: 'gmail_draft_list_lag' })
    }
    if (summary) {
      // Trash the exact draft message; never the whole thread.
      try {
        const result = await this.#post('/v1/connectors/gmail/delete', { linkId: accountId, messageIds: [summary.messageId] })
        const confirmed = array(structured(result).responses).some(item => record(item)?.message_id === summary!.messageId && record(item)?.success === true)
        if (record(result)?.isError || !confirmed) throw new Error('Gmail did not confirm moving the draft to Trash')
        if (await this.#findGmailDraft(accountId, candidate => candidate.draftId === draftId)) throw new Error('The draft was moved to Trash but Gmail still lists it. Refresh before retrying.')
      } catch (error) {
        throw draftConnectorError(error)
      }
    }
    this.#forgetDraft(accountId, draftId, summary?.messageId)
  }

  #forgetDraft(accountId: string, draftId: string, messageId: string | undefined): void {
    this.#drafts.delete(`${accountId}:${draftId}`)
    this.#draftWrittenAt.delete(`${accountId}:${draftId}`)
    this.#local.removeDraft(accountId, draftId)
    if (this.#index && messageId) this.#index.discardDraftMessages(accountId, [messageId])
    void this.#refreshIndexedDrafts(accountId)
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
    const existing = this.#local.receiptForMessage(accountId, messageId) ?? (draftId ? this.existingDraftSend(accountId, draftId) : undefined)
    if (existing?.status === 'verified') return existing
    const now = new Date().toISOString()
    const receipt: SendReceipt = { id: existing?.id ?? randomUUID(), accountId, accountLabel: existing?.accountLabel ?? this.#index?.accounts().find(account => account.id === accountId)?.email ?? accountId, draftId, requestedAt: existing?.requestedAt ?? now, acceptedAt: now, ...existing, messageId, status: 'accepted', detailsSource: existing?.detailsSource ?? 'unavailable', error: undefined }
    this.#local.putReceipt(receipt)
    if (draftId) {
      for (const id of [draftId, this.#draftQueue.origin(accountId, draftId), this.#local.draftSave(accountId, draftId)?.remoteId]) {
        if (!id) continue
        this.#drafts.delete(`${accountId}:${id}`)
        this.#local.removeDraft(accountId, id)
      }
    }
    void this.verifySendReceipt(receipt.id)
    void this.#refreshIndexedDrafts(accountId)
    return receipt
  }

  async sendGmailDraft(accountId: string, draftId: string): Promise<unknown> {
    if (this.#draftQueue.pendingRemote(accountId, draftId)) throw new Error('Draft is still syncing. Nothing was sent.')
    if (this.#draftQueue.owns(accountId, draftId)) {
      const resolved = await this.#draftQueue.read(accountId, draftId)
      if (resolved.syncState) throw new Error('Draft is still syncing. Nothing was sent.')
      draftId = resolved.id
    }
    if (!accountId || !draftId) throw new Error('Account and draft ID are required')
    const key = `${accountId}:${draftId}`
    const flight = this.#sendFlights.get(key)
    if (flight) return flight
    const previous = this.existingDraftSend(accountId, draftId)
    if (previous) return { structuredContent: { id: previous.messageId ?? null }, receipt: previous }
    const operation = this.#sendWithReceipt(accountId, draftId)
    this.#sendFlights.set(key, operation)
    try { return await operation } finally { this.#sendFlights.delete(key) }
  }

  backgroundSends(): SendReceipt[] {
    const latest = new Map<string, SendReceipt>()
    for (const receipt of this.#local.receipts()) {
      if (!receipt.background) continue
      const identity = receipt.draftId ? this.#draftQueue.origin(receipt.accountId, receipt.draftId) ?? receipt.draftId : receipt.id
      const key = `${receipt.accountId}:${identity}`
      if (!latest.has(key)) latest.set(key, receipt)
    }
    return [...latest.values()].filter(receipt => !['accepted', 'verified'].includes(receipt.status))
  }
  failedSendDraft(id: string): DraftProjection | undefined {
    const receipt = this.#local.receipt(id)
    if (!receipt?.draftId || !['failed', 'unknown'].includes(receipt.status)) return undefined
    const job = this.#local.draftSave(receipt.accountId, receipt.draftId)
    return job ? { ...job.draft, id: job.id, draftRevision: job.revision } : this.#local.draft(receipt.accountId, receipt.draftId)
  }

  existingDraftSend(accountId: string, draftId?: string, clientDraftId?: string): SendReceipt | undefined {
    const identities = [draftId ? this.#local.draftSave(accountId, draftId)?.remoteId : undefined, clientDraftId ? `queued-${clientDraftId}` : undefined, draftId, draftId ? this.#draftQueue.origin(accountId, draftId) : undefined, draftId ? this.#draftQueue.pendingRemote(accountId, draftId)?.id : undefined]
    const receipt = identities.flatMap(id => id ? [this.#local.receiptForDraft(accountId, id)] : []).filter((value): value is SendReceipt => Boolean(value)).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0]
    return receipt?.status !== 'failed' ? receipt : undefined
  }

  /** Persist one explicit send attempt before returning; Gmail work runs independently of the window. */
  beginGmailDraftSend(accountId: string, draftId: string, expectedRevision?: number): SendReceipt {
    if (!accountId || !draftId) throw new Error('Account and draft ID are required')
    if (this.#actionsPaused || this.#stopped) throw new Error('Dispatch is updating. Your reply is kept; try Send again when the update finishes.')
    const previous = this.existingDraftSend(accountId, draftId)
    if (previous) return previous
    const receipt: SendReceipt = { id: randomUUID(), accountId, accountLabel: this.cachedAccounts().find(account => account.id === accountId)?.email ?? accountId,
      draftId, requestedAt: new Date().toISOString(), status: 'preparing', detailsSource: 'unavailable', background: true }
    this.#local.putReceipt(receipt)
    const key = `${accountId}:${draftId}`
    const operation = this.#sendWithReceipt(accountId, draftId, receipt, expectedRevision)
    this.#sendFlights.set(key, operation)
    void operation.finally(() => { this.#sendFlights.delete(key) }).catch(error => console.error('Background send could not record its outcome:', error))
    return receipt
  }

  async #sendWithReceipt(accountId: string, draftId: string, initial?: SendReceipt, expectedRevision?: number): Promise<unknown> {
    let receipt: SendReceipt = initial ?? { id: randomUUID(), accountId, accountLabel: accountId, draftId, requestedAt: new Date().toISOString(), status: 'preparing', detailsSource: 'unavailable' }
    this.#local.putReceipt(receipt)
    try {
      if (initial && (this.#draftQueue.owns(accountId, draftId) || this.#draftQueue.pendingRemote(accountId, draftId))) await this.#draftQueue.flushAccount(accountId)
      // This exact revision was just read back and verified by the save worker.
      // Reuse that confirmation rather than fetching the same draft again before Send.
      const saved = expectedRevision === undefined ? undefined : this.#local.draftSave(accountId, draftId)
      const draft = saved?.state === 'saved' && saved.revision === expectedRevision && saved.remoteId
        ? { ...saved.draft, id: saved.remoteId, draftRevision: saved.revision }
        : await this.readGmailDraft(accountId, draftId)
      if (draft.syncState) throw new Error(draft.syncError || 'Gmail could not save this reply. Nothing was sent. Your reply is kept in Drafts.')
      if (expectedRevision !== undefined && draft.draftRevision !== expectedRevision) throw new Error('This reply changed before sending. Nothing was sent; review it in Drafts.')
      const remoteDraftId = draft.id
      const details: ReceiptDetails = { to: draft.to.map(item => item.address), cc: addressList(draft.cc ?? '').map(item => item.address), bcc: addressList(draft.bcc ?? '').map(item => item.address), subject: draft.subject, attachments: draft.attachments.map(item => ({ name: item.name, mediaType: item.mediaType, sizeLabel: item.sizeLabel })) }
      if (!details.to.length && !details.cc.length && !details.bcc.length) throw new Error('The saved Gmail draft has no recipients.')
      const account = await this.#account(accountId)
      if (expectedRevision !== undefined && this.#local.draftSave(accountId, draftId)?.revision !== expectedRevision) throw new Error('This reply changed before sending. Nothing was sent; review it in Drafts.')
      receipt = { ...receipt, details, intended: details, detailsSource: 'draft', accountLabel: account.email || accountId, status: 'sending' }
      // Durable intent is recorded before the provider call. A restart makes it unknown, never a retry.
      this.#local.putReceipt(receipt)
      const result = await this.#post('/v1/connectors/gmail/drafts/send', { linkId: accountId, draftId: remoteDraftId })
      const messageId = text(structured(result).id)
      if (record(result)?.isError || structured(result).error || !messageId) throw new Error('Gmail did not return a confirmed sent message ID.')
      receipt = { ...receipt, messageId, status: 'accepted', acceptedAt: new Date().toISOString() }
      for (const id of [draftId, remoteDraftId]) {
        this.#drafts.delete(`${accountId}:${id}`)
        this.#local.removeDraft(accountId, id)
      }
      if (draft.gmailMessageId) this.#index?.discardDraftMessages(accountId, [draft.gmailMessageId])
      if (!this.#stopped) {
        this.#local.putReceipt(receipt)
        void this.verifySendReceipt(receipt.id)
        void this.#refreshIndexedDrafts(accountId)
      }
      return { ...(record(result) ?? {}), receipt }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const rejected = (error as { code?: unknown })?.code === 'gmail_backoff' || /token_revoked|HTTP status: (?:400|401|403|404)|request failed \((?:400|401|403|404)\)/i.test(detail)
      receipt = { ...receipt, status: receipt.status === 'preparing' || rejected ? 'failed' : 'unknown', error: detail }
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
    // Gmail embeds small/empty files in the MIME part and gives them no download ID.
    // The projection then uses an explicit MIME part selector. Verify that exact part before
    // returning embedded bytes; missing content must never be treated as an empty file.
    const mimePartId = /^mime-part:(\d+(?:\.\d+)*)$/.exec(attachmentId)?.[1]
    if (mimePartId !== undefined) {
      const message = structured(await this.#post('/v1/connectors/gmail/read', { linkId: accountId, messageId, format: 'full' }))
      const part = parts(record(message.payload) ?? {}).find(item => text(item.part_id) === mimePartId && text(item.filename) === filename)
      if (!part) throw Object.assign(new Error(`Attachment ${filename} is not part of this message`), { code: 'attachment_not_found' })
      const partBody = record(part?.body)
      if (!text(partBody?.attachment_id)) {
        const data = typeof partBody?.base64_url_content === 'string' ? partBody.base64_url_content
          : partBody?.size === 0 && partBody.content === '' ? '' : undefined
        if (data !== undefined) return { structuredContent: { base64_url_content: data, mime_type: text(part.mime_type),
          ...typeof partBody?.size === 'number' ? { size_bytes: partBody.size } : {} } }
        return this.#attachmentFromRawMessage(accountId, messageId, attachmentId, filename)
      }
      return this.#post('/v1/connectors/gmail/attachment', { linkId: accountId, messageId, attachmentId: text(partBody?.attachment_id) })
    }
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
      if (!Array.isArray(content.drafts)) throw new Error('Gmail drafts list returned no drafts array')
      const match = content.drafts.map(gmailDraftSummary).find(matches)
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
      if (item.contentBase64 !== undefined) return item
      const cached = stored.find((candidate) => candidate.contentBase64 !== undefined && candidate.name === item.name && (candidate.id === item.id || !item.id))
      if (cached?.contentBase64 !== undefined) return { ...item, contentBase64: cached.contentBase64 }
      if (item.sourceMessageId && item.id) {
        return { ...item, contentBase64: await attachmentBytes(await this.readAttachment(accountId, item.sourceMessageId, item.id, item.name)) }
      }
      throw missingAttachmentBytes()
    }))
  }

  #projectGmailDraft(summary: GmailDraftSummary, message: MessageProjection, inReplyToMessageId: string, accountId: string, existing?: DraftProjection): DraftProjection {
    const draft = projectDraft({
      id: summary.draftId,
      inReplyToMessageId,
      to: addressList(summary.to),
      cc: summary.cc,
      bcc: summary.bcc,
      subject: summary.subject,
      bodyMarkdown: plainBodyFromMessage(message),
      attachments: existing?.attachments.length ? existing.attachments : draftAttachmentsFromMessage(message),
      accountId,
    })
    return {
      ...draft,
      // A draft is already formatted MIME. Keep its HTML and CID links when attachment or
      // header commands rebuild the draft projection; the editor's Markdown renderer is for
      // newly composed or explicitly edited text only.
      bodyHtml: message.body.kind === 'sanitized-html' ? restoreDraftCidImages(message.body.content, message) : draft.bodyHtml,
      bodyText: message.bodyText ?? draft.bodyText,
      gmailMessageId: summary.messageId,
      gmailThreadId: summary.threadId,
    }
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
    if (retryAt > Date.now()) throw Object.assign(new Error(`Gmail is rate limiting this account. Retry after ${new Date(retryAt).toISOString()}`), { code: 'gmail_backoff' })
    const response = await fetch(`${this.#agentBase}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyValue), signal: this.#syncContext.getStore() ? AbortSignal.any([this.#syncContext.getStore()!, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    const value = await response.json() as unknown
    // Only a failed call can carry a rate limit, and only its error fields are read: a successful
    // page holds email text, which is untrusted and may quote "RATE_LIMITED ... Retry after <any date>".
    const content = structured(value)
    const failure = !response.ok ? JSON.stringify(value)
      : record(value)?.isError === true || content.error ? JSON.stringify({ error: content.error, error_code: content.error_code, error_data: content.error_data, content: record(value)?.content })
        : ''
    if (response.status === 429 || RATE_LIMIT.test(failure)) {
      const retryAt = this.#pauseAccount(linkId, failure)
      throw Object.assign(new Error(`Gmail is rate limiting this account. Retry after ${new Date(retryAt).toISOString()}: ${JSON.stringify(value)}`), { code: 'gmail_backoff', connectorPayload: value })
    }
    if (!response.ok) throw new Error(`Gmail connector request failed (${response.status}): ${JSON.stringify(value)}`)
    if (record(value)?.isError || structured(value).error) throw Object.assign(new Error(`Gmail connector rejected the request: ${JSON.stringify(value)}`), { connectorPayload: value })
    if (!array(content.responses).some(item => record(item)?.success === false)) this.#rateLimitStreak.delete(linkId)
    return value
  }

  /**
   * Blocks calls for the account until Gmail's Retry-After, and remembers it across restarts. Without
   * one, the pause starts at a minute and doubles with each limit in a row, up to half an hour, so an
   * account Gmail keeps limiting is not asked again every minute.
   */
  #pauseAccount(linkId: string, failure: string): number {
    const streak = (this.#rateLimitStreak.get(linkId) ?? 0) + 1
    this.#rateLimitStreak.set(linkId, streak)
    const wait = Math.min(60_000 * 2 ** (streak - 1), MAX_RATE_LIMIT_PAUSE_MS)
    const named = Date.parse(/Retry after (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(failure)?.[1] ?? '')
    const retryAt = Number.isFinite(named) ? Math.max(Date.now() + wait, named) : Date.now() + wait
    this.#gmailBackoff.set(linkId, retryAt)
    if (!this.#stopped) this.#local.putRetryAfter(linkId, retryAt)
    return retryAt
  }
}

function messageSummaryOf(message: MessageProjection): MessageSummary {
  const { body: _body, attachments: _attachments, source: _source, to: _to, cc: _cc, ...summary } = message
  return summary
}
