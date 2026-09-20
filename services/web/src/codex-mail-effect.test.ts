import { describe, expect, it } from 'vitest'
import { codexMailEffect, visibleUserPrompt } from './codex-mail-effect.js'

describe('codexMailEffect', () => {
  it('opens a Gmail draft that Codex created through MCP', () => {
    expect(codexMailEffect({
      type: 'mcpToolCall',
      status: 'completed',
      tool: 'gmail.create_draft',
      arguments: { link_id: 'link-one', to: 'ana@example.com' },
      result: { structuredContent: { draft_id: 'draft-9' } },
    })).toEqual({ kind: 'draft', draftId: 'draft-9', accountId: 'link-one' })
  })

  it('opens the same draft after Codex adds attachments through update_draft', () => {
    expect(codexMailEffect({
      type: 'mcpToolCall',
      status: 'completed',
      tool: 'gmail.update_draft',
      arguments: { link_id: 'link-two', draft_id: 'draft-9' },
      result: { structuredContent: { draft_id: 'draft-9' } },
    })).toEqual({ kind: 'draft', draftId: 'draft-9', accountId: 'link-two' })
  })

  it('treats a user-asked Gmail send as a sent effect', () => {
    expect(codexMailEffect({
      type: 'mcpToolCall',
      status: 'completed',
      tool: 'gmail.send_draft',
      arguments: { link_id: 'link-one', draft_id: 'draft-9' },
      result: { structuredContent: { id: 'sent-1' } },
    })).toEqual({ kind: 'sent', accountId: 'link-one', draftId: 'draft-9', messageId: 'sent-1' })
  })

  it('ignores failed tool calls and non-Gmail tools', () => {
    expect(codexMailEffect({ type: 'mcpToolCall', status: 'failed', tool: 'gmail.create_draft', arguments: { link_id: 'link-one' }, result: { structuredContent: { draft_id: 'draft-9' } } })).toBeUndefined()
    expect(codexMailEffect({ type: 'mcpToolCall', status: 'completed', tool: 'github.search', arguments: {}, result: {} })).toBeUndefined()
  })
})

describe('visibleUserPrompt', () => {
  it('strips the Dispatch mail-context suffix from a restored user turn', () => {
    expect(visibleUserPrompt('Reply for me.\n\nSelected Gmail account link-one, thread t1.')).toBe('Reply for me.')
    expect(visibleUserPrompt('Hello\n\nSelected email context supplied by Dispatch UI: {"threadId":"t1"}')).toBe('Hello')
  })
})


it('reads the actual Gmail id response and JSON text blocks', () => {
  const call = { type: 'mcpToolCall', status: 'completed', tool: 'gmail.create_draft', arguments: { link_id: 'account-A' } }
  expect(codexMailEffect({ ...call, result: { structuredContent: { id: 'draft-A', message: { id: 'message-A' } } } }))
    .toEqual({ kind: 'draft', accountId: 'account-A', draftId: 'draft-A' })
  expect(codexMailEffect({ ...call, arguments: JSON.stringify(call.arguments), result: { content: [{ type: 'text', text: JSON.stringify({ id: 'draft-A' }) }] } }))
    .toEqual({ kind: 'draft', accountId: 'account-A', draftId: 'draft-A' })
})

it('does not claim success for connector errors, missing results, or arguments alone', () => {
  const call = { type: 'mcpToolCall', status: 'completed', tool: 'gmail.send_draft', arguments: { link_id: 'account-A', draft_id: 'draft-A' } }
  for (const result of [undefined, {}, { isError: true, structuredContent: { id: 'x' } }, { structuredContent: { error: 'Failed', id: 'x' } }]) {
    expect(codexMailEffect({ ...call, result })).toBeUndefined()
  }
  expect(codexMailEffect({ ...call, error: { message: 'Denied' }, result: { structuredContent: { id: 'x' } } })).toBeUndefined()
})

it('opens and reconciles drafts changed through Dispatch software controls', () => {
  expect(codexMailEffect({ type: 'mcpToolCall', status: 'completed', server: 'dispatch_mail', tool: 'update_draft', result: { structuredContent: { draft: { id: 'draft-A', accountId: 'account-A' } } } }))
    .toEqual({ kind: 'draft', draftId: 'draft-A', accountId: 'account-A' })
  expect(codexMailEffect({ type: 'mcpToolCall', status: 'completed', server: 'dispatch_mail', tool: 'send_draft', result: { structuredContent: { id: 'sent-A', draftId: 'draft-A', accountId: 'account-A' } } }))
    .toEqual({ kind: 'sent', draftId: 'draft-A', accountId: 'account-A', messageId: 'sent-A' })
  expect(codexMailEffect({ type: 'mcpToolCall', status: 'completed', server: 'dispatch_mail', tool: 'send_draft', result: { isError: true, structuredContent: { id: 'sent-A', draftId: 'draft-A', accountId: 'account-A' } } })).toBeUndefined()
})

it('publishes the mail service search projection only from a successful Dispatch tool', () => {
  const searchResults = { query: 'delivery', requestId: 'search-A', results: [] }
  const item = { type: 'mcpToolCall', status: 'completed', server: 'dispatch_mail', tool: 'show_search_results', result: { structuredContent: { searchResults } } }
  expect(codexMailEffect(item)).toEqual({ kind: 'search', search: searchResults })
  expect(codexMailEffect({ ...item, result: { ...item.result, isError: true } })).toBeUndefined()
})

it('keeps restored search prompts free of internal search instructions', () => {
  expect(visibleUserPrompt('Find the delivery agreement\n\nSelected Gmail search context: requestId internal-1; verify quotes')).toBe('Find the delivery agreement')
})
