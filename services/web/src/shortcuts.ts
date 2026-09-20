import type { GmailMailbox } from './contracts.js'

export type ShortcutCommand =
  | 'reply' | 'replyAll' | 'forward' | 'archive' | 'spam' | 'trash' | 'toggleRead'
  | 'next' | 'previous' | 'compose' | 'help' | 'ask'
  | { readonly goto: GmailMailbox }

export interface ShortcutKey {
  readonly key: string
  readonly shift?: boolean
  readonly meta?: boolean
}

/** Keys shown in the cheat sheet and the toolbar tips, grouped for display. */
export const SHORTCUT_GROUPS: ReadonlyArray<{ readonly title: string; readonly items: ReadonlyArray<{ readonly label: string; readonly keys: string }> }> = [
  { title: 'Message', items: [
    { label: 'Reply', keys: 'R' }, { label: 'Reply all', keys: 'A' }, { label: 'Forward', keys: 'F' },
    { label: 'Archive', keys: 'E' }, { label: 'Mark as spam', keys: '!' }, { label: 'Move to Trash', keys: '⌫ or #' },
    { label: 'Mark read or unread', keys: 'U' }, { label: 'Undo last move', keys: '⌘Z' }, { label: 'Ask Codex', keys: '⌘⏎' },
  ] },
  { title: 'Navigate', items: [
    { label: 'Next / previous conversation', keys: 'J / K' }, { label: 'Extend selection', keys: '⇧↑ / ⇧↓' },
    { label: 'Compose', keys: 'C' }, { label: 'Search', keys: '⌘K' },
    { label: 'Go to Inbox, Sent, Drafts, Archive, Trash', keys: 'G then I / S / D / A / T' }, { label: 'This sheet', keys: '?' },
  ] },
]

export const TOOLBAR_KEYS: Readonly<Record<string, string>> = {
  reply: 'R', replyAll: 'A', forward: 'F', archive: 'E', spam: '!', trash: '#', readState: 'U', ask: '⌘⏎',
}

const GOTO: Readonly<Record<string, GmailMailbox>> = { i: 'inbox', s: 'sent', d: 'drafts', a: 'archive', t: 'trash' }

/**
 * Maps a key press to a command. `pendingGo` is true when the previous key
 * was G within the chord window. Returns `{ command }` or `{ pendingGo: true }`
 * when the press starts a G chord, or undefined when the key means nothing.
 */
export function resolveShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, pendingGo: boolean): { command: ShortcutCommand } | { pendingGo: true } | undefined {
  const modifier = event.metaKey || event.ctrlKey
  if (event.altKey) return undefined
  if (modifier) {
    if (event.key === 'Enter' && !event.shiftKey) return { command: 'ask' }
    return undefined
  }
  const key = event.key
  if (pendingGo) {
    const mailbox = GOTO[key.toLowerCase()]
    return mailbox ? { command: { goto: mailbox } } : undefined
  }
  switch (key) {
    case 'r': case 'R': return { command: 'reply' }
    case 'a': case 'A': return { command: 'replyAll' }
    case 'f': case 'F': return { command: 'forward' }
    case 'e': case 'E': return { command: 'archive' }
    case '!': return { command: 'spam' }
    case '#': return { command: 'trash' }
    case 'u': case 'U': return { command: 'toggleRead' }
    case 'j': case 'J': return { command: 'next' }
    case 'k': case 'K': return { command: 'previous' }
    case 'c': case 'C': return { command: 'compose' }
    case '?': return { command: 'help' }
    case 'g': case 'G': return { pendingGo: true }
    default: return undefined
  }
}
