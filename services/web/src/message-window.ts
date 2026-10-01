import type { ConversationSummary, GmailConversationAction, GmailMailbox } from './contracts.js'

/**
 * One conversation opened in its own window. The main window passes where the
 * conversation was listed, so the message window reads the same projection.
 * A draft target transfers the local editor checkpoint into the same native window surface.
 */
export interface MessageWindowTarget {
  readonly conversationId: string
  readonly threadId: string
  readonly accountId?: string
  readonly mailbox: GmailMailbox
  readonly draftKey?: string
}

const MAILBOXES: readonly MessageWindowTarget['mailbox'][] = ['inbox', 'sent', 'archive', 'spam', 'trash', 'drafts']
const ACTIONS: readonly GmailConversationAction[] = ['archive', 'spam', 'trash', 'inbox']

export function canOpenMessageWindow(mailbox: GmailMailbox): mailbox is MessageWindowTarget['mailbox'] {
  return (MAILBOXES as readonly GmailMailbox[]).includes(mailbox)
}

export function messageWindowQuery(target: MessageWindowTarget): string {
  const query = new URLSearchParams({ window: target.draftKey ? 'draft' : 'message', conversation: target.conversationId, thread: target.threadId, mailbox: target.mailbox })
  if (target.draftKey) query.set('draftKey', target.draftKey)
  if (target.accountId) query.set('account', target.accountId)
  return query.toString()
}

/** The target of a message window; undefined for the main window. An incomplete address throws. */
export function parseMessageWindow(search: string): MessageWindowTarget | undefined {
  const query = new URLSearchParams(search)
  if (!['message', 'draft'].includes(query.get('window') ?? '')) return undefined
  const conversationId = query.get('conversation') ?? ''
  const threadId = query.get('thread') ?? ''
  const mailbox = query.get('mailbox') ?? ''
  if (!conversationId || !threadId) throw new Error('This message window does not name a conversation.')
  if (!canOpenMessageWindow(mailbox as GmailMailbox)) throw new Error(`This message window names an unknown mailbox: ${mailbox || 'none'}.`)
  const accountId = query.get('account') ?? ''
  const draftKey = query.get('draftKey') ?? ''
  if (query.get('window') === 'draft' && (!draftKey || mailbox !== 'drafts')) throw new Error('This draft window does not name a draft.')
  return { conversationId, threadId, mailbox: mailbox as MessageWindowTarget['mailbox'], ...(accountId ? { accountId } : {}), ...(query.get('window') === 'draft' ? { draftKey } : {}) }
}

/** Message windows tell the main window about moves they made, so it can offer Undo after they close. */
export const MESSAGE_WINDOW_CHANNEL = 'dispatch.message-windows'

export interface MovedInMessageWindow {
  readonly type: 'moved'
  readonly action: GmailConversationAction
  readonly mailbox: GmailMailbox
  readonly summary: ConversationSummary
}

export function readMovedInMessageWindow(data: unknown): MovedInMessageWindow | undefined {
  if (!data || typeof data !== 'object') return undefined
  const value = data as Partial<MovedInMessageWindow>
  if (value.type !== 'moved' || !ACTIONS.includes(value.action!) || value.mailbox === 'drafts' || !canOpenMessageWindow(value.mailbox!)) return undefined
  const summary = value.summary
  if (!summary || typeof summary.id !== 'string' || typeof summary.threadId !== 'string' || typeof summary.accountId !== 'string') return undefined
  return { type: 'moved', action: value.action!, mailbox: value.mailbox!, summary }
}
