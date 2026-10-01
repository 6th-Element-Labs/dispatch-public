import { describe, expect, it } from 'vitest'
import { canOpenMessageWindow, messageWindowQuery, parseMessageWindow, readMovedInMessageWindow } from './message-window.js'

describe('message window address', () => {
  it('round-trips a target through the query string', () => {
    const target = { conversationId: 'gmail:a&b:t=1', threadId: 't#1', accountId: 'acct one', mailbox: 'archive' as const }
    expect(parseMessageWindow(`?${messageWindowQuery(target)}`)).toEqual(target)
    expect(parseMessageWindow(`?${messageWindowQuery({ conversationId: 'demo:t1', threadId: 't1', mailbox: 'inbox' })}`)).toEqual({ conversationId: 'demo:t1', threadId: 't1', mailbox: 'inbox' })
  })

  it('round-trips a local draft window and rejects incomplete draft targets', () => {
    const target = { conversationId: 'draft:local-one', threadId: 'local-one', accountId: 'one', mailbox: 'drafts' as const, draftKey: 'local-one' }
    expect(parseMessageWindow(`?${messageWindowQuery(target)}`)).toEqual(target)
    expect(() => parseMessageWindow('?window=draft&conversation=d&thread=d&mailbox=drafts')).toThrow('does not name a draft')
  })

  it('is the main window without window=message', () => {
    expect(parseMessageWindow('')).toBeUndefined()
    expect(parseMessageWindow('?conversation=c1&thread=t1&mailbox=inbox')).toBeUndefined()
  })

  it('rejects an incomplete message window address instead of guessing', () => {
    expect(() => parseMessageWindow('?window=message&thread=t1&mailbox=inbox')).toThrow('does not name a conversation')
    expect(() => parseMessageWindow('?window=message&conversation=c1&mailbox=inbox')).toThrow('does not name a conversation')
    expect(() => parseMessageWindow('?window=message&conversation=c1&thread=t1&mailbox=unknown')).toThrow('unknown mailbox: unknown')
    expect(() => parseMessageWindow('?window=message&conversation=c1&thread=t1')).toThrow('unknown mailbox: none')
  })

  it('opens drafts and messages in their own windows', () => {
    expect(canOpenMessageWindow('drafts')).toBe(true)
    for (const mailbox of ['inbox', 'sent', 'archive', 'spam', 'trash'] as const) expect(canOpenMessageWindow(mailbox)).toBe(true)
  })
})

describe('moves reported by a message window', () => {
  const summary = { id: 'c1', threadId: 't1', accountId: 'a1', latestMessageId: 'm1', sender: { name: 'Ana', address: 'ana@example.com', initials: 'A' }, subject: 'Hi', receivedAt: '', receivedLabel: '', receivedFullLabel: '', preview: '', unread: false, messageCount: 1 }
  it('accepts a well-formed move', () => {
    expect(readMovedInMessageWindow({ type: 'moved', action: 'archive', mailbox: 'inbox', summary })).toEqual({ type: 'moved', action: 'archive', mailbox: 'inbox', summary })
  })
  it('ignores anything else on the channel', () => {
    for (const data of [null, 'moved', { type: 'moved', action: 'delete', mailbox: 'inbox', summary }, { type: 'moved', action: 'archive', mailbox: 'drafts', summary }, { type: 'moved', action: 'archive', mailbox: 'inbox', summary: { ...summary, accountId: undefined } }]) {
      expect(readMovedInMessageWindow(data)).toBeUndefined()
    }
  })
})
