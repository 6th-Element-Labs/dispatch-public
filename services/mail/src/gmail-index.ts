import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { groupConversations } from './conversation.js'
import type { ConversationSummary, GmailConversationAction, GmailMailbox, MailAddress, MailStateFilter, MailboxCounts, MessageSummary } from './model.js'

export interface IndexedGmailMessage extends MessageSummary {
  readonly inInbox: boolean
  readonly inSent: boolean
  readonly inDrafts: boolean
  readonly inArchive: boolean
  readonly inSpam: boolean
  readonly inTrash: boolean
}

export function folderFlagsFromLabels(labels: readonly unknown[]): Pick<
  IndexedGmailMessage, 'inInbox' | 'inSent' | 'inDrafts' | 'inArchive' | 'inSpam' | 'inTrash'
> {
  // Gmail keeps INBOX, SENT, and DRAFT labels on messages it has moved to
  // Trash or Spam; a trashed draft is in Trash, not in Drafts.
  const inSpam = labels.includes('SPAM')
  const inTrash = labels.includes('TRASH')
  const shelved = inSpam || inTrash
  const inInbox = !shelved && labels.includes('INBOX')
  const inSent = !shelved && labels.includes('SENT')
  const inDrafts = !shelved && labels.includes('DRAFT')
  return {
    inInbox,
    inSent,
    inDrafts,
    inSpam,
    inTrash,
    inArchive: !inInbox && !inSent && !inDrafts && !inSpam && !inTrash,
  }
}

export function flagsAfterAction(
  message: Pick<IndexedGmailMessage, 'inInbox' | 'inSent' | 'inDrafts' | 'inArchive' | 'inSpam' | 'inTrash'>,
  action: GmailConversationAction,
): Pick<IndexedGmailMessage, 'inInbox' | 'inSent' | 'inDrafts' | 'inArchive' | 'inSpam' | 'inTrash'> {
  if (action === 'archive') {
    const next = { ...message, inInbox: false }
    return {
      ...next,
      inArchive: !next.inInbox && !next.inSent && !next.inDrafts && !next.inSpam && !next.inTrash,
    }
  }
  if (action === 'trash') {
    return { ...message, inTrash: true, inInbox: false, inArchive: false, inSent: false, inDrafts: false }
  }
  if (action === 'spam') {
    return { ...message, inSpam: true, inInbox: false, inArchive: false }
  }
  return { ...message, inInbox: true, inSpam: false, inTrash: false, inArchive: false }
}

export interface IndexedGmailAccount {
  readonly id: string
  readonly connectorId: string
  readonly name: string
  readonly email: string
}

export interface GmailSyncStatus {
  readonly mailRevision?: number
  readonly draftsRevision?: number
  readonly state: 'idle' | 'syncing' | 'partial' | 'ready' | 'failed'
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly error: string | null
  readonly messageCount: number
}

type MessageRow = {
  id: string
  thread_id: string
  account_id: string
  account_label: string
  sender_name: string
  sender_address: string
  sender_initials: string
  subject: string
  received_at: string
  received_label: string
  received_full_label: string
  preview: string
  unread: number
  in_inbox: number
  in_sent: number
  in_drafts: number
  in_archive: number
  in_spam: number
  in_trash: number
  has_attachment: number
}

function queueEligible(message: IndexedGmailMessage, state: MailStateFilter): boolean {
  if (!message.inInbox || message.inSpam || message.inTrash || message.inDrafts) return false
  if (state === 'unread') return message.unread
  if (state === 'read') return message.inInbox
  return true
}

function folderMember(message: IndexedGmailMessage, mailbox: Exclude<GmailMailbox, 'inbox'>): boolean {
  if (mailbox === 'sent') return message.inSent
  if (mailbox === 'drafts') return message.inDrafts
  if (mailbox === 'archive') return message.inArchive
  if (mailbox === 'spam') return message.inSpam
  return message.inTrash
}

