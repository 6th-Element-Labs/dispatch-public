import DOMPurify from 'isomorphic-dompurify'
import { summarizeConversation } from './conversation.js'
import type { ConversationSummary, MessageProjection } from './model.js'

export interface SearchMatch { accountId: string; messageId: string; quote: string; reason: string }
export interface SearchHit { messageId: string; quote: string; excerpt: string; matchStart: number; matchEnd: number; reason: string }
export interface SearchResult { conversation: ConversationSummary; hits: SearchHit[] }
export interface SearchResults { query: string; requestId?: string; results: SearchResult[] }
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

export function searchableMessageText(message: MessageProjection): string {
  if (message.body.kind === 'plain-text') return normalize(message.body.content)
  const dom = DOMPurify.sanitize(message.body.content, { RETURN_DOM: true }) as HTMLElement
  dom.querySelectorAll('p,div,br,li,tr,td,th,h1,h2,h3,blockquote').forEach(node => node.append(dom.ownerDocument.createTextNode(' ')))
  return normalize(dom.textContent ?? '')
}

/** Codex selects relevance; mail verifies identities and verbatim source evidence. */
export async function projectSearchResults(query: string, matches: readonly SearchMatch[], read: (accountId: string, messageId: string) => Promise<MessageProjection>, requestId?: string): Promise<SearchResults> {
  const groups = new Map<string, SearchResult>()
  const messages = new Map<string, MessageProjection>()
  // Bound source reads without changing the model's relevance order.
  const sources = [...new Map(matches.map(match => [`${match.accountId}:${match.messageId}`, match])).values()]
  for (let offset = 0; offset < sources.length; offset += 4) {
    await Promise.all(sources.slice(offset, offset + 4).map(async match => {
      const key = `${match.accountId}:${match.messageId}`
      if (!messages.has(key)) messages.set(key, await read(match.accountId, match.messageId))
    }))
  }
  for (const match of matches) {
    const message = messages.get(`${match.accountId}:${match.messageId}`)!
    if (message.id !== match.messageId || message.accountId !== match.accountId) throw new Error(`Search source identity mismatch: ${match.messageId}`)
    const text = searchableMessageText(message)
    const quote = normalize(match.quote)
    const start = text.indexOf(quote)
    if (!quote || start < 0) throw new Error(`Search quote not found in message ${match.messageId}. Read the message and supply a verbatim passage.`)
    const from = Math.max(0, start - 35)
    const to = Math.min(text.length, start + quote.length + 100)
    const prefix = from ? '…' : ''
    const excerpt = prefix + text.slice(from, to) + (to < text.length ? '…' : '')
    const conversation = { ...summarizeConversation([message]), hasAttachment: message.attachments.length > 0 }
    const group = groups.get(conversation.id) ?? { conversation, hits: [] }
    if (conversation.hasAttachment) group.conversation = { ...group.conversation, hasAttachment: true }
    if (!group.hits.some(hit => hit.messageId === message.id && hit.quote === quote)) group.hits.push({ messageId: message.id, quote, excerpt, matchStart: start - from + prefix.length, matchEnd: start - from + prefix.length + quote.length, reason: match.reason })
    groups.set(conversation.id, group)
  }
  return { query, requestId, results: [...groups.values()] }
}
