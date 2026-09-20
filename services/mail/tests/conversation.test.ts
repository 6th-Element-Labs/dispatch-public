import { describe, expect, it } from 'vitest'
import { groupConversations, projectConversation, replySourceMessage, conversationForMailbox } from '../src/conversation.js'
import type { MessageProjection, MessageSummary } from '../src/model.js'

const base: MessageSummary = {
  id: 'm1', threadId: 't1', sender: { name: 'Ana', address: 'ana@example.com', initials: 'A' }, subject: 'Hello',
  receivedAt: '2026-09-04T08:00:00Z', receivedLabel: 'Sep 4, 8:00 AM', receivedFullLabel: 'September 4, 2026 at 8:00 AM',
  preview: 'Hello', unread: false, accountId: 'work', accountLabel: 'work@example.com',
}

describe('conversation projection', () => {
  it('groups by account and Gmail thread, keeping the newest message', () => {
    const conversations = groupConversations([
      base,
      { ...base, id: 'm2', receivedAt: '2026-09-04T09:00:00Z', receivedLabel: 'Sep 4, 9:00 AM', receivedFullLabel: 'September 4, 2026 at 9:00 AM', unread: true },
      { ...base, id: 'm3', accountId: 'personal' },
    ], 'all')
    expect(conversations).toHaveLength(2)
    expect(conversations[0]).toMatchObject({ latestMessageId: 'm2', messageCount: 2, unread: true })
  })

  it('filters read and unread conversations', () => {
    expect(groupConversations([base, { ...base, id: 'm2', threadId: 't2', unread: true }], 'read')).toHaveLength(1)
    expect(groupConversations([base, { ...base, id: 'm2', threadId: 't2', unread: true }], 'unread')).toHaveLength(1)
  })

  it('renders full conversation messages newest first', () => {
    const message = { ...base, body: { kind: 'plain-text' as const, content: 'Hello' }, attachments: [], source: 'gmail' as const }
    const conversation = projectConversation([message, { ...message, id: 'm2', receivedAt: '2026-09-04T09:00:00Z' } satisfies MessageProjection], 'gmail')
    expect(conversation.messages.map((item) => item.id)).toEqual(['m2', 'm1'])
  })

  it('selects the newest message as the reply source on a newest-first thread', () => {
    const older = {
      ...base,
      id: 'old',
      receivedAt: '2026-09-04T08:00:00Z',
      sender: { name: 'Old', address: 'old@example.com', initials: 'O' },
      to: [{ name: 'Old To', address: 'old-to@example.com', initials: 'T' }],
      body: { kind: 'plain-text' as const, content: 'Older' },
      attachments: [],
      source: 'gmail' as const,
    }
    const newer = {
      ...older,
      id: 'new',
      receivedAt: '2026-09-04T10:00:00Z',
      sender: { name: 'New', address: 'new@example.com', initials: 'N' },
      to: [{ name: 'New To', address: 'new-to@example.com', initials: 'T' }],
    }
    const conversation = projectConversation([older, newer], 'gmail')
    expect(conversation.messages.map((item) => item.id)).toEqual(['new', 'old'])
    expect(replySourceMessage(conversation)).toMatchObject({ id: 'new', sender: { address: 'new@example.com' } })
    expect(conversation.latestMessageId).toBe('new')
  })
})

it('keeps the attachment indicator when only an earlier email has a file', () => {
  const [summary] = groupConversations([
    { ...base, hasAttachment: true },
    { ...base, id: 'new', receivedAt: '2026-09-05T08:00:00Z', hasAttachment: false },
  ], 'all')
  expect(summary).toMatchObject({ latestMessageId: 'new', hasAttachment: true })
  expect(groupConversations([base], 'all')[0]?.hasAttachment).toBe(false)
})

it('keeps discarded and unsent drafts out of the inbox reply source while retaining explicit folder views', () => {
  const message = { ...base, labels: ['INBOX'], body: { kind: 'plain-text' as const, content: 'New received text' }, attachments: [], source: 'gmail' as const }
  const raw = projectConversation([message, { ...message, id: 'draft', subject: 'Unsent draft', labels: ['DRAFT'], receivedAt: '2026-09-04T10:00:00Z' }, { ...message, id: 'discarded', subject: 'Discarded draft', labels: ['TRASH'], receivedAt: '2026-09-04T11:00:00Z' }, { ...message, id: 'spam', labels: ['SPAM'], receivedAt: '2026-09-04T12:00:00Z' }], 'gmail')
  expect(conversationForMailbox(raw, 'inbox')).toMatchObject({ subject: 'Hello', latestMessageId: 'm1', messageCount: 1 })
  expect(conversationForMailbox(raw, 'drafts').latestMessageId).toBe('draft')
  expect(conversationForMailbox(raw, 'trash').latestMessageId).toBe('discarded')
  expect(conversationForMailbox(raw, 'spam').latestMessageId).toBe('spam')
  expect(() => conversationForMailbox(projectConversation([{ ...message, labels: ['TRASH'] }], 'gmail'), 'inbox')).toThrow('No messages')
})