function filterSearch(messages: readonly IndexedGmailMessage[], query: string): IndexedGmailMessage[] {
  const terms = query.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((term) => term.replace(/^"|"$/g, '')) ?? []
  let filtered = [...messages]
  for (const term of terms) {
    const separator = term.indexOf(':')
    const field = separator > 0 ? term.slice(0, separator).toLowerCase() : ''
    const value = separator > 0 ? term.slice(separator + 1).toLowerCase() : term.toLowerCase()
    if (field === 'from') filtered = filtered.filter((message) => `${message.sender.name} ${message.sender.address}`.toLowerCase().includes(value))
    else if (field === 'subject') filtered = filtered.filter((message) => message.subject.toLowerCase().includes(value))
    else if (field === 'is' && value === 'unread') filtered = filtered.filter((message) => message.unread)
    else if (field === 'is' && value === 'read') filtered = filtered.filter((message) => !message.unread)
    else if (field === 'has' && value === 'attachment') filtered = filtered.filter((message) => message.hasAttachment)
    else if (field === 'after' || field === 'before') {
      const boundary = Date.parse(value)
      if (Number.isNaN(boundary)) throw new Error(`Invalid Gmail date search: ${term}`)
      filtered = filtered.filter((message) => field === 'after' ? Date.parse(message.receivedAt) > boundary : Date.parse(message.receivedAt) < boundary)
    } else if (!field) {
      filtered = filtered.filter((message) => `${message.sender.name} ${message.sender.address} ${message.subject} ${message.preview}`.toLowerCase().includes(value))
    } else throw new Error(`Unsupported Gmail search operator: ${field}:`)
  }
  return filtered
}

export type IndexStreamFlag = 'inbox' | 'unread' | 'sent' | 'drafts' | 'spam' | 'trash' | 'archive'

const STREAM_COLUMNS: Record<IndexStreamFlag, string> = {
  inbox: 'in_inbox', unread: 'unread', sent: 'in_sent', drafts: 'in_drafts', spam: 'in_spam', trash: 'in_trash', archive: 'in_archive',
}

