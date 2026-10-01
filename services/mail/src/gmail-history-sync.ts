import type { GmailIndex, IndexedGmailAccount, IndexedGmailMessage } from './gmail-index.js'

export interface GmailHistoryTransport {
  connected(account: IndexedGmailAccount): Promise<boolean>
  get(account: IndexedGmailAccount, path: string, signal: AbortSignal): Promise<unknown>
}

export class GmailApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Gmail API ${status}: ${code}`) }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Gmail API object')
  return value as Record<string, unknown>
}
function list(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Invalid Gmail API list')
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid Gmail message identity')
  return value
}
function checkpoint(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('Invalid Gmail history ID')
  return value
}
function nextToken(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || !value) throw new Error('Invalid Gmail page token')
  return value
}

/** Mail-owned synchronization. No filtered history: an off-screen folder change still matters. */
export class GmailHistorySync {
  constructor(
    readonly index: GmailIndex,
    readonly transport: GmailHistoryTransport,
    readonly project: (value: unknown, account: IndexedGmailAccount) => IndexedGmailMessage,
    readonly maxPages = 1_000,
    readonly onBootstrap?: (signal: AbortSignal) => void,
    readonly onProgress?: (kind: 'page' | 'message') => void,
  ) {}

  async synchronize(account: IndexedGmailAccount, signal: AbortSignal, full = false): Promise<boolean> {
    if (this.index.directSyncDisabled(account.id)) return false
    if (!await this.transport.connected(account)) return false
    signal.throwIfAborted()
    const start = this.index.historyCheckpoint(account.id, account.email)
    if (!start || full) {
      await this.#bootstrap(account, signal)
    } else {
      try { await this.#delta(account, start, signal); return true }
      catch (error) {
        if (!(error instanceof GmailApiError) || error.status !== 404 || error.code !== 'history_expired') throw error
        await this.#bootstrap(account, signal)
      }
    }
    return true
  }

  async #pages(account: IndexedGmailAccount, path: string, signal: AbortSignal, visit: (page: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    let token = ''
    const seen = new Set<string>()
    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber++) {
      const page = object(await this.transport.get(account, `${path}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, signal))
      signal.throwIfAborted()
      this.onProgress?.('page')
      visit(page)
      token = nextToken(page.nextPageToken)
      if (!token) return page
      if (seen.has(token)) throw new Error('Gmail API pagination repeated a page token')
      seen.add(token)
    }
    throw new Error(`Gmail API pagination exceeded ${this.maxPages} pages`)
  }

  async #hydrate(account: IndexedGmailAccount, ids: ReadonlySet<string>, signal: AbortSignal, stage?: (messages: IndexedGmailMessage[], deleted: string[]) => void, cached?: ReadonlyMap<string, IndexedGmailMessage>): Promise<{ messages: IndexedGmailMessage[]; deleted: string[] }> {
    const messages: IndexedGmailMessage[] = []
    const deleted: string[] = []
    const pending = [...ids]
    let offset = 0
    // Batches settle before returning on failure: no orphan work can mutate a later pass.
    while (offset < pending.length) {
      const messagesBefore = messages.length; const deletedBefore = deleted.length
      const results = await Promise.allSettled(pending.slice(offset, offset + 4).map(async messageId => {
        try {
          const known = cached?.get(messageId)
          const value = await this.transport.get(account, `messages/${encodeURIComponent(messageId)}?format=${known ? 'metadata' : 'full'}`, signal)
          signal.throwIfAborted()
          const projected = this.project(value, account)
          // Gmail message MIME is immutable by message ID; draft replacement creates a new ID.
          const message = known ? { ...projected, hasAttachment: known.hasAttachment } : projected
          if (message.id !== messageId || message.accountId !== account.id) throw new Error('Gmail API returned another message identity')
          messages.push(message)
          this.onProgress?.('message')
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof GmailApiError && error.status === 404 && error.code === 'message_not_found') deleted.push(messageId)
          else throw error
        }
      }))
      signal.throwIfAborted()
      stage?.(messages.slice(messagesBefore), deleted.slice(deletedBefore))
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      offset += 4
    }
    return { messages, deleted }
  }

  async #bootstrap(account: IndexedGmailAccount, signal: AbortSignal): Promise<void> {
    this.onBootstrap?.(signal)
    let baseline = this.index.historyBaseline(account.id, account.email)
    if (!baseline) {
      const profile = object(await this.transport.get(account, 'profile', signal))
      if (typeof profile.emailAddress !== 'string' || profile.emailAddress.toLowerCase() !== account.email.toLowerCase()) throw new Error('Gmail API account does not match the selected account')
      const start = checkpoint(profile.historyId)
      const ids = new Set<string>()
      await this.#pages(account, 'messages?includeSpamTrash=true&maxResults=500', signal, page => {
        for (const message of list(page.messages)) ids.add(id(object(message).id))
      })
      this.index.beginHistoryBaseline(account.id, account.email, start, ids)
      baseline = this.index.historyBaseline(account.id, account.email)!
    }
    const cached = new Map(this.index.messages(account.id).map(message => [message.id, message]))
    await this.#hydrate(account, new Set(baseline.pending), signal, (messages, deleted) => this.index.stageHistoryBaseline(account.id, messages, deleted), cached)
    baseline = this.index.historyBaseline(account.id, account.email)!
    let delta: Awaited<ReturnType<GmailHistorySync['readDelta']>>
    try { delta = await this.readDelta(account, baseline.historyId, signal) }
    catch (error) {
      if (error instanceof GmailApiError && error.code === 'history_expired') this.index.clearHistoryBaseline(account.id)
      throw error
    }
    signal.throwIfAborted()
    const messages = new Map(baseline.messages.map(message => [message.id, message]))
    for (const message of delta.messages) messages.set(message.id, message)
    const deleted = new Set([...baseline.deleted, ...delta.deleted])
    for (const id of deleted) messages.delete(id)
    // Catch changes made during a long or resumed scan BEFORE publishing its complete snapshot.
    this.index.applyHistory(account.id, account.email, [...messages.values()], [...deleted], delta.historyId, true)
  }

  async #delta(account: IndexedGmailAccount, start: string, signal: AbortSignal): Promise<void> {
    const delta = await this.readDelta(account, start, signal)
    signal.throwIfAborted()
    this.index.applyHistory(account.id, account.email, delta.messages, delta.deleted, delta.historyId)
  }

  private async readDelta(account: IndexedGmailAccount, start: string, signal: AbortSignal): Promise<{ messages: IndexedGmailMessage[]; deleted: string[]; historyId: string }> {
    const changed = new Set<string>()
    let highest = BigInt(start)
    const last = await this.#pages(account, `history?startHistoryId=${encodeURIComponent(start)}&maxResults=500`, signal, page => {
      for (const item of list(page.history)) {
        const record = object(item)
        const historyId = checkpoint(record.id)
        if (BigInt(historyId) <= BigInt(start)) throw new Error('Gmail history did not advance')
        if (BigInt(historyId) > highest) highest = BigInt(historyId)
        // Generic messages can duplicate the typed entries. Include both and deduplicate IDs.
        for (const message of list(record.messages)) changed.add(id(object(message).id))
        for (const key of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
          for (const event of list(record[key])) changed.add(id(object(object(event).message).id))
        }
      }
    })
    const end = checkpoint(last.historyId)
    if (BigInt(end) < highest) throw new Error('Gmail history checkpoint moved backwards')
    const hydrated = await this.#hydrate(account, changed, signal)
    signal.throwIfAborted()
    return { ...hydrated, historyId: end }
  }
}
