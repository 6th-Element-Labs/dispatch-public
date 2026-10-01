import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const identity = { accountId: z.string().min(1), draftId: z.string().min(1) }
const attachment = z.object({ id: z.string().optional(), name: z.string(), mediaType: z.string(), contentBase64: z.string().optional(), sourceMessageId: z.string().optional(), sizeLabel: z.string().optional() })
const fields = { to: z.array(z.string()).optional(), cc: z.array(z.string()).optional(), bcc: z.array(z.string()).optional(), subject: z.string().optional(), bodyMarkdown: z.string().optional(), attachments: z.array(attachment).optional() }
type Draft = { syncState?: 'pending' | 'failed'; resolvedFromDraftId?: string; id: string; accountId: string; inReplyToMessageId: string; to: { address: string }[]; cc: string; bcc: string; subject: string; bodyMarkdown: string; attachments: unknown[] }

export function dispatchMailConfig() {
  return { 'mcp_servers.dispatch_mail': {
    url: `http://127.0.0.1:${process.env.DISPATCH_AGENT_PORT ?? '8412'}/mcp/dispatch-mail`, tool_timeout_sec: 90,
    // Draft edits are authorized by the user's draft request and do not send mail.
    // Explicit per-tool approval also works in older chats with policy "never".
    tools: {
      create_draft: { approval_mode: 'approve' },
      update_draft: { approval_mode: 'approve' },
      attach_files: { approval_mode: 'approve' },
      resolve_draft_conflict: { approval_mode: 'approve' },
    },
  } }
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
    if (!draft || (draft.id !== draftId && draft.resolvedFromDraftId !== draftId) || draft.accountId !== accountId) throw new Error('Dispatch returned a different draft or account')
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
  server.registerTool('create_draft', { description: 'Save a new unsent draft durably in Dispatch and open it in the editor immediately. It retries Gmail saves after reconnection. syncState pending means saved on this device only; read_draft confirms Gmail when syncState is absent. Creating a draft does not send it.', inputSchema: { accountId: identity.accountId, messageId: z.string().optional(), clientDraftId: z.string().uuid().describe('A fresh UUID for this new draft. Reuse it for retries of the same creation; use a new UUID for another draft.'), ...fields }, annotations: write }, ({ accountId, messageId, ...input }) => result(() => request('/v1/draft-saves', 'POST', {
    accountId, messageId: messageId ?? '', ...input, to: input.to?.join(', ') ?? '', cc: input.cc?.join(', ') ?? '', bcc: input.bcc?.join(', ') ?? '', bodyMarkdown: input.bodyMarkdown ?? '',
  })))
  server.registerTool('update_draft', { description: 'Save supplied draft changes durably in Dispatch and open them in the editor. Omitted recipients, body and attachments are preserved. Retries safely after reconnection. syncState pending means saved on this device only; read_draft confirms Gmail when syncState is absent. Does not send.', inputSchema: { ...identity, ...fields }, annotations: write }, ({ accountId, draftId, ...input }) => result(() => request('/v1/draft-saves', 'POST', {
    accountId, draftId, ...input,
    ...input.to === undefined ? {} : { to: input.to.join(', ') },
    ...input.cc === undefined ? {} : { cc: input.cc.join(', ') },
    ...input.bcc === undefined ? {} : { bcc: input.bcc.join(', ') },
  })))
  server.registerTool('resolve_draft_conflict', {
    description: 'Resolve a same-field Gmail draft conflict using the version the user chose. Read the current draft and both versions first. keep-local retries the accepted local changes against the Gmail version; use-remote keeps the Gmail version. Both snapshots are archived before the choice. Supply the draftRevision from read_draft so an older choice cannot replace newer edits. This does not send email.',
    inputSchema: { ...identity, choice: z.enum(['keep-local', 'use-remote']), expectedRevision: z.number().int().min(1) }, annotations: write,
  }, ({ accountId, draftId, choice, expectedRevision }) => result(() => request(`/v1/draft-saves/${encodeURIComponent(draftId)}/conflict`, 'POST', { accountId, choice, expectedRevision })))
  server.registerTool('send_draft', { description: 'Send this exact saved draft through Dispatch. First verifies its account and at least one recipient; does not rewrite the draft. Returns Gmail’s delivery receipt. Do not retry an uncertain send without checking Sent.', inputSchema: identity, annotations: { ...write, destructiveHint: true, idempotentHint: false } }, ({ accountId, draftId }) => result(async () => {
    const draft = await read(accountId, draftId)
    if (draft.syncState) throw new Error('Draft is still syncing. Nothing was sent.')
    if (!draft.to?.some(item => item.address.trim()) && !draft.cc?.trim() && !draft.bcc?.trim()) throw new Error('Add a recipient before sending')
    const response = await request(`/v1/drafts/${encodeURIComponent(draftId)}?action=send&account=${encodeURIComponent(accountId)}`, 'POST')
    const delivery = response.delivery as Record<string, unknown> | undefined
    const receipt = (delivery?.structuredContent ?? delivery) as Record<string, unknown> | undefined
    if (!receipt || delivery?.isError || receipt.error || typeof receipt.id !== 'string' || !receipt.id) throw new Error('Dispatch did not receive a confirmed Gmail message ID. Check Sent before retrying.')
    return { id: receipt.id, accountId, draftId, delivery, receipt: response.receipt }
  }))
  server.registerTool('attach_files', {
    description: 'Append local files to a Gmail draft or a locally queued draft creation using absolute paths. Supply a fresh operationId UUID and reuse it if this call has an uncertain result. Dispatch stages the bytes durably before acceptance, serializes the append with editor saves, preserves recipients and formatted body/CID references, and verifies exact saved bytes before reporting confirmed files. A pending result means the files are saved on this device and still waiting for Gmail; read_draft can check the draft later. Does not send.',
    inputSchema: { ...identity, operationId: z.string().uuid().describe('A fresh UUID for this append operation. Reuse this exact UUID when retrying the same append.'), paths: z.array(z.string().min(1)).min(1) }, annotations: write,
  }, ({ accountId, draftId, operationId, paths }) => result(() => request(`/v1/drafts/${encodeURIComponent(draftId)}/attachments`, 'POST', { accountId, operationId, paths })))
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
