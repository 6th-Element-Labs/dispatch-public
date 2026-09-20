import { expect, it } from 'vitest'
import { completedGmailSend } from './send-receipt-observer.js'
const item = { type: 'mcpToolCall', tool: 'gmail.send_draft', status: 'completed', arguments: { link_id: 'one', draft_id: 'draft' }, result: { structuredContent: { id: 'sent' } } }
it('records completed Gmail sends from structured results and JSON text', () => {
  expect(completedGmailSend({ method: 'item/completed', params: { item } })).toEqual({ accountId: 'one', draftId: 'draft', messageId: 'sent' })
  expect(completedGmailSend({ method: 'item/completed', params: { item: { ...item, tool: 'gmail.send_email', arguments: JSON.stringify({ link_id: 'two' }), result: { content: [{ type: 'text', text: '{"id":"sent2"}' }] } } } })).toEqual({ accountId: 'two', messageId: 'sent2' })
})
it('never invents a send receipt from arguments, errors, incomplete calls, or other tools', () => {
  for (const change of [{ status: 'failed' }, { tool: 'gmail.create_draft' }, { error: {} }, { result: {} }, { result: { isError: true, structuredContent: { id: 'sent' } } }]) expect(completedGmailSend({ method: 'item/completed', params: { item: { ...item, ...change } } })).toBeUndefined()
  expect(completedGmailSend({ method: 'item/started', params: { item } })).toBeUndefined()
})
