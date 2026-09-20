import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const identity = { accountId: z.string().min(1), draftId: z.string().min(1) }
const attachment = z.object({ id: z.string().optional(), name: z.string(), mediaType: z.string(), contentBase64: z.string().optional(), sourceMessageId: z.string().optional(), sizeLabel: z.string().optional() })
const fields = { to: z.array(z.string()).optional(), cc: z.array(z.string()).optional(), bcc: z.array(z.string()).optional(), subject: z.string().optional(), bodyMarkdown: z.string().optional(), attachments: z.array(attachment).optional() }
type Draft = { id: string; accountId: string; inReplyToMessageId: string; to: { address: string }[]; cc: string; bcc: string; subject: string; bodyMarkdown: string; attachments: unknown[] }

export function dispatchMailConfig() {
  return { 'mcp_servers.dispatch_mail': { url: `http://127.0.0.1:${process.env.DISPATCH_AGENT_PORT ?? '8412'}/mcp/dispatch-mail`, tool_timeout_sec: 90 } }
}

/** MCP transport adapter over the same mail-service commands used by the editor. */
export function createDispatchMailMcp(mailBase = `http://127.0.0.1:${process.env.DISPATCH_MAIL_PORT ?? '8411'}`) {
  const server = new McpServer({ name: 'dispatch_mail', version: '1.0.0' })
  async function request(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${mailBase}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok || value.error) throw new Error(`Dispatch mail: ${response.status} ${JSON.stringify(value)}`)
    return value
  }
  const draftPath = (accountId: string, draftId: string) => `/v1/drafts/${encodeURIComponent(draftId)}?account=${encodeURIComponent(accountId)}`
  async function read(accountId: string, draftId: string): Promise<Draft> {
    const draft = (await request(draftPath(accountId, draftId))).draft as Draft | undefined
    if (!draft || draft.id !== draftId || draft.accountId !== accountId) throw new Error('Dispatch returned a different draft or account')
    return draft
  }
  async function result(operation: () => Promise<Record<string, unknown>>) {
    try {
      const value = await operation()
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
    }
  }
  const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  server.registerTool('list_accounts', { description: 'List the Gmail accounts connected to Dispatch. Use the exact accountId for draft actions.', inputSchema: {}, annotations: readonly }, () => result(() => request('/v1/accounts')))
  server.registerTool('show_search_results', {
    description: 'Display your email search findings as a selectable list in Dispatch. Search and read messages with Gmail tools first. Supply exact account/message IDs and a short verbatim plain-text body passage supporting each match (omit HTML tags; do not paraphrase); mail verifies the quotes. For unanswered questions, read the thread and assess replies rather than treating unread as unanswered. Keep relevance reasons concise. Use the requestId from the search request when supplied. Pass an empty matches array for no findings.',
    inputSchema: { query: z.string().min(1).max(2000), requestId: z.string().max(100).optional(), matches: z.array(z.object({ accountId: z.string().min(1), messageId: z.string().min(1), quote: z.string().min(1).max(500), reason: z.string().max(500) })).max(30) },
    annotations: readonly,
  }, input => result(() => request('/v1/search-results', 'POST', input)))
  server.registerTool('list_send_receipts', { description: 'Read Dispatch’s persisted send outcomes, including unknown outcomes and verified recipients/files. This does not send or retry email.', inputSchema: {}, annotations: readonly }, () => result(() => request('/v1/send-receipts')))
  server.registerTool('read_draft', { description: 'Read the exact Gmail draft through Dispatch, including To, Cc, Bcc, body, and attachments. This does not change or send it.', inputSchema: identity, annotations: readonly }, ({ accountId, draftId }) => result(async () => ({ draft: await read(accountId, draftId) })))
  server.registerTool('create_draft', { description: 'Create a Gmail draft through Dispatch and open the saved draft in the editor. Creating a draft does not send it.', inputSchema: { accountId: identity.accountId, messageId: z.string().optional(), ...fields }, annotations: write }, ({ accountId, messageId, ...input }) => result(() => request('/v1/drafts', 'POST', {
    accountId, messageId: messageId ?? '', ...input, to: input.to?.join(', ') ?? '', cc: input.cc?.join(', ') ?? '', bcc: input.bcc?.join(', ') ?? '', bodyMarkdown: input.bodyMarkdown ?? '',
  })))
  server.registerTool('update_draft', { description: 'Change only the supplied fields of a saved Dispatch/Gmail draft. Omitted recipients, body, and attachments are preserved. For an address-only correction supply just accountId, draftId, and to. The updated draft opens in the editor. Does not send.', inputSchema: { ...identity, ...fields }, annotations: write }, ({ accountId, draftId, ...input }) => result(async () => {
    const previous = await read(accountId, draftId)
    if (input.bodyMarkdown === undefined && input.attachments === undefined) {
      return request(draftPath(accountId, draftId), 'PATCH', { accountId,
        ...input.to === undefined ? {} : { to: input.to.join(', ') },
        ...input.cc === undefined ? {} : { cc: input.cc.join(', ') },
        ...input.bcc === undefined ? {} : { bcc: input.bcc.join(', ') },
        ...input.subject === undefined ? {} : { subject: input.subject },
      })
    }
    return request(draftPath(accountId, draftId), 'PUT', {
      accountId, messageId: previous.inReplyToMessageId,
      to: input.to?.join(', ') ?? previous.to.map(item => item.address).join(', '),
      cc: input.cc?.join(', ') ?? previous.cc, bcc: input.bcc?.join(', ') ?? previous.bcc,
      subject: input.subject ?? previous.subject, bodyMarkdown: input.bodyMarkdown ?? previous.bodyMarkdown,
      attachments: input.attachments ?? previous.attachments,
    })
  }))
  server.registerTool('send_draft', { description: 'Send this exact saved draft through Dispatch. First verifies its account and at least one recipient; does not rewrite the draft. Returns Gmail’s delivery receipt. Do not retry an uncertain send without checking Sent.', inputSchema: identity, annotations: { ...write, destructiveHint: true, idempotentHint: false } }, ({ accountId, draftId }) => result(async () => {
    const draft = await read(accountId, draftId)
    if (!draft.to?.some(item => item.address.trim()) && !draft.cc?.trim() && !draft.bcc?.trim()) throw new Error('Add a recipient before sending')
    const response = await request(`/v1/drafts/${encodeURIComponent(draftId)}?action=send&account=${encodeURIComponent(accountId)}`, 'POST')
    const delivery = response.delivery as Record<string, unknown> | undefined
    const receipt = (delivery?.structuredContent ?? delivery) as Record<string, unknown> | undefined
    if (!receipt || delivery?.isError || receipt.error || typeof receipt.id !== 'string' || !receipt.id) throw new Error('Dispatch did not receive a confirmed Gmail message ID. Check Sent before retrying.')
    return { id: receipt.id, accountId, draftId, delivery, receipt: response.receipt }
  }))
  server.registerTool('attach_files', {
    description: 'Attach local files to an existing Gmail draft using absolute paths. Appends to existing attachments, preserves the formatted body and recipients, and verifies saved file bytes in Gmail. Returns verified filenames, sizes, and SHA-256 hashes. Does not send. If verification fails, inspect the saved draft before retrying.',
    inputSchema: { ...identity, paths: z.array(z.string().min(1)).min(1) }, annotations: write,
  }, ({ accountId, draftId, paths }) => result(() => request(`/v1/drafts/${encodeURIComponent(draftId)}/attachments`, 'POST', { accountId, paths })))
  return server
}

export async function handleDispatchMailMcp(request: IncomingMessage, response: ServerResponse, mailBase?: string): Promise<void> {
  const server = createDispatchMailMcp(mailBase)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
    enableDnsRebindingProtection: true, allowedHosts: [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`] })
  response.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(request, response)
}
