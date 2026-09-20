import type { GmailConversationAction, GmailMailbox } from './contracts.js'

export interface SelectionState {
  readonly ids: readonly string[]
  readonly anchor?: string
}

export interface ClickModifiers {
  readonly shift?: boolean
  readonly toggle?: boolean
}

export const EMPTY_SELECTION: SelectionState = { ids: [] }

export const CONVERSATION_DRAG_TYPE = 'text/x-dispatch-conversations'

export function selectionAfterClick(state: SelectionState, order: readonly string[], id: string, modifiers: ClickModifiers = {}): SelectionState {
  if (!order.includes(id)) return state
  if (modifiers.shift) {
    const anchor = state.anchor && order.includes(state.anchor) ? state.anchor : id
    const from = order.indexOf(anchor)
    const to = order.indexOf(id)
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
    return { ids: modifiers.toggle ? union(state.ids, range) : range, anchor }
  }
  if (modifiers.toggle) {
    const ids = state.ids.includes(id) ? state.ids.filter((item) => item !== id) : [...state.ids, id]
    return { ids: order.filter((item) => ids.includes(item)), anchor: ids.includes(id) ? id : state.anchor }
  }
  return { ids: [id], anchor: id }
}

export function selectionAfterArrow(state: SelectionState, order: readonly string[], direction: 1 | -1, extend: boolean): SelectionState {
  if (order.length === 0) return state
  const focus = state.ids.length ? (direction === 1 ? state.ids[state.ids.length - 1] : state.ids[0]) : undefined
  const current = focus !== undefined ? order.indexOf(focus) : -1
  const next = Math.min(order.length - 1, Math.max(0, current + direction))
  const id = order[next]!
  if (!extend) return { ids: [id], anchor: id }
  return selectionAfterClick(state, order, id, { shift: true })
}

export function pruneSelection(state: SelectionState, order: readonly string[]): SelectionState {
  const ids = order.filter((id) => state.ids.includes(id))
  return { ids, anchor: state.anchor && order.includes(state.anchor) ? state.anchor : ids[0] }
}

export function encodeDragPayload(ids: readonly string[]): string {
  return JSON.stringify(ids)
}

export function decodeDragPayload(text: string | null | undefined): string[] {
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function dropActionForMailbox(target: GmailMailbox, current: GmailMailbox): GmailConversationAction | undefined {
  if (target === current) return undefined
  switch (target) {
    case 'inbox': return current === 'sent' ? undefined : 'inbox'
    case 'archive': return current === 'inbox' ? 'archive' : undefined
    case 'spam': return current === 'sent' || current === 'drafts' ? undefined : 'spam'
    case 'trash': return current === 'drafts' ? undefined : 'trash'
    default: return undefined
  }
}

function union(left: readonly string[], right: readonly string[]): string[] {
  const seen = new Set(left)
  return [...left, ...right.filter((id) => !seen.has(id))]
}

export function moveLabel(action: GmailConversationAction, count: number): string {
  const noun = count === 1 ? '1 conversation' : `${count} conversations`
  if (action === 'archive') return `Archived ${noun}`
  if (action === 'spam') return `Marked ${noun} as spam`
  if (action === 'trash') return `Moved ${noun} to Trash`
  return `Moved ${noun} to Inbox`
}

/** Actions that put a thread back where it came from, in the order the mail service must apply them. */
export function undoActionsFor(action: GmailConversationAction, from: GmailMailbox): GmailConversationAction[] {
  if (action === 'inbox') return from === 'archive' || from === 'spam' || from === 'trash' ? [from] : []
  if (from === 'inbox') return ['inbox']
  if (from === 'archive') return ['inbox', 'archive']
  if (from === 'spam') return ['inbox', 'spam']
  if (from === 'trash') return ['inbox', 'trash']
  return []
}
