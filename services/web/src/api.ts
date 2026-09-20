import type { SendReceipt, OfflineStatus, AppSummary, ConversationProjection, DispatchModelCatalog, ConversationSummary, DraftProjection, GmailAccount, GmailConversationAction, GmailMailbox, GmailSyncStatus, MailAddress, MailStateFilter, MessageProjection, MessageSummary, MailboxCounts } from './contracts.js'

declare const __DISPATCH_LOCAL_PROXY__: boolean
const MAIL = __DISPATCH_LOCAL_PROXY__ ? `${location.origin}/mail` : 'http://127.0.0.1:8411'
const AGENT = __DISPATCH_LOCAL_PROXY__ ? `${location.origin}/agent` : 'http://127.0.0.1:8412'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const endpoint = new URL(url).pathname
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Service request failed at ${endpoint}: ${detail}`)
  }
  const responseText = await response.text()
  let value: unknown
  try {
    value = responseText ? JSON.parse(responseText) as unknown : {}
  } catch {
    throw new Error(`Service returned invalid JSON at ${endpoint} (${response.status})`)
  }
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${JSON.stringify(value)}`)
  return value as T
}

function draftFields(fields: Record<string, unknown>): Record<string, unknown> {
  const bodyMarkdown = String(fields.bodyMarkdown ?? fields.bodyText ?? '')
  return { ...fields, bodyMarkdown, bodyText: bodyMarkdown }
}

