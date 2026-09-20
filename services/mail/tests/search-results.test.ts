import { expect, it } from 'vitest'
import { projectSearchResults } from '../src/search-results.js'
import type { MessageProjection } from '../src/model.js'
const base: MessageProjection = { id: 'old', accountId: 'account-A', accountLabel: 'a@example.com', threadId: 'thread-one', source: 'gmail', sender: { name: 'Customer', address: 'customer@example.com', initials: 'C' }, subject: 'Delivery', receivedAt: '2026-09-04T10:00:00Z', receivedLabel: 'Sep 4', receivedFullLabel: 'September 4', unread: false, preview: '', body: { kind: 'sanitized-html', content: '<p>We agreed to <strong>September delivery</strong> &amp; support.</p><script>bad()</script>' }, attachments: [] }
it('grounds a quote across markup and HTML entities, preserving account/thread identity', async () => {
  const result = await projectSearchResults('When did we agree?', [{ accountId: 'account-A', messageId: 'old', quote: 'September delivery & support.', reason: 'Delivery commitment' }], async () => base, 'request-A')
  const hit = result.results[0]!.hits[0]!
  expect(result.requestId).toBe('request-A')
  expect(result.results[0]!.conversation.id).toBe('account-A:thread-one')
  expect(hit.excerpt.slice(hit.matchStart, hit.matchEnd)).toBe('September delivery & support.')
  expect(hit.excerpt).not.toContain('bad()')
})
it('rejects fabricated quotes and mismatched source accounts', async () => {
  const match = { accountId: 'account-A', messageId: 'old', quote: 'October delivery', reason: '' }
  await expect(projectSearchResults('date', [match], async () => base)).rejects.toThrow('quote not found')
  await expect(projectSearchResults('date', [{ ...match, accountId: 'account-B' }], async () => base)).rejects.toThrow('identity mismatch')
})
it('groups multiple matches but keeps same-ID threads on different accounts separate', async () => {
  const matches = ['account-A', 'account-A', 'account-B'].map(accountId => ({ accountId, messageId: 'old', quote: 'September delivery', reason: '' }))
  const result = await projectSearchResults('date', matches, async accountId => ({ ...base, accountId }))
  expect(result.results).toHaveLength(2)
  expect(result.results[0]!.hits).toHaveLength(1)
})
it('returns an honest empty result without reading mail', async () => {
  expect(await projectSearchResults('nothing', [], async () => { throw new Error('must not read') })).toEqual({ query: 'nothing', requestId: undefined, results: [] })
})
