import type { GmailMailbox } from './contracts.js'

export type ThreadContextCommand =
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'markRead'
  | 'markUnread'
  | 'archive'
  | 'inbox'
  | 'spam'
  | 'trash'
  | 'ask'

export type ContextMenuItem =
  | { readonly kind: 'separator' }
  | { readonly kind: 'command'; readonly id: ThreadContextCommand; readonly label: string; readonly enabled: boolean }

export function threadContextMenuItems(input: {
  readonly mailbox: GmailMailbox
  readonly unread: boolean
  readonly hasAccountId: boolean
  readonly count?: number
}): ContextMenuItem[] {
  const writes = input.hasAccountId
  const items: ContextMenuItem[] = (input.count ?? 1) > 1 ? [] : [
    command('reply', 'Reply', true),
    command('replyAll', 'Reply All', true),
    command('forward', 'Forward', writes),
    { kind: 'separator' },
    input.unread
      ? command('markRead', 'Mark as Read', writes)
      : command('markUnread', 'Mark as Unread', writes),
    { kind: 'separator' },
  ]
  if (input.mailbox === 'inbox') items.push(command('archive', 'Archive', writes))
  if (input.mailbox === 'archive' || input.mailbox === 'spam' || input.mailbox === 'trash') {
    items.push(command('inbox', 'Move to Inbox', writes))
  }
  if (input.mailbox !== 'spam' && input.mailbox !== 'trash') items.push(command('spam', 'Mark as Spam', writes))
  if (input.mailbox !== 'trash') items.push(command('trash', 'Move to Trash', writes))
  if ((input.count ?? 1) > 1) return items
  items.push({ kind: 'separator' }, command('ask', 'Ask Codex', true))
  return items
}

function command(id: ThreadContextCommand, label: string, enabled: boolean): ContextMenuItem {
  return { kind: 'command', id, label, enabled }
}
