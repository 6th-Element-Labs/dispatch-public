import { watchParent } from './parent-watch.js'
import { projectSearchResults, type SearchMatch } from './search-results.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { DemoMailProvider } from './demo-provider.js'
import { renderDraftMarkdown } from './draft-markdown.js'
import { projectDraft } from './draft.js'
import { GmailConnectorProvider } from './gmail-provider.js'
import type { DraftAttachment, GmailConversationAction, GmailMailbox, MailStateFilter } from './model.js'
import { readFile } from 'node:fs/promises'
import { defaultAttachmentCacheDir, defaultOpenPath, ensureAttachmentFile, openAttachmentFile } from './open-attachment.js'

const provider = new DemoMailProvider()
const allowedOrigin = process.env.DISPATCH_ALLOWED_ORIGIN ?? 'http://127.0.0.1:8410'

function writeAttachmentError(response: ServerResponse, fallback: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  if (code === 'attachment_not_found') return writeJson(response, 404, { error: 'attachment_not_found', detail })
  if (code === 'gmail_attachment_unavailable') return writeJson(response, 503, { error: 'gmail_attachment_unavailable', detail })
  return writeJson(response, 502, { error: fallback, detail })
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  })
  response.end(JSON.stringify(value))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

type GmailProvider = Pick<GmailConnectorProvider, 'accounts' | 'listMessages' | 'listUnifiedMessages' | 'readMessage' | 'listConversations' | 'listUnifiedConversations' | 'readConversation'> & Partial<Pick<GmailConnectorProvider, 'startBackgroundSync' | 'stopBackgroundSync' | 'syncStatus' | 'syncNow' | 'refreshNow' | 'setConversationUnread' | 'searchConversations' | 'listMailboxConversations' | 'mailboxCounts' | 'listRecipients' | 'mutateConversation' | 'createGmailDraft' | 'updateGmailDraft' | 'patchGmailDraft' | 'readGmailDraft' | 'openGmailDraft' | 'discardGmailDraft' | 'sendGmailDraft' | 'sendReceipts' | 'sendReceipt' | 'verifySendReceipt' | 'recordExternalSend' | 'cachedAccounts' | 'offlineStatus' | 'downloadedConversations' | 'startOfflineDownload' | 'cancelOfflineDownload' | 'readAttachment'>>

function draftError(error: unknown, fallback: string): { error: string; detail: string } {
  const value = error as { code?: unknown; message?: unknown }
  return {
    error: typeof value?.code === 'string' ? value.code : fallback,
    detail: error instanceof Error ? error.message : String(error),
  }
}

function draftStatus(error: unknown, fallback = 502): number {
  const code = (error as { code?: unknown })?.code
  if (code === 'gmail_draft_not_found') return 404
  if (code === 'gmail_draft_open_unavailable' || code === 'gmail_draft_refresh_unavailable') return 503
  return fallback
}

function draftAttachments(value: unknown): readonly DraftAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const attachment = item as Record<string, unknown>
    if (typeof attachment.name !== 'string' || typeof attachment.mediaType !== 'string') return []
    return [{
      id: typeof attachment.id === 'string' ? attachment.id : undefined,
      name: attachment.name,
      mediaType: attachment.mediaType,
      contentBase64: typeof attachment.contentBase64 === 'string' ? attachment.contentBase64 : undefined,
      sizeLabel: typeof attachment.sizeLabel === 'string' ? attachment.sizeLabel : undefined,
      sourceMessageId: typeof attachment.sourceMessageId === 'string' ? attachment.sourceMessageId : undefined,
    }]
  })
}

function draftObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stateFilter(value: string | null): MailStateFilter | undefined {
  if (value === null || value === 'all') return 'all'
  if (value === 'read' || value === 'unread') return value
  return undefined
}

function mailboxFilter(value: string | null): GmailMailbox | undefined {
  if (value === null || value === 'inbox') return 'inbox'
  if (value === 'sent' || value === 'drafts' || value === 'archive' || value === 'spam' || value === 'trash') return value
  return undefined
}

