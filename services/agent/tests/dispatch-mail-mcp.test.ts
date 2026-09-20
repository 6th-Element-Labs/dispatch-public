import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { handleDispatchMailMcp } from '../src/dispatch-mail-mcp.js'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup() {
  const writes: { method: string; url: string; body: Record<string, unknown> }[] = []
  let draft = { id: 'draft-A', accountId: 'account-A', inReplyToMessageId: 'message-A', to: [{ address: 'old@example.com' }], cc: 'copy@example.com', bcc: '', subject: 'Original', bodyMarkdown: 'Original body', attachments: [{ id: 'file-A', sourceMessageId: 'message-A', name: 'original.pdf', mediaType: 'application/pdf' }] }
  const mail = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') return res.end(JSON.stringify(req.url?.startsWith('/v1/accounts') ? { accounts: [{ id: 'account-A' }] } : { draft }))
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    writes.push({ method: req.method!, url: req.url!, body })
    if (req.url === '/v1/search-results') return res.end(JSON.stringify({ searchResults: { query: body.query, requestId: body.requestId, results: [] } }))
    if (req.url?.includes('action=send')) return res.end(JSON.stringify({ delivery: { structuredContent: { id: 'sent-A' } } }))
    if (body.to !== undefined) draft = { ...draft, to: body.to ? [{ address: body.to }] : [] }
    return res.end(JSON.stringify({ draft }))
  })
  await new Promise<void>(r => mail.listen(0, '127.0.0.1', r)); cleanup.push(() => new Promise(r => mail.close(() => r())))
  const endpoint = createServer((req, res) => { void handleDispatchMailMcp(req, res, `http://127.0.0.1:${(mail.address() as AddressInfo).port}`) })
  await new Promise<void>(r => endpoint.listen(0, '127.0.0.1', r)); cleanup.push(() => new Promise(r => endpoint.close(() => r())))
  const client = new Client({ name: 'dispatch-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/mcp`)))
  cleanup.push(() => client.close())
  return { client, writes }
}
it('exposes software controls and changes an address without rewriting MIME or files', async () => {
  const { client, writes } = await setup()
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['list_accounts', 'read_draft', 'create_draft', 'update_draft', 'send_draft']))
  const result = await client.callTool({ name: 'update_draft', arguments: { accountId: 'account-A', draftId: 'draft-A', to: ['new@example.com'] } })
  expect(result.isError).not.toBe(true)
  expect(writes).toEqual([{ method: 'PATCH', url: '/v1/drafts/draft-A?account=account-A', body: { accountId: 'account-A', to: 'new@example.com' } }])
  expect(result.structuredContent).toMatchObject({ draft: { to: [{ address: 'new@example.com' }], cc: 'copy@example.com', bodyMarkdown: 'Original body', attachments: [{ name: 'original.pdf' }] } })
})
it('routes absolute attachment paths to the mail owner', async () => {
  const { client, writes } = await setup()
  const result = await client.callTool({ name: 'attach_files', arguments: { accountId: 'account-A', draftId: 'draft-A', paths: ['/tmp/proposal.pdf'] } })
  expect(result.isError).not.toBe(true)
  expect(writes).toEqual([{ method: 'POST', url: '/v1/drafts/draft-A/attachments', body: { accountId: 'account-A', paths: ['/tmp/proposal.pdf'] } }])
})
it('sends the saved draft through software and returns the actual receipt without rewriting', async () => {
  const { client, writes } = await setup()
  const result = await client.callTool({ name: 'send_draft', arguments: { accountId: 'account-A', draftId: 'draft-A' } })
  expect(result.structuredContent).toMatchObject({ id: 'sent-A', accountId: 'account-A', draftId: 'draft-A' })
  expect(writes).toEqual([{ method: 'POST', url: '/v1/drafts/draft-A?action=send&account=account-A', body: {} }])
})
it('rejects a wrong-account response before any write', async () => {
  const { client, writes } = await setup()
  const result = await client.callTool({ name: 'send_draft', arguments: { accountId: 'other-account', draftId: 'draft-A' } })
  expect(result.isError).toBe(true)
  expect(writes).toEqual([])
})


it('publishes email findings through the mail-owned source validation route', async () => {
  const { client, writes } = await setup()
  const input = { query: 'September delivery', requestId: 'search-one', matches: [] }
  const result = await client.callTool({ name: 'show_search_results', arguments: input })
  expect(result.structuredContent).toEqual({ searchResults: { query: input.query, requestId: input.requestId, results: [] } })
  expect(writes).toEqual([{ method: 'POST', url: '/v1/search-results', body: input }])
})