export const api = {
  async listAccounts(offline = false): Promise<GmailAccount[]> {
    const result = await request<{ accounts: GmailAccount[] }>(`${MAIL}/v1/accounts${offline ? '?offline=true' : ''}`)
    return result.accounts
  },
  async listRecipients(query: string, accountId?: string): Promise<MailAddress[]> {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (accountId) params.set('account', accountId)
    const result = await request<{ recipients: MailAddress[] }>(`${MAIL}/v1/recipients?${params}`)
    return result.recipients
  },
  async mailboxCounts(accountId?: string): Promise<MailboxCounts> {
    const query = accountId ? `?account=${encodeURIComponent(accountId)}` : ''
    const result = await request<{ counts: MailboxCounts }>(`${MAIL}/v1/mailboxes/counts${query}`)
    return result.counts
  },
  async syncStatus(): Promise<GmailSyncStatus> {
    const result = await request<{ sync: GmailSyncStatus }>(`${MAIL}/v1/sync/status`)
    return result.sync
  },
  async refreshMail(reason: 'manual' | 'wake' | 'foreground' = 'manual'): Promise<GmailSyncStatus> {
    const result = await request<{ sync: GmailSyncStatus }>(`${MAIL}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) })
    return result.sync
  },
  async listMessages(accountId?: string): Promise<{ source: 'demo' | 'gmail'; messages: MessageSummary[] }> {
    const query = accountId ? `?account=${encodeURIComponent(accountId)}` : ''
    return request(`${MAIL}/v1/messages${query}`)
  },
  async listConversations(state: MailStateFilter, accountId?: string, cursor?: string, search?: string, mailbox: GmailMailbox = 'inbox', offline = false): Promise<{ source: 'demo' | 'gmail'; coverage?: 'indexed' | 'recent' | 'downloaded'; conversations: ConversationSummary[]; nextCursor: string | null; total: number; sync?: GmailSyncStatus }> {
    const params = new URLSearchParams({ state, mailbox, limit: '100' })
    if (accountId) params.set('account', accountId)
    if (offline) params.set('offline', 'true')
    if (cursor) params.set('cursor', cursor)
    if (search) params.set('q', search)
    return request(`${MAIL}/v1/conversations?${params}`)
  },
  async readConversation(threadId: string, accountId?: string, offline = false, mailbox: GmailMailbox = 'inbox'): Promise<ConversationProjection> {
    const query = new URLSearchParams()
    if (accountId) query.set('account', accountId)
    if (offline) query.set('offline', 'true')
    if (mailbox !== 'inbox') query.set('mailbox', mailbox)
    const result = await request<{ conversation: ConversationProjection }>(`${MAIL}/v1/conversations/${encodeURIComponent(threadId)}${query.size ? `?${query}` : ''}`)
    return result.conversation
  },
  async setConversationUnread(threadId: string, accountId: string, unread: boolean, messageIds: readonly string[] = []): Promise<void> {
    await request(`${MAIL}/v1/conversations/${encodeURIComponent(threadId)}/read-state`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId, unread, messageIds }),
    })
  },
  async mutateConversation(threadId: string, accountId: string, messageIds: readonly string[], action: GmailConversationAction): Promise<void> {
    await request(`${MAIL}/v1/conversations/${encodeURIComponent(threadId)}/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId, messageIds, action }),
    })
  },
  async readMessage(id: string, accountId?: string): Promise<MessageProjection> {
    const query = accountId ? `?account=${encodeURIComponent(accountId)}` : ''
    const result = await request<{ message: MessageProjection }>(`${MAIL}/v1/messages/${encodeURIComponent(id)}${query}`)
    return result.message
  },
  async readAttachment(messageId: string, attachmentId: string, accountId: string, filename: string): Promise<unknown> {
    const params = new URLSearchParams({ account: accountId, filename })
    const result = await request<{ attachment: unknown }>(`${MAIL}/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?${params}`, { headers: { accept: 'application/json' } })
    return result.attachment
  },
  /** URL that streams the cached attachment bytes, for inline images and previews. */
  attachmentFileUrl(messageId: string, attachmentId: string, accountId: string | undefined, filename: string, offline = false): string {
    const params = new URLSearchParams({ filename })
    if (accountId) params.set('account', accountId)
    if (offline) params.set('offline', 'true')
    return `${MAIL}/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?${params}`
  },
  /** Warms the mail cache so a later open or preview does not wait on the connector. */
  async cacheAttachment(messageId: string, attachmentId: string, accountId: string | undefined, filename: string): Promise<void> {
    const params = new URLSearchParams({ filename })
    if (accountId) params.set('account', accountId)
    await request(`${MAIL}/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/cache?${params}`, { method: 'POST' })
  },
  async openAttachment(messageId: string, attachmentId: string, accountId: string | undefined, filename: string, offline = false): Promise<void> {
    const params = new URLSearchParams({ filename })
    if (accountId) params.set('account', accountId)
    if (offline) params.set('offline', 'true')
    await request(`${MAIL}/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/open?${params}`, { method: 'POST' })
  },
  async openLocalDraftAttachment(filename: string, contentBase64: string): Promise<void> {
    await request(`${MAIL}/v1/drafts/attachments/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename, contentBase64 }),
    })
  },
  async createDraft(messageId: string, fields: Record<string, unknown> = {}): Promise<DraftProjection> {
    const result = await request<{ draft: DraftProjection }>(`${MAIL}/v1/drafts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId, ...draftFields(fields) }),
    })
    return result.draft
  },
  async updateDraft(id: string, fields: Record<string, unknown>): Promise<DraftProjection> {
    const result = await request<{ draft: DraftProjection }>(`${MAIL}/v1/drafts/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draftFields(fields)) })
    return result.draft
  },
  async previewDraft(bodyMarkdown: string): Promise<string> {
    const result = await request<{ bodyHtml: string }>(`${MAIL}/v1/drafts/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bodyMarkdown }),
    })
    return result.bodyHtml
  },
  async getDraft(id: string, accountId: string): Promise<DraftProjection> {
    const result = await request<{ draft: DraftProjection }>(`${MAIL}/v1/drafts/${encodeURIComponent(id)}?account=${encodeURIComponent(accountId)}`)
    return result.draft
  },
  async discardDraft(id: string, accountId: string): Promise<void> {
    await request(`${MAIL}/v1/drafts/${encodeURIComponent(id)}?action=discard&account=${encodeURIComponent(accountId)}`, { method: 'POST' })
  },
  async openDraftFromMessage(accountId: string, messageId: string, threadId?: string): Promise<DraftProjection> {
    const result = await request<{ draft: DraftProjection }>(`${MAIL}/v1/drafts/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId, messageId, threadId }),
    })
    return result.draft
  },
  async sendDraft(id: string, accountId: string): Promise<SendReceipt | undefined> {
    const result = await request<{ receipt?: SendReceipt }>(`${MAIL}/v1/drafts/${encodeURIComponent(id)}?action=send&account=${encodeURIComponent(accountId)}`, { method: 'POST' })
    return result.receipt
  },
  async offlineStatus(): Promise<OfflineStatus> { return (await request<{ offline: OfflineStatus }>(`${MAIL}/v1/offline`)).offline },
  async downloadMailbox(mailbox: GmailMailbox, accountId?: string): Promise<void> { await request(`${MAIL}/v1/offline`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mailbox, accountId }) }) },
  async cancelDownload(): Promise<void> { await request(`${MAIL}/v1/offline`, { method: 'DELETE' }) },
  async agentReady(): Promise<boolean> {
    try { return (await fetch(`${AGENT}/ready`, { signal: AbortSignal.timeout(3_000) })).ok } catch { return false }
  },
  async listModels(): Promise<DispatchModelCatalog> {
    return request(`${AGENT}/v1/models`)
  },
  async listApps(): Promise<AppSummary[]> {
    const result = await request<{ data?: AppSummary[] }>(`${AGENT}/v1/apps`)
    return result.data ?? []
  },
  async startThread(): Promise<string> {
    const result = await request<{ thread: { id: string } }>(`${AGENT}/v1/threads`, { method: 'POST' })
    return result.thread.id
  },
  async bindThread(key: { kind: 'unbound' } | { kind: 'draft'; draftKey: string } | { kind: 'conversation'; accountId: string; gmailThreadId: string }, adoptThreadId?: string, options: { replace?: boolean } = {}): Promise<{ key: unknown; threadId: string; created: boolean; replaced: boolean; detail?: string }> {
    const result = await request<{ binding: { key: unknown; threadId: string; created: boolean; replaced: boolean; detail?: string } }>(`${AGENT}/v1/threads/bindings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...key, ...adoptThreadId ? { adoptThreadId } : {}, ...options.replace ? { replace: true } : {} }),
    })
    return result.binding
  },
  async resumeThread(threadId: string): Promise<string> {
    const result = await request<{ thread: { id: string } }>(`${AGENT}/v1/threads/${encodeURIComponent(threadId)}/resume`, { method: 'POST' })
    return result.thread.id
  },
  async readThread(threadId: string): Promise<unknown> {
    return request(`${AGENT}/v1/threads/${encodeURIComponent(threadId)}`)
  },
  async steerTurn(threadId: string, expectedTurnId: string, text: string): Promise<void> {
    await request(`${AGENT}/v1/threads/${encodeURIComponent(threadId)}/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedTurnId, text }) })
  },
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await request(`${AGENT}/v1/threads/${encodeURIComponent(threadId)}/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnId }) })
  },
  async startTurn(threadId: string, payload: Record<string, unknown>): Promise<void> {
    await request(`${AGENT}/v1/threads/${encodeURIComponent(threadId)}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
  },
  events(threadId: string): EventSource {
    return new EventSource(`${AGENT}/v1/events?threadId=${encodeURIComponent(threadId)}`)
  },
  activity(): EventSource { return new EventSource(`${AGENT}/v1/activity`) },
  async respondToServerRequest(id: number | string, result: unknown): Promise<void> {
    await request(`${AGENT}/v1/server-requests/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, result }),
    })
  },
}
