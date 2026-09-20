import type { RpcMessage } from './json-line-rpc.js'
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
export function completedGmailSend(message: RpcMessage): { accountId: string; messageId: string; draftId?: string } | undefined {
  if (message.method !== 'item/completed') return undefined
  const item = object(object(message.params)?.item)
  if (!item || item.type !== 'mcpToolCall' || item.status !== 'completed' || item.error || !/(?:^|[._])gmail[._](send_draft|send_email)$/.test(String(item.tool))) return undefined
  const result = object(item.result)
  if (!result || result.isError || result.error) return undefined
  let args = object(item.arguments)
  if (!args && typeof item.arguments === 'string') { try { args = object(JSON.parse(item.arguments)) } catch { return undefined } }
  let content = object(result.structuredContent)
  if (!content && Array.isArray(result.content)) for (const block of result.content) { try { content = object(JSON.parse(String(object(block)?.text ?? ''))); if (content?.id) break } catch {} }
  if (!content || content.error || typeof content.id !== 'string' || !content.id || typeof args?.link_id !== 'string') return undefined
  return { accountId: args.link_id, messageId: content.id, ...typeof args.draft_id === 'string' ? { draftId: args.draft_id } : {} }
}