export class GmailIndex {
  readonly #db: DatabaseSync
  readonly #acceptedUnread = new Map<string, boolean>()
  readonly #acceptedActions = new Map<string, GmailConversationAction>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS gmail_action_overlay (key TEXT PRIMARY KEY, action TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gmail_unread_overlay (key TEXT PRIMARY KEY, unread INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gmail_action_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, payload TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS gmail_messages (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        sender_initials TEXT NOT NULL,
        subject TEXT NOT NULL,
        received_at TEXT NOT NULL,
        received_label TEXT NOT NULL,
        received_full_label TEXT NOT NULL,
        preview TEXT NOT NULL,
        unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
        in_inbox INTEGER NOT NULL CHECK (in_inbox IN (0, 1)),
        in_sent INTEGER NOT NULL DEFAULT 0 CHECK (in_sent IN (0, 1)),
        in_drafts INTEGER NOT NULL DEFAULT 0 CHECK (in_drafts IN (0, 1)),
        in_archive INTEGER NOT NULL DEFAULT 0 CHECK (in_archive IN (0, 1)),
        in_spam INTEGER NOT NULL DEFAULT 0 CHECK (in_spam IN (0, 1)),
        in_trash INTEGER NOT NULL DEFAULT 0 CHECK (in_trash IN (0, 1)),
        has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1)),
        sync_run_id TEXT NOT NULL,
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX IF NOT EXISTS gmail_messages_received ON gmail_messages(received_at DESC);
      CREATE INDEX IF NOT EXISTS gmail_messages_thread ON gmail_messages(account_id, thread_id);
      CREATE TABLE IF NOT EXISTS gmail_accounts (
        account_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gmail_sync_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      );
      INSERT OR IGNORE INTO gmail_sync_state(singleton, state) VALUES (1, 'idle');
    `)
    const columns = this.#db.prepare('PRAGMA table_info(gmail_messages)').all() as unknown as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'has_attachment')) this.#db.exec('ALTER TABLE gmail_messages ADD COLUMN has_attachment INTEGER NOT NULL DEFAULT 0')
    for (const name of ['in_sent', 'in_drafts', 'in_archive', 'in_spam', 'in_trash'] as const) {
      if (!columns.some((column) => column.name === name)) {
        this.#db.exec(`ALTER TABLE gmail_messages ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`)
      }
    }
    for (const row of this.#db.prepare('SELECT CAST(key AS BLOB) AS key,action FROM gmail_action_overlay').all()) this.#acceptedActions.set(Buffer.from(row.key as Uint8Array).toString(), String(row.action) as GmailConversationAction)
    for (const row of this.#db.prepare('SELECT CAST(key AS BLOB) AS key,unread FROM gmail_unread_overlay').all()) this.#acceptedUnread.set(Buffer.from(row.key as Uint8Array).toString(), row.unread === 1)
  }

  replaceAccount(accountId: string, messages: readonly IndexedGmailMessage[], runId: string, complete: boolean): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const upsert = this.#db.prepare(`
        INSERT INTO gmail_messages (
          account_id, id, thread_id, account_label, sender_name, sender_address, sender_initials,
          subject, received_at, received_label, received_full_label, preview, unread, in_inbox,
          in_sent, in_drafts, in_archive, in_spam, in_trash, has_attachment, sync_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, id) DO UPDATE SET
          thread_id=excluded.thread_id, account_label=excluded.account_label,
          sender_name=excluded.sender_name, sender_address=excluded.sender_address,
          sender_initials=excluded.sender_initials, subject=excluded.subject,
          received_at=excluded.received_at, received_label=excluded.received_label,
          received_full_label=excluded.received_full_label, preview=excluded.preview,
          unread=excluded.unread, in_inbox=excluded.in_inbox, in_sent=excluded.in_sent,
          in_drafts=excluded.in_drafts, in_archive=excluded.in_archive, in_spam=excluded.in_spam,
          in_trash=excluded.in_trash, has_attachment=excluded.has_attachment, sync_run_id=excluded.sync_run_id
      `)
      for (const message of messages) {
        upsert.run(
          accountId, message.id, message.threadId, message.accountLabel ?? '',
          message.sender.name, message.sender.address, message.sender.initials,
          message.subject, message.receivedAt, message.receivedLabel, message.receivedFullLabel,
          message.preview, Number(message.unread), Number(message.inInbox),
          Number(message.inSent), Number(message.inDrafts), Number(message.inArchive),
          Number(message.inSpam), Number(message.inTrash), Number(message.hasAttachment === true), runId,
        )
      }
      if (complete) this.#db.prepare('DELETE FROM gmail_messages WHERE account_id = ? AND sync_run_id <> ? AND NOT EXISTS (SELECT 1 FROM gmail_action_overlay WHERE key=account_id || char(0) || id) AND NOT EXISTS (SELECT 1 FROM gmail_unread_overlay WHERE key=account_id || char(0) || id)').run(accountId, runId)
      this.#reapplyAcceptedUnread(accountId, messages)
      this.#reapplyAcceptedActions(accountId, messages)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * A stream that Gmail returned in full (no next page) is the truth for its
   * flag: rows still carrying the flag that Gmail no longer lists lose it, and
   * rows left in no folder at all are gone from Gmail, so they are deleted.
   * Called per stream so a mailbox too large for a complete sync still drops
   * sent or deleted drafts, emptied trash, and read mail. Rows this run
   * upserted (any stream) are never touched here: their flags already came
   * from Gmail's labels.
   */
  reconcileStream(accountId: string, flag: IndexStreamFlag, presentIds: readonly string[], runId: string): { cleared: number; removed: number } {
    const column = STREAM_COLUMNS[flag]
    const present = new Set(presentIds)
    const rows = this.#db.prepare(`SELECT id FROM gmail_messages WHERE account_id = ? AND ${column} = 1 AND sync_run_id <> ?`).all(accountId, runId) as unknown as Array<{ id: string }>
    const stale = rows.map((row) => row.id).filter((id) => !present.has(id))
    if (stale.length === 0) return { cleared: 0, removed: 0 }
    const clear = this.#db.prepare(`UPDATE gmail_messages SET ${column} = 0 WHERE account_id = ? AND id = ?`)
    const remove = this.#db.prepare(`
      DELETE FROM gmail_messages WHERE account_id = ? AND id = ?
        AND in_inbox = 0 AND in_sent = 0 AND in_drafts = 0 AND in_spam = 0 AND in_trash = 0 AND in_archive = 0`)
    let removed = 0
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of stale) {
        if (this.#acceptedActions.has(`${accountId}\0${id}`)) continue
        if (flag === 'unread' && this.#acceptedUnread.has(`${accountId}\0${id}`)) continue
        clear.run(accountId, id)
        removed += Number(remove.run(accountId, id).changes)
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return { cleared: stale.length, removed }
  }

  pruneAccounts(accountIds: readonly string[]): void {
    if (accountIds.length === 0) throw new Error('Cannot prune Gmail index without an authoritative account list')
    const placeholders = accountIds.map(() => '?').join(', ')
    this.#db.prepare(`DELETE FROM gmail_messages WHERE account_id NOT IN (${placeholders})`).run(...accountIds)
  }

  replaceAccounts(accounts: readonly IndexedGmailAccount[], seenAt: string): void {
    if (accounts.length === 0) throw new Error('Cannot replace Gmail accounts with an empty connector result')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const upsert = this.#db.prepare(`
        INSERT INTO gmail_accounts(account_id, connector_id, name, email, last_seen_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET connector_id=excluded.connector_id, name=excluded.name,
          email=excluded.email, last_seen_at=excluded.last_seen_at
      `)
      for (const account of accounts) upsert.run(account.id, account.connectorId, account.name, account.email, seenAt)
      const placeholders = accounts.map(() => '?').join(', ')
      this.#db.prepare(`DELETE FROM gmail_accounts WHERE account_id NOT IN (${placeholders})`).run(...accounts.map((account) => account.id))
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  accounts(): readonly IndexedGmailAccount[] {
    const rows = this.#db.prepare('SELECT account_id, connector_id, name, email FROM gmail_accounts ORDER BY name, email').all() as unknown as Array<{
      account_id: string; connector_id: string; name: string; email: string
    }>
    return rows.map((row) => ({ id: row.account_id, connectorId: row.connector_id, name: row.name, email: row.email }))
  }

  messages(accountId?: string): readonly IndexedGmailMessage[] {
    const rows = (accountId
      ? this.#db.prepare('SELECT * FROM gmail_messages WHERE account_id = ? ORDER BY received_at DESC').all(accountId)
      : this.#db.prepare('SELECT * FROM gmail_messages ORDER BY received_at DESC').all()) as unknown as MessageRow[]
    return rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      accountId: row.account_id,
      accountLabel: row.account_label,
      sender: { name: row.sender_name, address: row.sender_address, initials: row.sender_initials },
      subject: row.subject,
      receivedAt: row.received_at,
      receivedLabel: row.received_label,
      receivedFullLabel: row.received_full_label,
      preview: row.preview,
      unread: row.unread === 1,
      inInbox: row.in_inbox === 1,
      inSent: row.in_sent === 1,
      inDrafts: row.in_drafts === 1,
      inArchive: row.in_archive === 1,
      inSpam: row.in_spam === 1,
      inTrash: row.in_trash === 1,
      hasAttachment: row.has_attachment === 1,
    }))
  }

  threadMessageIds(accountId: string, threadId: string): readonly string[] {
    const rows = this.#db.prepare('SELECT id FROM gmail_messages WHERE account_id = ? AND thread_id = ?').all(accountId, threadId) as unknown as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  setUnread(accountId: string, messageIds: readonly string[], unread: boolean, enqueue = false): void {
    if (messageIds.length === 0) throw new Error('Cannot update read state without indexed Gmail message IDs')
    const update = this.#db.prepare('UPDATE gmail_messages SET unread = ? WHERE account_id = ? AND id = ?')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (enqueue) this.#db.prepare('INSERT INTO gmail_action_queue(account_id,payload) VALUES (?,?)').run(accountId, JSON.stringify({ messageIds, action: unread ? 'unread' : 'read' }))
      for (const id of messageIds) {
        update.run(Number(unread), accountId, id)
        this.#acceptedUnread.set(`${accountId}\0${id}`, unread)
        this.#db.prepare('INSERT OR REPLACE INTO gmail_unread_overlay VALUES (?,?)').run(`${accountId}\0${id}`, Number(unread))
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #reapplyAcceptedUnread(accountId: string, incoming: readonly IndexedGmailMessage[]): void {
    const incomingById = new Map(incoming.map((message) => [message.id, message]))
    const update = this.#db.prepare('UPDATE gmail_messages SET unread = ? WHERE account_id = ? AND id = ?')
    const exists = this.#db.prepare('SELECT 1 FROM gmail_messages WHERE account_id = ? AND id = ?')
    for (const [key, unread] of [...this.#acceptedUnread]) {
      const separator = key.indexOf('\0')
      if (key.slice(0, separator) !== accountId) continue
      const id = key.slice(separator + 1)
      const snapshot = incomingById.get(id)
      if (snapshot?.unread === unread || !exists.get(accountId, id)) {
        if (this.pendingActions().some(job => job.accountId === accountId && job.messageIds.includes(id) && (job.action === 'read' || job.action === 'unread'))) continue
        this.#acceptedUnread.delete(key)
        this.#db.prepare('DELETE FROM gmail_unread_overlay WHERE key=?').run(key)
        continue
      }
      update.run(Number(unread), accountId, id)
    }
  }

  #reapplyAcceptedActions(accountId: string, incoming: readonly IndexedGmailMessage[]): void {
    const incomingById = new Map(incoming.map((message) => [message.id, message]))
    const update = this.#db.prepare('UPDATE gmail_messages SET in_inbox=?, in_sent=?, in_drafts=?, in_archive=?, in_spam=?, in_trash=? WHERE account_id=? AND id=?')
    const exists = this.#db.prepare('SELECT 1 FROM gmail_messages WHERE account_id = ? AND id = ?')
    for (const [key, action] of [...this.#acceptedActions]) {
      const separator = key.indexOf('\0')
      if (key.slice(0, separator) !== accountId) continue
      const id = key.slice(separator + 1)
      const snapshot = incomingById.get(id)
      if (!snapshot) continue
      if (!exists.get(accountId, id)) continue
      const desired = flagsAfterAction(snapshot, action)
      if (desired.inInbox === snapshot.inInbox && desired.inSent === snapshot.inSent && desired.inDrafts === snapshot.inDrafts && desired.inArchive === snapshot.inArchive && desired.inSpam === snapshot.inSpam && desired.inTrash === snapshot.inTrash) {
        // Pending commands remain authoritative even if a stale snapshot happens
        // to match a newer local action before its provider write completes.
        if (this.pendingActions().some(job => job.accountId === accountId && job.messageIds.includes(id))) continue
        this.#acceptedActions.delete(key)
        this.#db.prepare('DELETE FROM gmail_action_overlay WHERE key=?').run(key)
        continue
      }
      update.run(Number(desired.inInbox), Number(desired.inSent), Number(desired.inDrafts), Number(desired.inArchive), Number(desired.inSpam), Number(desired.inTrash), accountId, id)
    }
  }

  pendingActions(): Array<{ id: number; accountId: string; messageIds: string[]; action: GmailConversationAction | 'read' | 'unread'; error?: string }> {
    return this.#db.prepare('SELECT * FROM gmail_action_queue ORDER BY id').all().map(row => ({ id: Number(row.id), accountId: String(row.account_id), ...JSON.parse(String(row.payload)), error: row.error ? String(row.error) : undefined }))
  }

  finishAction(id: number): void { this.#db.prepare('DELETE FROM gmail_action_queue WHERE id=?').run(id) }
  failAction(id: number, error: string): void { this.#db.prepare('UPDATE gmail_action_queue SET error=? WHERE id=?').run(error, id) }

  applyConversationAction(accountId: string, messageIds: readonly string[], action: GmailConversationAction, enqueue = false): void {
    if (messageIds.length === 0) throw new Error('Cannot update folder flags without indexed Gmail message IDs')
    const select = this.#db.prepare('SELECT * FROM gmail_messages WHERE account_id = ? AND id = ?')
    const update = this.#db.prepare(`
      UPDATE gmail_messages SET in_inbox=?, in_sent=?, in_drafts=?, in_archive=?, in_spam=?, in_trash=?
      WHERE account_id=? AND id=?
    `)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (enqueue) this.#db.prepare('INSERT INTO gmail_action_queue(account_id,payload) VALUES (?,?)').run(accountId, JSON.stringify({ messageIds, action }))
      for (const id of messageIds) {
        const row = select.get(accountId, id) as MessageRow | undefined
        if (!row) continue
        const next = flagsAfterAction({
          inInbox: row.in_inbox === 1,
          inSent: row.in_sent === 1,
          inDrafts: row.in_drafts === 1,
          inArchive: row.in_archive === 1,
          inSpam: row.in_spam === 1,
          inTrash: row.in_trash === 1,
        }, action)
        update.run(
          Number(next.inInbox), Number(next.inSent), Number(next.inDrafts),
          Number(next.inArchive), Number(next.inSpam), Number(next.inTrash),
          accountId, id,
        )
        this.#acceptedActions.set(`${accountId}\0${id}`, action)
        this.#db.prepare('INSERT OR REPLACE INTO gmail_action_overlay VALUES (?,?)').run(`${accountId}\0${id}`, action)
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  markDraftsSent(accountId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return
    const update = this.#db.prepare('UPDATE gmail_messages SET in_drafts=0, in_sent=1 WHERE account_id = ? AND id = ?')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of messageIds) update.run(accountId, id)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  discardDraftMessages(accountId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return
    const clear = this.#db.prepare('UPDATE gmail_messages SET in_drafts=0 WHERE account_id = ? AND id = ?')
    const remove = this.#db.prepare(`
      DELETE FROM gmail_messages WHERE account_id = ? AND id = ?
        AND in_inbox=0 AND in_sent=0 AND in_spam=0 AND in_trash=0 AND in_archive=0
    `)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of messageIds) {
        clear.run(accountId, id)
        remove.run(accountId, id)
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  removeMessages(accountId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return
    const remove = this.#db.prepare('DELETE FROM gmail_messages WHERE account_id = ? AND id = ?')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of messageIds) remove.run(accountId, id)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  recipients(query: string, accountId?: string): readonly MailAddress[] {
    const needle = query.trim().toLowerCase()
    const seen = new Map<string, MailAddress>()
    for (const message of this.messages(accountId)) {
      const address = message.sender.address.toLowerCase()
      if (seen.has(address)) continue
      if (needle && !message.sender.name.toLowerCase().includes(needle) && !address.includes(needle)) continue
      seen.set(address, message.sender)
    }
    return [...seen.values()].slice(0, 20)
  }

  conversations(state: MailStateFilter, accountId?: string): readonly ConversationSummary[] {
    return groupConversations(this.messages(accountId).filter((message) => queueEligible(message, state)), state)
  }

  searchConversations(query: string, state: MailStateFilter, accountId?: string): readonly ConversationSummary[] {
    return groupConversations(filterSearch(this.messages(accountId), query).filter((message) => queueEligible(message, state)), state)
  }

  mailboxConversations(mailbox: GmailMailbox, state: MailStateFilter, accountId?: string): readonly ConversationSummary[] {
    if (mailbox === 'inbox') return this.conversations(state, accountId)
    return groupConversations(this.messages(accountId).filter((message) => folderMember(message, mailbox)), state)
  }

  searchMailboxConversations(mailbox: GmailMailbox, query: string, state: MailStateFilter, accountId?: string): readonly ConversationSummary[] {
    if (mailbox === 'inbox') return this.searchConversations(query, state, accountId)
    return groupConversations(
      filterSearch(this.messages(accountId), query).filter((message) => folderMember(message, mailbox)),
      state,
    )
  }

  mailboxCounts(accountId?: string): MailboxCounts {
    const inbox = new Set<string>()
    const drafts = new Set<string>()
    const spam = new Set<string>()
    for (const message of this.messages(accountId)) {
      const key = `${message.accountId}:${message.threadId}`
      if (message.inInbox && message.unread) inbox.add(key)
      if (message.inDrafts) drafts.add(key)
      if (message.inSpam) spam.add(key)
    }
    return { inbox: inbox.size, drafts: drafts.size, spam: spam.size }
  }

  count(): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS count FROM gmail_messages').get() as { count: number | bigint }).count)
  }

  beginSync(startedAt: string): void {
    this.#db.prepare("UPDATE gmail_sync_state SET state='syncing', started_at=?, error=NULL WHERE singleton=1").run(startedAt)
  }

  completeSync(completedAt: string, complete = true): void {
    this.#db.prepare("UPDATE gmail_sync_state SET state=?, completed_at=?, error=NULL WHERE singleton=1").run(complete ? 'ready' : 'partial', completedAt)
  }

  failSync(error: string): void {
    this.#db.prepare("UPDATE gmail_sync_state SET state='failed', error=? WHERE singleton=1").run(error)
  }

  status(): GmailSyncStatus {
    const row = this.#db.prepare('SELECT state, started_at, completed_at, error FROM gmail_sync_state WHERE singleton=1').get() as {
      state: GmailSyncStatus['state']; started_at: string | null; completed_at: string | null; error: string | null
    }
    return { state: row.state, startedAt: row.started_at, completedAt: row.completed_at, error: row.error, messageCount: this.count() }
  }

  close(): void {
    this.#db.close()
  }
}