async function within<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createMailServer(
  gmail: GmailProvider = new GmailConnectorProvider(),
  options: {
    demoEnabled?: boolean
    readinessTimeoutMs?: number
    attachmentCacheDir?: string
    openPath?: (path: string) => Promise<void>
  } = { demoEnabled: process.env.DISPATCH_DEMO_MAIL === '1' },
) {
  const demoEnabled = options.demoEnabled === true
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 3_000
  const attachmentCacheDir = options.attachmentCacheDir ?? defaultAttachmentCacheDir()
  const openPath = options.openPath ?? defaultOpenPath
  let activeMutations = 0
  let draining = false
  const activeOperations = () => Math.max(activeMutations, (gmail as Partial<GmailConnectorProvider>).runtimeStatus?.().activeOperations ?? 0)

  async function attachmentPayload(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<unknown> {
    if (accountId && gmail.readAttachment) {
      return gmail.readAttachment(accountId, messageId, attachmentId, filename)
    }
    if (demoEnabled) {
      const attachment = provider.readAttachment(messageId, attachmentId)
      if (!attachment) {
        throw Object.assign(new Error('Demo attachment was not found'), { code: 'attachment_not_found' })
      }
      return attachment
    }
    throw Object.assign(new Error('Gmail attachment read is not available'), { code: 'gmail_attachment_unavailable' })
  }
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') return writeJson(response, 204, {})
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'POST' && url.pathname.startsWith('/v1/runtime/') && request.headers['x-dispatch-runtime'] !== (process.env.DISPATCH_RUNTIME_ID ?? 'development')) return writeJson(response, 403, { error: 'runtime_control_identity_required' })
    if (request.method === 'POST' && url.pathname === '/v1/runtime/drain') {
      const count = activeOperations()
      if (count === 0) draining = true
      return writeJson(response, count ? 409 : 200, { service: 'dispatch-mail', draining, activeOperations: count })
    }
    if (request.method === 'POST' && url.pathname === '/v1/runtime/resume') { draining = false; return writeJson(response, 200, { service: 'dispatch-mail', draining }) }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '')) {
      if (draining) return writeJson(response, 503, { error: 'runtime_updating', detail: 'Dispatch is updating its services. Try again shortly.' })
      activeMutations++
      let done = false
      const finish = () => { if (!done) { done = true; activeMutations-- } }
      response.once('finish', finish); response.once('close', finish)
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return writeJson(response, 200, { service: 'dispatch-mail', status: 'healthy', runtimeId: process.env.DISPATCH_RUNTIME_ID ?? null })
    }
    if (request.method === 'GET' && url.pathname === '/v1/runtime') {
      return writeJson(response, 200, { service: 'dispatch-mail', runtimeId: process.env.DISPATCH_RUNTIME_ID ?? null, activeOperations: activeOperations(), draining })
    }
    if (request.method === 'GET' && url.pathname === '/ready') {
      if (demoEnabled) return writeJson(response, 200, { service: 'dispatch-mail', status: 'ready', provider: 'demo' })
      const sync = gmail.syncStatus?.()
      if (sync?.state === 'failed') {
        return writeJson(response, 503, { service: 'dispatch-mail', status: 'not_ready', error: 'gmail_sync_failed', detail: sync.error, sync })
      }
      try {
        const accounts = await within(gmail.accounts(), readinessTimeoutMs, 'Gmail readiness check')
        const refreshedSync = gmail.syncStatus?.()
        if (refreshedSync?.state === 'failed') {
          return writeJson(response, 503, { service: 'dispatch-mail', status: 'not_ready', error: 'gmail_sync_failed', detail: refreshedSync.error, sync: refreshedSync })
        }
        return accounts.length > 0
          ? writeJson(response, 200, { service: 'dispatch-mail', status: 'ready', provider: 'gmail', accountCount: accounts.length })
          : writeJson(response, 503, { service: 'dispatch-mail', status: 'not_ready', error: 'gmail_not_connected' })
      } catch (error) {
        return writeJson(response, 503, { service: 'dispatch-mail', status: 'not_ready', error: 'gmail_connection_failed', detail: error instanceof Error ? error.message : String(error) })
      }
    }
    if (url.pathname === '/v1/offline') {
      if (request.method === 'GET') return writeJson(response, 200, { offline: gmail.offlineStatus?.() ?? { conversations: 0, bytes: 0 } })
      try {
        if (request.method === 'POST' && gmail.startOfflineDownload) {
          const body = draftObject(await readJson(request))
          const mailbox = mailboxFilter(typeof body?.mailbox === 'string' ? body.mailbox : null)
          if (!mailbox) return writeJson(response, 400, { error: 'invalid_mailbox' })
          return writeJson(response, 202, { download: gmail.startOfflineDownload(mailbox, typeof body?.accountId === 'string' ? body.accountId : undefined) })
        }
        if (request.method === 'DELETE') { gmail.cancelOfflineDownload?.(); return writeJson(response, 200, { offline: gmail.offlineStatus?.() }) }
      } catch (error) { return writeJson(response, 502, { error: 'offline_download_failed', detail: String(error) }) }
    }
    if (url.pathname === '/v1/send-receipts') {
      if (request.method === 'GET') return writeJson(response, 200, { receipts: gmail.sendReceipts?.() ?? [] })
      if (request.method === 'POST' && gmail.recordExternalSend) {
        try {
          const body = draftObject(await readJson(request))
          if (!body || typeof body.accountId !== 'string' || !body.accountId.trim() || typeof body.messageId !== 'string' || !body.messageId.trim()) return writeJson(response, 400, { error: 'receipt_identity_required' })
          return writeJson(response, 200, { receipt: gmail.recordExternalSend(body.accountId, body.messageId, typeof body.draftId === 'string' ? body.draftId : undefined) })
        } catch (error) { return writeJson(response, 400, { error: 'receipt_record_failed', detail: String(error) }) }
      }
    }
    const receiptMatch = /^\/v1\/send-receipts\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'POST' && receiptMatch?.[1] && gmail.verifySendReceipt) {
      try { return writeJson(response, 200, { receipt: await gmail.verifySendReceipt(decodeURIComponent(receiptMatch[1])) }) }
      catch (error) { return writeJson(response, 404, { error: 'receipt_not_found', detail: String(error) }) }
    }
    if (request.method === 'GET' && url.pathname === '/v1/conversations') {
      const state = stateFilter(url.searchParams.get('state'))
      if (!state) return writeJson(response, 400, { error: 'invalid_state_filter' })
      const mailbox = mailboxFilter(url.searchParams.get('mailbox'))
      if (!mailbox) return writeJson(response, 400, { error: 'invalid_mailbox' })
      const limitValue = Number(url.searchParams.get('limit') ?? 100)
      const cursorValue = Number(url.searchParams.get('cursor') ?? 0)
      if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 200 || !Number.isInteger(cursorValue) || cursorValue < 0) {
        return writeJson(response, 400, { error: 'invalid_pagination' })
      }
      const accountId = url.searchParams.get('account')
      const query = url.searchParams.get('q')?.trim() ?? ''
      if (url.searchParams.get('offline') === 'true' && gmail.downloadedConversations) {
        const all = gmail.downloadedConversations(mailbox, state, accountId ?? undefined, query)
        const page = all.slice(cursorValue, cursorValue + limitValue)
        return writeJson(response, 200, { source: 'gmail', coverage: 'downloaded', conversations: page, total: all.length, nextCursor: cursorValue + page.length < all.length ? String(cursorValue + page.length) : null })
      }
      try {
        const cached = gmail.cachedAccounts?.() ?? []
        const accounts = cached.length ? cached : await gmail.accounts()
        if (accounts.length > 0) {
          const conversations = gmail.listMailboxConversations
            ? await gmail.listMailboxConversations(mailbox, state, accountId ?? undefined, query)
            : query && gmail.searchConversations ? await gmail.searchConversations(query, state, accountId ?? undefined)
              : accountId ? await gmail.listConversations(accountId, state) : await gmail.listUnifiedConversations(state)
          const page = conversations.slice(cursorValue, cursorValue + limitValue)
          const nextCursor = cursorValue + page.length < conversations.length ? String(cursorValue + page.length) : null
          return writeJson(response, 200, { source: 'gmail', scope: accountId ? 'account' : 'unified', state, mailbox, coverage: 'indexed', conversations: page, nextCursor, total: conversations.length, sync: gmail.syncStatus?.() })
        }
      } catch (error) {
        return writeJson(response, 502, { error: 'gmail_conversation_list_failed', detail: error instanceof Error ? error.message : String(error) })
      }
      return demoEnabled
        ? (() => {
            const conversations = provider.listConversations(state)
            const page = conversations.slice(cursorValue, cursorValue + limitValue)
            const nextCursor = cursorValue + page.length < conversations.length ? String(cursorValue + page.length) : null
            return writeJson(response, 200, { source: 'demo', scope: 'demo', state, conversations: page, nextCursor, total: conversations.length })
          })()
        : writeJson(response, 503, { error: 'gmail_not_connected', detail: 'No Gmail connector accounts are available.' })
    }
    if (request.method === 'POST' && url.pathname === '/v1/search-results') {
      try {
        const value = draftObject(await readJson(request))
        if (!value || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 2000
          || !Array.isArray(value.matches) || value.matches.length > 30
          || (value.requestId !== undefined && (typeof value.requestId !== 'string' || value.requestId.length > 100))) {
          return writeJson(response, 400, { error: 'invalid_search_results' })
        }
        const matches: SearchMatch[] = []
        for (const item of value.matches) {
          const match = draftObject(item)
          if (!match || typeof match.accountId !== 'string' || !match.accountId || typeof match.messageId !== 'string' || !match.messageId
            || typeof match.quote !== 'string' || !match.quote.trim() || match.quote.length > 500 || typeof match.reason !== 'string' || match.reason.length > 500) {
            return writeJson(response, 400, { error: 'invalid_search_match' })
          }
          matches.push({ accountId: match.accountId, messageId: match.messageId, quote: match.quote, reason: match.reason })
        }
        const searchResults = await projectSearchResults(value.query.trim(), matches, (accountId, id) => gmail.readMessage(accountId, id), value.requestId as string | undefined)
        return writeJson(response, 200, { searchResults })
      } catch (error) { return writeJson(response, 502, { error: 'search_evidence_failed', detail: error instanceof Error ? error.message : String(error) }) }
    }
    const conversationMatch = /^\/v1\/conversations\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'GET' && conversationMatch?.[1]) {
      const threadId = decodeURIComponent(conversationMatch[1])
      const mailbox = mailboxFilter(url.searchParams.get('mailbox'))
      if (!mailbox) return writeJson(response, 400, { error: 'invalid_mailbox' })
      const accountId = url.searchParams.get('account')
      if (accountId) {
        try {
          return writeJson(response, 200, { conversation: await gmail.readConversation(accountId, threadId, url.searchParams.get('offline') === 'true', mailbox) })
        } catch (error) {
          return writeJson(response, ['not_downloaded', 'conversation_not_in_mailbox'].includes((error as { code?: string }).code ?? '') ? 404 : 502, { error: (error as { code?: string }).code ?? 'gmail_conversation_read_failed', detail: error instanceof Error ? error.message : String(error) })
        }
      }
      if (!demoEnabled) return writeJson(response, 400, { error: 'gmail_account_required' })
      const conversation = provider.readConversation(threadId)
      return conversation ? writeJson(response, 200, { conversation }) : writeJson(response, 404, { error: 'conversation_not_found' })
    }
    const readStateMatch = /^\/v1\/conversations\/([^/]+)\/read-state$/.exec(url.pathname)
    if (request.method === 'POST' && readStateMatch?.[1]) {
      if (!gmail.setConversationUnread) return writeJson(response, 501, { error: 'gmail_read_state_not_configured' })
      try {
        const payload = await readJson(request) as { accountId?: unknown; unread?: unknown; messageIds?: unknown }
        if (typeof payload.accountId !== 'string' || typeof payload.unread !== 'boolean') return writeJson(response, 400, { error: 'accountId_and_unread_required' })
        const result = await gmail.setConversationUnread(payload.accountId, decodeURIComponent(readStateMatch[1]), payload.unread, Array.isArray(payload.messageIds) ? payload.messageIds.filter((id): id is string => typeof id === 'string') : undefined)
        return writeJson(response, 200, { accepted: true, result })
      } catch (error) {
        return writeJson(response, 502, { error: 'gmail_read_state_failed', detail: error instanceof Error ? error.message : String(error) })
      }
    }
    const actionMatch = /^\/v1\/conversations\/([^/]+)\/actions$/.exec(url.pathname)
    if (request.method === 'POST' && actionMatch?.[1]) {
      if (!gmail.mutateConversation) return writeJson(response, 501, { error: 'gmail_actions_not_configured' })
      try {
        const payload = await readJson(request) as { accountId?: unknown; messageIds?: unknown; action?: unknown }
        const action = payload.action as GmailConversationAction
        if (typeof payload.accountId !== 'string' || !Array.isArray(payload.messageIds) || !payload.messageIds.every((id) => typeof id === 'string') || !['archive', 'spam', 'trash', 'inbox'].includes(action)) return writeJson(response, 400, { error: 'invalid_gmail_action' })
        await gmail.mutateConversation(payload.accountId, decodeURIComponent(actionMatch[1]), payload.messageIds as string[], action)
        return writeJson(response, 202, { accepted: true, action })
      } catch (error) { return writeJson(response, 502, { error: 'gmail_action_failed', detail: error instanceof Error ? error.message : String(error) }) }
    }
    if (request.method === 'GET' && url.pathname === '/v1/messages') {
      const accountId = url.searchParams.get('account')
      try {
        const accounts = await gmail.accounts()
        if (accounts.length > 0) {
          const messages = accountId ? await gmail.listMessages(accountId) : await gmail.listUnifiedMessages()
          return writeJson(response, 200, { source: 'gmail', scope: accountId ? 'account' : 'unified', messages })
        }
      } catch (error) {
        return writeJson(response, 502, { error: 'gmail_list_failed', detail: error instanceof Error ? error.message : String(error) })
      }
      return demoEnabled
        ? writeJson(response, 200, { source: 'demo', messages: provider.listMessages() })
        : writeJson(response, 503, { error: 'gmail_not_connected', detail: 'No Gmail connector accounts are available.' })
    }
    if (request.method === 'GET' && url.pathname === '/v1/accounts') {
      if (url.searchParams.get('offline') === 'true' && gmail.cachedAccounts) return writeJson(response, 200, { accounts: gmail.cachedAccounts() })
      try {
        const cached = gmail.cachedAccounts?.() ?? []
        return writeJson(response, 200, { accounts: cached.length ? cached : await gmail.accounts() })
      } catch (error) {
        return writeJson(response, 502, { error: 'gmail_accounts_failed', detail: error instanceof Error ? error.message : String(error) })
      }
    }
    if (request.method === 'GET' && url.pathname === '/v1/recipients') {
      const query = url.searchParams.get('q') ?? ''
      const accountId = url.searchParams.get('account')
      try {
        const accounts = await gmail.accounts()
        if (accounts.length > 0) {
          const recipients = gmail.listRecipients ? await gmail.listRecipients(query, accountId ?? undefined) : []
          return writeJson(response, 200, { recipients })
        }
      } catch (error) {
        return writeJson(response, 502, { error: 'gmail_recipients_failed', detail: error instanceof Error ? error.message : String(error) })
      }
      return demoEnabled
        ? writeJson(response, 200, { recipients: provider.listRecipients(query) })
        : writeJson(response, 503, { error: 'gmail_not_connected', detail: 'No Gmail connector accounts are available.' })
    }
    if (request.method === 'GET' && url.pathname === '/v1/mailboxes/counts') {
      const accountId = url.searchParams.get('account') ?? undefined
      try {
        const cached = gmail.cachedAccounts?.() ?? []
        const accounts = cached.length ? cached : await gmail.accounts()
        if (accounts.length > 0 && gmail.mailboxCounts) return writeJson(response, 200, { source: 'gmail', counts: await gmail.mailboxCounts(accountId) })
      } catch (error) {
        return writeJson(response, 502, { error: 'gmail_counts_failed', detail: error instanceof Error ? error.message : String(error) })
      }
      return demoEnabled
        ? writeJson(response, 200, { source: 'demo', counts: { inbox: provider.listConversations('unread').length, drafts: 0, spam: 0 } })
        : writeJson(response, 503, { error: 'gmail_not_connected' })
    }
    if (request.method === 'GET' && url.pathname === '/v1/sync/status') {
      const status = gmail.syncStatus?.()
      return status
        ? writeJson(response, 200, { sync: status })
        : writeJson(response, 501, { error: 'gmail_sync_not_configured' })
    }
    if (request.method === 'POST' && url.pathname === '/v1/sync') {
      const controller = gmail as Partial<GmailConnectorProvider>
      if (controller.requestRefresh) {
        let reason = 'manual'
        try { const payload = draftObject(await readJson(request)); if (payload?.reason === 'wake' || payload?.reason === 'foreground') reason = payload.reason }
        catch { return writeJson(response, 400, { error: 'invalid_refresh_request' }) }
        controller.requestRefresh(reason)
        return writeJson(response, 202, { accepted: true, sync: gmail.syncStatus?.() })
      }
      if (!gmail.refreshNow && !gmail.syncNow) return writeJson(response, 501, { error: 'gmail_sync_not_configured' })
      try {
        if (gmail.refreshNow) await within(gmail.refreshNow(), 45_000, 'Gmail refresh')
        else await within(gmail.syncNow!(), 45_000, 'Gmail refresh')
        return writeJson(response, 200, { sync: gmail.syncStatus?.() })
      } catch (error) {
        return writeJson(response, 502, { error: 'gmail_refresh_failed', detail: error instanceof Error ? error.message : String(error), sync: gmail.syncStatus?.() })
      }
    }
    const messageMatch = /^\/v1\/messages\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'GET' && messageMatch?.[1]) {
      const accountId = url.searchParams.get('account')
      if (accountId) {
        try {
          return writeJson(response, 200, { message: await gmail.readMessage(accountId, decodeURIComponent(messageMatch[1])) })
        } catch (error) {
          return writeJson(response, 502, { error: 'gmail_read_failed', detail: error instanceof Error ? error.message : String(error) })
        }
      }
      const message = provider.readMessage(decodeURIComponent(messageMatch[1]))
      return message ? writeJson(response, 200, { message }) : writeJson(response, 404, { error: 'message_not_found' })
    }
    const attachmentOpenMatch = /^\/v1\/messages\/([^/]+)\/attachments\/([^/]+)\/open$/.exec(url.pathname)
    if (request.method === 'POST' && attachmentOpenMatch?.[1] && attachmentOpenMatch[2]) {
      const accountId = url.searchParams.get('account') ?? ''
      const filename = url.searchParams.get('filename') ?? ''
      const messageId = decodeURIComponent(attachmentOpenMatch[1])
      const attachmentId = decodeURIComponent(attachmentOpenMatch[2])
      try {
        const opened = await openAttachmentFile({
          messageId,
          attachmentId,
          filename,
          loadPayload: () => { if (url.searchParams.get('offline') === 'true') throw Object.assign(new Error('This attachment has not been downloaded.'), { code: 'attachment_not_found' }); return attachmentPayload(accountId, messageId, attachmentId, filename) },
          cacheDir: attachmentCacheDir,
          openPath,
        })
        return writeJson(response, 200, { opened: true, filename: opened.filename, path: opened.path })
      } catch (error) {
        return writeAttachmentError(response, 'gmail_attachment_open_failed', error)
      }
    }
    const attachmentCacheMatch = /^\/v1\/messages\/([^/]+)\/attachments\/([^/]+)\/cache$/.exec(url.pathname)
    if (request.method === 'POST' && attachmentCacheMatch?.[1] && attachmentCacheMatch[2]) {
      const accountId = url.searchParams.get('account') ?? ''
      const filename = url.searchParams.get('filename') ?? ''
      const messageId = decodeURIComponent(attachmentCacheMatch[1])
      const attachmentId = decodeURIComponent(attachmentCacheMatch[2])
      try {
        const file = await ensureAttachmentFile({ messageId, attachmentId, filename, loadPayload: () => { if (url.searchParams.get('offline') === 'true') throw Object.assign(new Error('This attachment has not been downloaded.'), { code: 'attachment_not_found' }); return attachmentPayload(accountId, messageId, attachmentId, filename) }, cacheDir: attachmentCacheDir })
        return writeJson(response, 200, { cached: true, reused: file.cached, filename: file.filename, mediaType: file.mediaType })
      } catch (error) {
        return writeAttachmentError(response, 'gmail_attachment_cache_failed', error)
      }
    }
    const attachmentMatch = /^\/v1\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'GET' && attachmentMatch?.[1] && attachmentMatch[2]) {
      const accountId = url.searchParams.get('account') ?? ''
      const filename = url.searchParams.get('filename') ?? ''
      const messageId = decodeURIComponent(attachmentMatch[1])
      const attachmentId = decodeURIComponent(attachmentMatch[2])
      const wantsJson = (request.headers.accept ?? '').includes('application/json')
      try {
        if (wantsJson && url.searchParams.get('offline') === 'true') return writeJson(response, 409, { error: 'Use the cached attachment file endpoint in downloaded mode.' })
        if (wantsJson) return writeJson(response, 200, { attachment: await attachmentPayload(accountId, messageId, attachmentId, filename) })
        // Browsers (inline cid: images, previews) get the cached bytes themselves.
        const file = await ensureAttachmentFile({ messageId, attachmentId, filename, loadPayload: () => { if (url.searchParams.get('offline') === 'true') throw Object.assign(new Error('This attachment has not been downloaded.'), { code: 'attachment_not_found' }); return attachmentPayload(accountId, messageId, attachmentId, filename) }, cacheDir: attachmentCacheDir })
        const bytes = await readFile(file.path)
        response.writeHead(200, {
          'content-type': file.mediaType,
          'content-length': bytes.length,
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          'access-control-allow-origin': allowedOrigin,
        })
        return response.end(bytes)
      } catch (error) {
        return writeAttachmentError(response, 'gmail_attachment_read_failed', error)
      }
    }
    if (request.method === 'POST' && url.pathname === '/v1/drafts/preview') {
      try {
        const body = draftObject(await readJson(request))
        if (!body) return writeJson(response, 400, { error: 'invalid_json' })
        return writeJson(response, 200, { bodyHtml: renderDraftMarkdown(String(body.bodyMarkdown ?? '')) })
      } catch {
        return writeJson(response, 400, { error: 'invalid_json' })
      }
    }
    if (request.method === 'POST' && url.pathname === '/v1/drafts/open') {
      let body: Record<string, unknown> | undefined
      try {
        body = draftObject(await readJson(request))
      } catch {
        return writeJson(response, 400, { error: 'invalid_json' })
      }
      if (!body) return writeJson(response, 400, { error: 'invalid_json' })
      if (typeof body.accountId !== 'string' || typeof body.messageId !== 'string') {
        return writeJson(response, 400, { error: 'accountId_and_messageId_required' })
      }
      if (!gmail.openGmailDraft) return writeJson(response, 501, { error: 'gmail_draft_open_not_configured' })
      try {
        return writeJson(response, 201, { draft: await gmail.openGmailDraft(body.accountId, body.messageId, typeof body.threadId === 'string' ? body.threadId : '') })
      } catch (error) {
        return writeJson(response, draftStatus(error), draftError(error, 'gmail_draft_update_failed'))
      }
    }
    if (request.method === 'POST' && url.pathname === '/v1/drafts') {
      let body: Record<string, unknown> | undefined
      try {
        body = draftObject(await readJson(request))
      } catch {
        return writeJson(response, 400, { error: 'invalid_json' })
      }
      if (!body) return writeJson(response, 400, { error: 'invalid_json' })
      const messageId = 'messageId' in body ? String(body.messageId) : ''
      if (typeof body.accountId === 'string' && gmail.createGmailDraft) {
        try {
          const draft = await gmail.createGmailDraft(body.accountId, messageId, String(body.to ?? ''), String(body.cc ?? ''), String(body.bcc ?? ''), String(body.subject ?? ''), String(body.bodyMarkdown ?? body.bodyText ?? ''), draftAttachments(body.attachments), typeof body.clientDraftId === 'string' ? body.clientDraftId : undefined)
          return writeJson(response, 201, { draft })
        } catch (error) {
          return writeJson(response, 502, draftError(error, 'gmail_draft_update_failed'))
        }
      }
      if (!demoEnabled) return writeJson(response, 400, { error: 'gmail_draft_fields_required' })
      const draft = 'bodyMarkdown' in body || 'bodyText' in body
        ? provider.createDraft(messageId, { bodyMarkdown: String(body.bodyMarkdown ?? body.bodyText ?? '') })
        : provider.createDraft(messageId)
      return draft ? writeJson(response, 201, { draft }) : writeJson(response, 404, { error: 'message_not_found' })
    }
    const attachMatch = /^\/v1\/drafts\/([^/]+)\/attachments$/.exec(url.pathname)
    if (request.method === 'POST' && attachMatch?.[1]) {
      const attachmentProvider = gmail as typeof gmail & { attachDraftFiles?: GmailConnectorProvider['attachDraftFiles'] }
      if (!attachmentProvider.attachDraftFiles) return writeJson(response, 501, { error: 'draft_attachments_unavailable' })
      try {
        const input = await readJson(request) as { accountId?: unknown; paths?: unknown }
        if (typeof input.accountId !== 'string' || !Array.isArray(input.paths) || !input.paths.length || !input.paths.every(path => typeof path === 'string')) return writeJson(response, 400, { error: 'account_and_file_paths_required' })
        return writeJson(response, 200, await attachmentProvider.attachDraftFiles(input.accountId, decodeURIComponent(attachMatch[1]), input.paths))
      } catch (error) { return writeJson(response, 502, { error: 'draft_attachment_failed', detail: String(error) }) }
    }
    const draftMatch = /^\/v1\/drafts\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'GET' && draftMatch?.[1]) {
      const draftId = decodeURIComponent(draftMatch[1])
      const accountId = url.searchParams.get('account')
      if (!accountId) {
        const draft = provider.readDraft(draftId)
        return draft ? writeJson(response, 200, { draft }) : writeJson(response, 404, { error: 'draft_not_found' })
      }
      if (!gmail.readGmailDraft) return writeJson(response, 501, { error: 'gmail_draft_read_not_configured' })
      try {
        return writeJson(response, 200, { draft: await gmail.readGmailDraft(accountId, draftId) })
      } catch (error) {
        return writeJson(response, draftStatus(error), draftError(error, 'gmail_draft_refresh_failed'))
      }
    }
    if (request.method === 'PATCH' && draftMatch?.[1] && gmail.patchGmailDraft) {
      try {
        const body = draftObject(await readJson(request))
        if (!body || typeof body.accountId !== 'string') return writeJson(response, 400, { error: 'gmail_draft_fields_required' })
        const fields: { to?: string; cc?: string; bcc?: string; subject?: string } = {}
        for (const key of ['to', 'cc', 'bcc', 'subject'] as const) {
          if (body[key] !== undefined) {
            if (typeof body[key] !== 'string') return writeJson(response, 400, { error: 'invalid_draft_header' })
            fields[key] = body[key] as string
          }
        }
        return writeJson(response, 200, { draft: await gmail.patchGmailDraft(body.accountId, decodeURIComponent(draftMatch[1]), fields) })
      } catch (error) { return writeJson(response, 502, draftError(error, 'gmail_draft_update_failed')) }
    }
    if (request.method === 'PUT' && draftMatch?.[1] && gmail.updateGmailDraft) {
      try {
        const body = draftObject(await readJson(request))
        if (!body) return writeJson(response, 400, { error: 'invalid_json' })
        const draft = await gmail.updateGmailDraft(projectDraft({ id: decodeURIComponent(draftMatch[1]), inReplyToMessageId: String(body.messageId ?? ''), to: [{ name: String(body.to ?? ''), address: String(body.to ?? ''), initials: '@' }], cc: String(body.cc ?? ''), bcc: String(body.bcc ?? ''), subject: String(body.subject ?? ''), bodyMarkdown: String(body.bodyMarkdown ?? body.bodyText ?? ''), attachments: draftAttachments(body.attachments), accountId: String(body.accountId ?? '') }), typeof body.clientDraftId === 'string' ? body.clientDraftId : undefined)
        return writeJson(response, 200, { draft })
      } catch (error) { return writeJson(response, 502, draftError(error, 'gmail_draft_update_failed')) }
    }
    if (request.method === 'POST' && draftMatch?.[1] && url.searchParams.get('action') === 'discard') {
      const draftId = decodeURIComponent(draftMatch[1])
      const accountId = url.searchParams.get('account')
      if (accountId) {
        if (!gmail.discardGmailDraft) return writeJson(response, 501, { error: 'gmail_draft_discard_not_configured' })
        try {
          await gmail.discardGmailDraft(accountId, draftId)
          return writeJson(response, 200, { discarded: true })
        } catch (error) {
          return writeJson(response, 502, draftError(error, 'gmail_draft_update_failed'))
        }
      }
      if (!demoEnabled) return writeJson(response, 400, { error: 'gmail_account_required' })
      return provider.discardDraft(draftId)
        ? writeJson(response, 200, { discarded: true })
        : writeJson(response, 404, { error: 'draft_not_found' })
    }
    if (request.method === 'POST' && draftMatch?.[1] && url.searchParams.get('action') === 'send' && gmail.sendGmailDraft) {
      try { const delivery = await gmail.sendGmailDraft(String(url.searchParams.get('account') ?? ''), decodeURIComponent(draftMatch[1])); return writeJson(response, 200, { delivery, receipt: (delivery as { receipt?: unknown })?.receipt }) }
      catch (error) { return writeJson(response, 502, { error: 'gmail_draft_send_failed', detail: error instanceof Error ? error.message : String(error) }) }
    }
    return writeJson(response, 404, { error: 'not_found' })
  })
  gmail.startBackgroundSync?.()
  server.on('close', () => gmail.stopBackgroundSync?.())
  return server
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  const port = Number(process.env.DISPATCH_MAIL_PORT ?? 8411)
  const server = createMailServer()
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`dispatch-mail ready on http://127.0.0.1:${port}\n`)
  })
  let closing = false
  const close = () => {
    if (closing) return
    closing = true; server.close(); server.closeAllConnections()
    setTimeout(() => process.exit(0), 2500).unref()
  }
  process.once('SIGINT', close); process.once('SIGTERM', close)
  watchParent(process.env.DISPATCH_PARENT_PID, close)
}
