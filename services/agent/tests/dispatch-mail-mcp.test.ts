import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { dispatchMailConfig, handleDispatchMailMcp } from '../src/dispatch-mail-mcp.js'
const cleanup: (() => Promise<void>)[] = []
it('permits authorized unsent draft editing without changing send or global approval policy', () => {
  const config = dispatchMailConfig()
  expect(config['mcp_servers.dispatch_mail'].tools).toEqual({ create_draft: { approval_mode: 'approve' }, update_todo: { approval_mode: 'approve' }, update_draft: { approval_mode: 'approve' }, attach_files: { approval_mode: 'approve' }, resolve_draft_conflict: { approval_mode: 'approve' } })
  expect(config).not.toHaveProperty('approval_policy')
  expect(config['mcp_servers.dispatch_mail'].tools).not.toHaveProperty('send_draft')
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
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
  expect(writes).toEqual([{ method: 'POST', url: '/v1/draft-saves', body: { accountId: 'account-A', draftId: 'draft-A', to: 'new@example.com' } }])
  expect(result.structuredContent).toMatchObject({ draft: { to: [{ address: 'new@example.com' }], cc: 'copy@example.com', bodyMarkdown: 'Original body', attachments: [{ name: 'original.pdf' }] } })
})
it('routes absolute attachment paths to the mail owner', async () => {
  const { client, writes } = await setup()
  const operationId = '61c4381d-9eb5-4350-9662-d5ad48a3b35a'
  const result = await client.callTool({ name: 'attach_files', arguments: { accountId: 'account-A', draftId: 'draft-A', operationId, paths: ['/tmp/proposal.pdf'] } })
  expect(result.isError).not.toBe(true)
  expect(writes).toEqual([{ method: 'POST', url: '/v1/drafts/draft-A/attachments', body: { accountId: 'account-A', operationId, paths: ['/tmp/proposal.pdf'] } }])
})

it('reuses the same attachment operation UUID when the tool call is retried', async () => {
  const { client, writes } = await setup()
  const operationId = 'd649cf88-488a-4c36-a5c7-b75d983f1ed2'
  for (let attempt = 0; attempt < 2; attempt++) await client.callTool({ name: 'attach_files', arguments: { accountId: 'account-A', draftId: 'queued-new-draft', operationId, paths: ['/tmp/proposal.pdf'] } })
  expect(writes).toEqual([
    { method: 'POST', url: '/v1/drafts/queued-new-draft/attachments', body: { accountId: 'account-A', operationId, paths: ['/tmp/proposal.pdf'] } },
    { method: 'POST', url: '/v1/drafts/queued-new-draft/attachments', body: { accountId: 'account-A', operationId, paths: ['/tmp/proposal.pdf'] } },
  ])
})
it('resolves the chosen conflict through the mail owner with an exact revision', async () => {
  const { client, writes } = await setup()
  const result = await client.callTool({ name: 'resolve_draft_conflict', arguments: { accountId: 'account-A', draftId: 'queued-draft/A', choice: 'keep-local', expectedRevision: 7 } })
  expect(result.isError).not.toBe(true)
  expect(writes).toEqual([{ method: 'POST', url: '/v1/draft-saves/queued-draft%2FA/conflict', body: { accountId: 'account-A', choice: 'keep-local', expectedRevision: 7 } }])
  writes.splice(0)
  const rejected = await client.callTool({ name: 'resolve_draft_conflict', arguments: { accountId: 'account-A', draftId: 'queued-draft/A', choice: 'keep-local', expectedRevision: 0 } })
  expect(rejected.isError).toBe(true)
  expect(writes).toEqual([])
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

it('carries the stable creation UUID into the durable command so a tool retry cannot duplicate a finished draft', async () => {
  const { client, writes } = await setup()
  const clientDraftId = '61c4381d-9eb5-4350-9662-d5ad48a3b35a'
  const result = await client.callTool({ name: 'create_draft', arguments: { accountId: 'account-A', clientDraftId, to: ['new@example.com'], bodyMarkdown: 'Keep this' } })
  expect(result.isError).not.toBe(true)
  expect(writes).toEqual([{ method: 'POST', url: '/v1/draft-saves', body: { accountId: 'account-A', messageId: '', clientDraftId, to: 'new@example.com', bodyMarkdown: 'Keep this', cc: '', bcc: '' } }])
})

it('routes saved work reads and versioned task edits to the independent work owner',async()=>{
 const calls:{url:string;body:unknown}[]=[]
 const work=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));calls.push({url:req.url!,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.method==='POST'?{item:{id:'abc',status:'done',revision:4}}:{items:[{id:'abc',revision:3}],decisions:[]}))})
 await new Promise<void>(resolve=>work.listen(0,'127.0.0.1',resolve));cleanup.push(()=>new Promise(resolve=>work.close(()=>resolve())))
 vi.stubEnv('DISPATCH_WORK_BASE',`http://127.0.0.1:${(work.address() as AddressInfo).port}`)
 const {client,writes}=await setup()
 const list=await client.callTool({name:'list_work',arguments:{account:'account-A',contact:'jacob@example.com'}});expect(list.isError).not.toBe(true)
 const update=await client.callTool({name:'update_todo',arguments:{id:'abc',revision:3,status:'done'}});expect(update.structuredContent).toMatchObject({item:{status:'done',revision:4}})
 expect(calls).toEqual([{url:'/v1/work?account=account-A&contact=jacob%40example.com',body:null},{url:'/v1/work/items/abc',body:{revision:3,status:'done'}}]);expect(writes).toEqual([])
})
