import { describe, expect, it } from 'vitest'
import { threadContextMenuItems, type ContextMenuItem } from './thread-context-menu.js'

function commands(items: readonly ContextMenuItem[]): Array<{ id: string; label: string; enabled: boolean }> {
  return items.flatMap((item) => (item.kind === 'command' ? [{ id: item.id, label: item.label, enabled: item.enabled }] : []))
}

function ids(items: readonly ContextMenuItem[]): string[] {
  return commands(items).map((item) => item.id)
}

describe('threadContextMenuItems', () => {
  it('lists Inbox actions for an unread Gmail conversation', () => {
    const items = threadContextMenuItems({ mailbox: 'inbox', unread: true, hasAccountId: true })
    expect(ids(items)).toEqual(['reply', 'replyAll', 'forward', 'markRead', 'archive', 'spam', 'trash', 'ask'])
    expect(commands(items).every((item) => item.enabled)).toBe(true)
    expect(items.find((item) => item.kind === 'command' && item.id === 'markRead')).toMatchObject({
      label: 'Mark as Read',
    })
  })

  it('offers Mark as Unread for a read Gmail conversation', () => {
    const items = threadContextMenuItems({ mailbox: 'inbox', unread: false, hasAccountId: true })
    expect(ids(items)).toContain('markUnread')
    expect(ids(items)).not.toContain('markRead')
    expect(items.find((item) => item.kind === 'command' && item.id === 'markUnread')).toMatchObject({
      label: 'Mark as Unread',
    })
  })

  it('hides Archive and shows Move to Inbox in Archive', () => {
    expect(ids(threadContextMenuItems({ mailbox: 'archive', unread: false, hasAccountId: true }))).toEqual([
      'reply', 'replyAll', 'forward', 'markUnread', 'inbox', 'spam', 'trash', 'ask',
    ])
  })

  it('hides Spam and Trash folder actions in those mailboxes', () => {
    expect(ids(threadContextMenuItems({ mailbox: 'spam', unread: true, hasAccountId: true }))).toEqual([
      'reply', 'replyAll', 'forward', 'markRead', 'inbox', 'trash', 'ask',
    ])
    expect(ids(threadContextMenuItems({ mailbox: 'trash', unread: true, hasAccountId: true }))).toEqual([
      'reply', 'replyAll', 'forward', 'markRead', 'inbox', 'ask',
    ])
  })

  it('disables Gmail writes on demo rows and keeps Reply and Ask', () => {
    const items = commands(threadContextMenuItems({ mailbox: 'inbox', unread: true, hasAccountId: false }))
    const byId = Object.fromEntries(items.map((item) => [item.id, item.enabled]))
    expect(byId).toMatchObject({
      reply: true,
      replyAll: true,
      forward: false,
      markRead: false,
      archive: false,
      spam: false,
      trash: false,
      ask: true,
    })
  })

  it('offers only folder actions for a multi-selection', () => {
    expect(ids(threadContextMenuItems({ mailbox: 'inbox', unread: false, hasAccountId: true, count: 3 }))).toEqual(['archive', 'spam', 'trash'])
    expect(ids(threadContextMenuItems({ mailbox: 'trash', unread: false, hasAccountId: true, count: 2 }))).toEqual(['inbox'])
    expect(commands(threadContextMenuItems({ mailbox: 'inbox', unread: false, hasAccountId: false, count: 2 })).every((item) => !item.enabled)).toBe(true)
  })
})
