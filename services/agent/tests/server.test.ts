import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexBindingStore, defaultCodexWorkspace } from '../src/codex-bindings.js'
import { createAgentServer, draftArguments } from '../src/server.js'

it('puts the stable draft marker on a MIME leaf accepted by Gmail', () => {
  const args = draftArguments({ to: 'test@example.com', subject: 'Draft', bodyMarkdown: 'Body', bodyHtml: '<p>Body</p>', draftContentId: 'dispatch-key@draft.dispatch.local' })
  const payload = args.payload as { content_id?: string; parts: { content_id?: string }[] }
  expect(payload.content_id).toBeUndefined()
  expect(payload.parts[0]?.content_id).toBe('dispatch-key@draft.dispatch.local')
})

const servers: ReturnType<typeof createAgentServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function runtime() {
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => method === 'thread/start' ? { thread: { id: 'thread-1' } } : { ok: true })
  return {
    ready: vi.fn(async () => undefined),
    lastError: vi.fn(() => null),
    lastWarning: vi.fn(() => 'non-fatal diagnostic'),
    request,
    subscribe: vi.fn((_next: (message: { id?: number | string; method?: string; params?: unknown }) => void) => () => undefined),
    respond: vi.fn(),
    close: vi.fn(),
  }
}

function rpcParams(fake: ReturnType<typeof runtime>, method: string, match?: (params: Record<string, unknown>) => boolean): Record<string, unknown> {
  for (const call of fake.request.mock.calls) {
    const name = call[0]
    const params = (call[1] ?? {}) as Record<string, unknown>
    if (name === method && (!match || match(params))) return params
  }
  throw new Error(`No ${method} call`)
}

async function start() {
  const fake = runtime()
  const server = createAgentServer(fake)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, fake }
}

async function startWithBindings() {
  const fake = runtime()
  const path = join(await mkdtemp(join(tmpdir(), 'dispatch-agent-bind-')), 'codex-bindings.json')
  const bindings = new CodexBindingStore(path)
  const server = createAgentServer(fake, { bindings })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, fake, bindings }
}

describe('dispatch-agent', () => {
  it('refuses an update while Codex works and stops admitting work once idle drain succeeds', async () => {
    const { base, fake } = await start()
    const emit = fake.subscribe.mock.calls[0]![0]
    const control = { method: 'POST', headers: { 'x-dispatch-runtime': 'development' } }
    expect((await fetch(`${base}/v1/runtime/drain`, { method: 'POST' })).status).toBe(403)
    emit({ method: 'turn/started', params: { threadId: 'background', turn: { id: 'turn-1' } } })
    expect((await fetch(`${base}/v1/runtime/drain`, control)).status).toBe(409)
    expect(await (await fetch(`${base}/v1/runtime`)).json()).toMatchObject({ activeOperations: 1, draining: false })
    emit({ method: 'turn/completed', params: { threadId: 'background', turn: { id: 'turn-1', status: 'completed' } } })
    expect((await fetch(`${base}/v1/runtime/drain`, control)).status).toBe(200)
    expect((await fetch(`${base}/v1/threads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(503)
    expect((await fetch(`${base}/v1/runtime/resume`, control)).status).toBe(200)
    expect((await fetch(`${base}/v1/threads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(201)
  })
  it('reports the real harness boundary', async () => {
    const { base } = await start()
    const health = await (await fetch(`${base}/health`)).json()
    expect(health).toMatchObject({ appServerError: null, appServerWarning: 'non-fatal diagnostic' })
    const response = await fetch(`${base}/ready`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ harness: 'codex-app-server' })
  })

  it('starts a Codex thread that inherits the user Codex config and allows Gmail MCP', async () => {
    const { base, fake } = await start()
    const response = await fetch(`${base}/v1/threads`, { method: 'POST' })
    expect(response.status).toBe(201)
    const params = rpcParams(fake, 'thread/start')
    expect(params).toMatchObject({
      cwd: expect.stringContaining('codex-workspace'),
      developerInstructions: expect.stringContaining('normal installed Codex tools'),
      serviceName: 'dispatch-agent',
    })
    expect(params).not.toHaveProperty('model')
    expect(params).not.toHaveProperty('approvalPolicy')
    expect(params).not.toHaveProperty('sandboxPolicy')
    expect(params).not.toHaveProperty('sandbox')
    expect(String(params.developerInstructions)).not.toMatch(/Never call gmail\.send/)
    expect(String(params.developerInstructions)).toContain('send mail')
    expect(String(params.developerInstructions)).toMatch(/attachment/i)
  })

  it('resumes an existing Codex thread after an adapter restart', async () => {
    const { base, fake } = await start()
    fake.request.mockResolvedValueOnce({ thread: { id: 'thread-1' } })
    const response = await fetch(`${base}/v1/threads/thread-1/resume`, { method: 'POST' })
    expect(response.status).toBe(200)
    const params = rpcParams(fake, 'thread/resume')
    expect(params).toMatchObject({
      threadId: 'thread-1',
      cwd: expect.stringContaining('codex-workspace'),
      developerInstructions: expect.stringMatching(/send_draft|send_email/),
    })
    expect(params).not.toHaveProperty('model')
    expect(params).not.toHaveProperty('approvalPolicy')
    expect(String(params.developerInstructions)).not.toMatch(/Never call gmail\.send/)
  })

  it('omits model and effort when the client sent none so the thread keeps the user Codex default', async () => {
    const { base, fake } = await start()
    const response = await fetch(`${base}/v1/threads/thread-1/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Summarize this email.', model: '', effort: '  ' }) })
    expect(response.status).toBe(202)
    const params = rpcParams(fake, 'turn/start')
    expect(params).toMatchObject({ threadId: 'thread-1' })
    expect(params).not.toHaveProperty('model')
    expect(params).not.toHaveProperty('effort')
    expect(params).not.toHaveProperty('approvalPolicy')
  })

  it('forwards the model and effort the client chose for a turn', async () => {
    const { base, fake } = await start()
    const response = await fetch(`${base}/v1/threads/thread-1/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Summarize this email.', model: 'gpt-reserve', effort: 'max' }) })
    expect(response.status).toBe(202)
    expect(fake.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-1', model: 'gpt-reserve', effort: 'max' }))
  })

  it('adds a short selected-Gmail line instead of a JSON dump', async () => {
    const { base, fake } = await start()
    const response = await fetch(`${base}/v1/threads/thread-1/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Reply for me.',
        mailContext: { accountId: 'link-one', threadId: 't1', messageId: 'm1', subject: 'Berth', sender: 'ana@example.com' },
      }),
    })
    expect(response.status).toBe(202)
    const params = rpcParams(fake, 'turn/start')
    const input = (params.input as Array<{ text?: string }> | undefined) ?? []
    expect(input[0]?.text).toContain('Reply for me.')
    expect(input[0]?.text).toContain('account link-one')
    expect(input[0]?.text).toContain('thread t1')
    expect(input[0]?.text).not.toContain('Selected email context supplied by Dispatch UI')
    expect(input[0]?.text).not.toContain('"subject":"Berth"')
  })

  it('serves the model catalog joined with usage buckets', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'model/list') return { data: [
        { id: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'max' }] },
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      ] }
      if (method === 'account/rateLimits/read') return { rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 100, resetsAt: 1788754468 }, rateLimitReachedType: 'rate_limit_reached' },
        base_model_inference: { primary: { usedPercent: 0, resetsAt: 1789252467 }, rateLimitReachedType: null },
      } }
      if (method === 'config/read') return { config: { model: 'gpt-5.6-sol', model_reasoning_effort: 'medium' }, origins: {} }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/models`)
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('model/list', expect.objectContaining({ includeHidden: true }))
    expect(fake.request).toHaveBeenCalledWith('config/read', { cwd: defaultCodexWorkspace() })
    await expect(response.json()).resolves.toEqual({
      defaults: { model: 'gpt-5.6-sol', effort: 'medium' },
      rateLimitsError: null,
      models: [
        { id: 'gpt-reserve', label: 'Luna Reserve', efforts: ['max'], exhausted: false, resetsAt: 1789252467 },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['medium'], exhausted: true, resetsAt: 1788754468 },
      ],
    })
    expect(fake.request.mock.calls.map(([method]) => method)).not.toContain('account/rateLimitResetCredit/consume')
  })

  it('reports a failed rate-limit read without hiding the catalog', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'model/list') return { data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, supportedReasoningEfforts: [] }] }
      if (method === 'account/rateLimits/read') throw new Error('limits offline')
      if (method === 'config/read') return { config: { model: 'gpt-5.6-sol', model_reasoning_effort: 'medium' }, origins: {} }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/models`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ rateLimitsError: 'limits offline', models: [{ id: 'gpt-5.6-sol', exhausted: null }] })
  })

  it('uses the Codex config as the picker default and lists a hidden default model', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'model/list') return { data: [
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
        { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: true, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }] },
      ] }
      if (method === 'account/rateLimits/read') return { rateLimitsByLimitId: {} }
      if (method === 'config/read') return { config: { model: 'gpt-6-astra', model_reasoning_effort: 'xhigh' }, origins: {} }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/models`)
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('config/read', { cwd: defaultCodexWorkspace() })
    await expect(response.json()).resolves.toMatchObject({
      defaults: { model: 'gpt-6-astra', effort: 'xhigh' },
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['medium', 'xhigh'] }),
      ]),
    })
  })

  it('fails visibly when config/read is unavailable', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'model/list') return { data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [] }] }
      if (method === 'config/read') throw new Error('config/read timed out')
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/models`)
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: 'model_catalog_unavailable', detail: 'config/read timed out' })
  })

  it('fails visibly when the catalog is unavailable', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => { if (method === 'model/list') throw new Error('app-server gone'); return {} })
    const response = await fetch(`${base}/v1/models`)
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: 'model_catalog_unavailable', detail: 'app-server gone' })
  })

  it('normalizes installed connector state for the thin client', async () => {
    const { base, fake } = await start()
    fake.request.mockResolvedValueOnce({ apps: [{ id: 'gmail', runtimeName: 'Gmail', enabled: true, callable: true }] })
    const response = await fetch(`${base}/v1/apps`)
    await expect(response.json()).resolves.toEqual({ data: [{ id: 'gmail', name: 'Gmail', isAccessible: true, isEnabled: true, callable: true }] })
  })

  it('falls back to app/list for installed Codex versions without app/installed', async () => {
    const { base, fake } = await start()
    fake.request
      .mockRejectedValueOnce(new Error('Invalid request: unknown variant `app/installed`'))
      .mockResolvedValueOnce({ data: [{ id: 'gmail', name: 'Gmail', isAccessible: true, isEnabled: true }] })
    const response = await fetch(`${base}/v1/apps`)
    await expect(response.json()).resolves.toEqual({ data: [{ id: 'gmail', name: 'Gmail', isAccessible: true, isEnabled: true, callable: true }] })
    expect(fake.request).toHaveBeenNthCalledWith(2, 'app/list', { cursor: null, limit: 20, forceRefetch: false })
  })

  it('reads a complete Gmail thread through the Codex connector', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.read_email_thread': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one', link_owner_profile: { email: 'work@example.com' } } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      if (method === 'mcpServer/tool/call') return { structuredContent: { messages: [] } }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/read-thread`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', threadId: 'gmail-thread', maxMessages: 20 }),
    })
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({
      server: 'codex_apps', tool: 'gmail.read_email_thread',
      arguments: { link_id: 'link-one', thread_id: 'gmail-thread', max_messages: 20 },
    }))
  })

  it('passes exact Gmail system label IDs to message search', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.search_emails': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      if (method === 'mcpServer/tool/call') return { structuredContent: { emails: [] } }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/search-messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', query: '-in:spam', labelIds: ['INBOX', 'UNREAD'], maxResults: 20, nextPageToken: 'next-1' }),
    })
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({
      arguments: { link_id: 'link-one', query: '-in:spam', label_ids: ['INBOX', 'UNREAD'], max_results: 20, next_page_token: 'next-1' },
    }))
  })

  it('applies accepted Gmail read-state label changes', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.batch_modify_email': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/modify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', messageIds: ['m1'], removeLabels: ['UNREAD'] }),
    })
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({
      tool: 'gmail.batch_modify_email', arguments: { link_id: 'link-one', message_ids: ['m1'], add_labels: [], remove_labels: ['UNREAD'] },
    }))
  })

  it('routes archive and Trash through their explicit Gmail tools', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.archive_emails': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
        'gmail.delete_emails': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { ok: true }
    })
    expect((await fetch(`${base}/v1/connectors/gmail/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId: 'link-one', threadIds: ['t1'] }) })).status).toBe(200)
    expect((await fetch(`${base}/v1/connectors/gmail/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId: 'link-one', messageIds: ['m1'] }) })).status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({ tool: 'gmail.archive_emails', arguments: { link_id: 'link-one', thread_ids: ['t1'] } }))
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({ tool: 'gmail.delete_emails', arguments: { link_id: 'link-one', message_ids: ['m1'] } }))
  })

  it('sends HTML and Markdown payloads for Gmail drafts and tells Codex it may send', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.create_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/drafts/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', to: 'to@example.com', subject: 'Hello', bodyMarkdown: '**Hi**', bodyHtml: '<p><strong>Hi</strong></p>' }),
    })
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({
      arguments: expect.objectContaining({
        payload: { mime_type: 'multipart/alternative', parts: [
          { mime_type: 'text/plain', charset: 'UTF-8', body: { content: '**Hi**' } },
          { mime_type: 'text/html', charset: 'UTF-8', body: { content: '<p><strong>Hi</strong></p>' } },
        ] },
        response_fields: ['id', 'message'],
      }),
    }))

    await fetch(`${base}/v1/threads`, { method: 'POST' })
    const chatStart = rpcParams(fake, 'thread/start', (params) => Boolean(params.developerInstructions))
    expect(String(chatStart.developerInstructions)).toMatch(/send_draft|send_email/)
    expect(String(chatStart.developerInstructions)).not.toMatch(/Never call gmail\.send/)
  })

  it('reads a Gmail attachment by id without a filename selector', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.read_attachment': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { structuredContent: { mime_type: 'image/png', download_url: 'https://files.example.com/x' } }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/attachment`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', messageId: 'm1', attachmentId: 'att-1', filename: 'image.png' }),
    })
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({
      tool: 'gmail.read_attachment',
      arguments: { link_id: 'link-one', message_id: 'm1', attachment_id: 'att-1' },
    }))
  })

  it('passes draft attachments to the Gmail connector', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.create_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
        'gmail.update_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { ok: true }
    })
    const attachments = [{ filename: 'arrival.pdf', mime_type: 'application/pdf', data: 'cGRm' }]
    expect((await fetch(`${base}/v1/connectors/gmail/drafts/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', to: 'to@example.com', subject: 'Hello', bodyMarkdown: 'Hi', bodyHtml: '<p>Hi</p>', attachments }),
    })).status).toBe(200)
    expect((await fetch(`${base}/v1/connectors/gmail/drafts/update`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', draftId: 'draft-1', subject: 'Hello', bodyMarkdown: 'Hi', bodyHtml: '<p>Hi</p>', attachments }),
    })).status).toBe(200)
    const calls = (fake.request.mock.calls as unknown as Array<[string, { tool: string; arguments: Record<string, unknown> }]>).filter(([method]) => method === 'mcpServer/tool/call').map(([, params]) => params)
    expect(calls.map((call) => call.tool)).toEqual(['gmail.create_draft', 'gmail.update_draft'])
    for (const call of calls) {
      // Only keys the connector schema declares; text and HTML as alternative parts, files as base64url parts.
      expect(Object.keys(call.arguments)).toEqual(expect.arrayContaining(['link_id', 'payload', 'response_fields', 'subject', 'to']))
      expect(call.arguments).not.toHaveProperty('text_plain')
      expect(call.arguments).not.toHaveProperty('attachments')
      expect(call.arguments).not.toHaveProperty('cc')
      expect(call.arguments).not.toHaveProperty('reply_message_id')
      expect(call.arguments.payload).toEqual({
        mime_type: 'multipart/mixed',
        parts: [
          { mime_type: 'multipart/alternative', parts: [
            { mime_type: 'text/plain', charset: 'UTF-8', body: { content: 'Hi' } },
            { mime_type: 'text/html', charset: 'UTF-8', body: { content: '<p>Hi</p>' } },
          ] },
          { mime_type: 'application/pdf', filename: 'arrival.pdf', content_disposition: 'attachment', body: { base64_url_content: 'cGRm' } },
        ],
      })
    }
    expect(calls[1]!.arguments.draft_id).toBe('draft-1')
  })

  it('updates a Gmail draft with HTML and plain-text payloads', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.update_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/drafts/update`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', draftId: 'draft-1', subject: 'Updated', bodyMarkdown: '**Updated**', bodyHtml: '<p><strong>Updated</strong></p>' }),
    })
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({
      tool: 'gmail.update_draft',
      arguments: expect.objectContaining({
        draft_id: 'draft-1',
        payload: { mime_type: 'multipart/alternative', parts: [
          { mime_type: 'text/plain', charset: 'UTF-8', body: { content: '**Updated**' } },
          { mime_type: 'text/html', charset: 'UTF-8', body: { content: '<p><strong>Updated</strong></p>' } },
        ] },
      }),
    }))
  })

  it('lists Gmail drafts through the connector with pagination', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.list_drafts': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      if (method === 'mcpServer/tool/call') return { structuredContent: { drafts: [] } }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/drafts/list`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', maxResults: 25, nextPageToken: 'next-1' }),
    })
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({
      server: 'codex_apps',
      tool: 'gmail.list_drafts',
      arguments: { link_id: 'link-one', max_results: 25, next_page_token: 'next-1' },
    }))
  })

  it('rejects Gmail draft create when linkId is missing', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.create_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/drafts/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'to@example.com', subject: 'Hello', bodyHtml: '<p>Hi</p>' }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'linkId_required' })
    expect(fake.request).not.toHaveBeenCalledWith('mcpServer/tool/call', expect.anything())
  })

  it('rejects Gmail draft create and update when HTML is missing', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.create_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
        'gmail.update_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { ok: true }
    })
    const request = (path: string, payload: Record<string, string>) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    const create = await request('/v1/connectors/gmail/drafts/create', { linkId: 'link-one', bodyText: 'Plain text only' })
    const update = await request('/v1/connectors/gmail/drafts/update', { linkId: 'link-one', draftId: 'draft-1', bodyMarkdown: '**Plain text only**' })
    expect(create.status).toBe(400)
    await expect(create.json()).resolves.toEqual({ error: 'gmail_html_unsupported' })
    expect(update.status).toBe(400)
    await expect(update.json()).resolves.toEqual({ error: 'gmail_html_unsupported' })
    expect(fake.request).not.toHaveBeenCalledWith('mcpServer/tool/call', expect.anything())
  })

  it('discards a Gmail draft through the explicit delete draft tool', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.delete_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/drafts/discard`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', draftId: 'draft-1' }),
    })
    expect(response.status).toBe(200)
    expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({
      tool: 'gmail.delete_draft',
      arguments: { link_id: 'link-one', draft_id: 'draft-1' },
    }))
  })

  it('returns a service error when Gmail draft discard is unavailable', async () => {
    const { base, fake } = await start()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: {
        'gmail.create_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } },
      } }] }
      return { ok: true }
    })
    const response = await fetch(`${base}/v1/connectors/gmail/drafts/discard`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'link-one', draftId: 'draft-1' }),
    })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'gmail_draft_discard_unavailable' })
  })

  it('reads history, steers, and interrupts the active Codex turn', async () => {
    const { base, fake } = await start()
    await fetch(`${base}/v1/threads/thread-1`)
    await fetch(`${base}/v1/threads/thread-1/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedTurnId: 'turn-1', text: 'Change focus' }) })
    await fetch(`${base}/v1/threads/thread-1/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnId: 'turn-1' }) })
    expect(fake.request).toHaveBeenCalledWith('thread/read', { threadId: 'thread-1', includeTurns: true })
    expect(fake.request).toHaveBeenCalledWith('turn/steer', { threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'Change focus' }] })
    expect(fake.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' })
  })

  it('returns a user decision to a server-initiated Codex request', async () => {
    const { base, fake } = await start()
    const response = await fetch(`${base}/v1/server-requests/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'approval-1', result: { decision: 'decline' } }),
    })
    expect(response.status).toBe(200)
    expect(fake.respond).toHaveBeenCalledWith('approval-1', { decision: 'decline' })
  })
  it('allows the browser origin by default and honors DISPATCH_ALLOWED_ORIGIN', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/health`)).headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8410')
    vi.stubEnv('DISPATCH_ALLOWED_ORIGIN', 'tauri://localhost')
    vi.resetModules()
    try {
      const { createAgentServer: fresh } = await import('../src/server.js')
      const server = fresh(runtime())
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      expect((await fetch(`http://127.0.0.1:${port}/health`)).headers.get('access-control-allow-origin')).toBe('tauri://localhost')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('starts one Codex thread for a conversation and reuses it', async () => {
    const { base, fake } = await startWithBindings()
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'thread-t1' } }
      if (method === 'thread/resume') return { thread: { id: 'thread-t1' } }
      return { ok: true }
    })
    const body = { kind: 'conversation', accountId: 'one', gmailThreadId: 't1' }
    const first = await fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ binding: { key: body, threadId: 'thread-t1', created: true, replaced: false } })
    const second = await fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await expect(second.json()).resolves.toEqual({ binding: { key: body, threadId: 'thread-t1', created: false, replaced: false } })
    expect(fake.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
    expect(fake.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: 'thread-t1' }))
  })

  it('reports a thread another Codex app holds as busy and starts a new chat on request', async () => {
    const { base, fake } = await startWithBindings()
    let started = 0
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'thread/start') { started += 1; return { thread: { id: `thread-${started}` } } }
      if (method === 'thread/resume') throw new Error('thread thread-1 already has an active writer')
      return { ok: true }
    })
    const body = { kind: 'conversation', accountId: 'one', gmailThreadId: 't-busy' }
    const post = (payload: unknown) => fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    expect((await post(body)).status).toBe(200)
    const busy = await post(body)
    expect(busy.status).toBe(409)
    await expect(busy.json()).resolves.toEqual({ error: 'codex_thread_busy', detail: 'thread thread-1 already has an active writer', threadId: 'thread-1' })
    const replaced = await post({ ...body, replace: true })
    expect(replaced.status).toBe(200)
    await expect(replaced.json()).resolves.toEqual({ binding: { key: body, threadId: 'thread-2', created: true, replaced: true, detail: 'A new chat was started for this email.' } })
    expect(started).toBe(2)
  })

  it('gives two conversations two thread ids', async () => {
    const { base, fake } = await startWithBindings()
    let n = 0
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'thread/start') {
        n += 1
        return { thread: { id: `thread-${n}` } }
      }
      return { ok: true }
    })
    const one = await (await fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'conversation', accountId: 'one', gmailThreadId: 'a' }) })).json()
    const two = await (await fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'conversation', accountId: 'one', gmailThreadId: 'b' }) })).json()
    expect(one.binding.threadId).toBe('thread-1')
    expect(two.binding.threadId).toBe('thread-2')
  })

  it('keeps a stable unbound thread that is not a conversation key', async () => {
    const { base, fake } = await startWithBindings()
    fake.request.mockImplementation(async (method: string) => method === 'thread/start' ? { thread: { id: 'thread-unbound' } } : { ok: true })
    const first = await (await fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'unbound' }) })).json()
    const again = await (await fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'unbound' }) })).json()
    expect(first.binding).toMatchObject({ key: { kind: 'unbound' }, threadId: 'thread-unbound' })
    expect(again.binding.threadId).toBe('thread-unbound')
    expect(fake.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
  })

  it('adopts the existing local thread id as the unbound thread', async () => {
    const { base, fake } = await startWithBindings()
    fake.request.mockImplementation(async (method: string) => method === 'thread/resume' ? { thread: { id: 'legacy' } } : { ok: true })
    const response = await fetch(`${base}/v1/threads/bindings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'unbound', adoptThreadId: 'legacy' }),
    })
    await expect(response.json()).resolves.toEqual({ binding: { key: { kind: 'unbound' }, threadId: 'legacy', created: false, replaced: false } })
    expect(fake.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: 'legacy' }))
    expect(fake.request).not.toHaveBeenCalledWith('thread/start', expect.anything())
  })

  it('does not rebind a failed resume to another conversation id', async () => {
    const { base, fake, bindings } = await startWithBindings()
    await bindings.put({ kind: 'conversation', accountId: 'one', gmailThreadId: 'a' }, 'dead')
    await bindings.put({ kind: 'conversation', accountId: 'one', gmailThreadId: 'b' }, 'alive')
    fake.request.mockImplementation(async (method: string, params?: unknown) => {
      const threadId = (params as { threadId?: string } | undefined)?.threadId
      if (method === 'thread/resume' && threadId === 'dead') throw new Error('unknown thread')
      if (method === 'thread/resume') return { thread: { id: threadId } }
      if (method === 'thread/start') return { thread: { id: 'replacement' } }
      return { ok: true }
    })
    const failed = await (await fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'conversation', accountId: 'one', gmailThreadId: 'a' }) })).json()
    expect(failed.binding).toMatchObject({ threadId: 'replacement', created: true, replaced: true })
    expect(bindings.get({ kind: 'conversation', accountId: 'one', gmailThreadId: 'b' })).toBe('alive')
  })

  it('rejects an invalid binding key', async () => {
    const { base } = await startWithBindings()
    const response = await fetch(`${base}/v1/threads/bindings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'conversation', accountId: '', gmailThreadId: 't1' }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_binding_key' })
  })
})

describe('connector threads', () => {
  it('answers permission prompts on its own connector threads and leaves user threads alone', async () => {
    const { base, fake } = await start()
    const listeners: Array<(message: { id?: number | string; method?: string; params?: unknown }) => void> = []
    fake.subscribe.mockImplementation((next: (message: { id?: number | string; method?: string; params?: unknown }) => void) => { listeners.push(next); return () => undefined })
    // subscribe() ran inside createAgentServer before this mock; re-create the server so it registers here.
    const server = createAgentServer(fake)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: { 'gmail.create_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } } } }] }
      if (method === 'thread/start') return { thread: { id: 'connector-thread' } }
      return { structuredContent: { id: 'draft-1' } }
    })
    expect((await fetch(`${local}/v1/connectors/gmail/drafts/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId: 'link-one', to: 'a@b.c', subject: 'Hi', bodyMarkdown: 'Hi', bodyHtml: '<p>Hi</p>' }) })).status).toBe(200)
    for (const listener of listeners) listener({ id: 9, method: 'mcpServer/elicitation/request', params: { threadId: 'connector-thread', message: 'Allow Gmail to run tool "gmail.update_draft"?' } })
    for (const listener of listeners) listener({ id: 10, method: 'mcpServer/elicitation/request', params: { threadId: 'user-thread', message: 'Allow?' } })
    for (const listener of listeners) listener({ id: 11, method: 'item/permissions/requestApproval', params: { threadId: 'connector-thread' } })
    expect(fake.respond).toHaveBeenCalledWith(9, { action: 'accept', content: {} })
    expect(fake.respond).toHaveBeenCalledWith(11, { decision: 'accept' })
    expect(fake.respond).not.toHaveBeenCalledWith(10, expect.anything())
    void base
  })
})


it.each(['Temporary transport timeout', 'MCP server unavailable', 'Unauthorized', 'Invalid model configuration'])(
  'preserves the history binding after a temporary or non-missing resume failure: %s', async (message) => {
    const { base, fake, bindings } = await startWithBindings()
    const key = { kind: 'conversation' as const, accountId: 'account-A', gmailThreadId: 'mail-A' }
    await bindings.put(key, 'existing-history')
    fake.request.mockImplementation(async (method: string) => {
      if (method === 'thread/resume') throw new Error(message)
      return { thread: { id: 'replacement' } }
    })
    const response = await fetch(`${base}/v1/threads/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(key) })
    expect(response.status).toBe(502)
    expect(bindings.get(key)).toBe('existing-history')
    expect(fake.request).not.toHaveBeenCalledWith('thread/start', expect.anything())
    await bindings.load()
    expect(bindings.get(key)).toBe('existing-history')
  },
)

it('passes a file only with its matching account and conversation context', async () => {
  const { base, fake } = await start()
  const send = (attachment: Record<string, string>) => fetch(`${base}/v1/threads/task-A/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Read this file', mailContext: { accountId: 'account-A', threadId: 'mail-A', messageId: 'new-email', attachment } }),
  })
  await send({ accountId: 'account-A', threadId: 'mail-A', messageId: 'older-email', attachmentId: 'file-A', filename: 'report.pdf' })
  expect(JSON.stringify(rpcParams(fake, 'turn/start'))).toContain('older-email')
  fake.request.mockClear()
  await send({ accountId: 'account-B', threadId: 'mail-B', messageId: 'wrong-email', attachmentId: 'wrong-file' })
  expect(JSON.stringify(rpcParams(fake, 'turn/start'))).not.toContain('wrong-file')
})

it('updates only draft headers without replacing the MIME body or attachments', async () => {
  const { base, fake } = await start()
  fake.request.mockImplementation(async (method: string) => {
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: { 'gmail.update_draft': { _meta: { connector_name: 'Gmail', connector_id: 'gmail', link_id: 'link-one' } } } }] }
    if (method === 'thread/start') return { thread: { id: 'connector-task' } }
    return { structuredContent: { id: 'draft-one' } }
  })
  const response = await fetch(`${base}/v1/connectors/gmail/drafts/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId: 'link-one', draftId: 'draft-one', preserveContent: true, to: 'new@example.com' }) })
  expect(response.status).toBe(200)
  expect(fake.request).toHaveBeenCalledWith('mcpServer/tool/call', expect.objectContaining({ arguments: { link_id: 'link-one', draft_id: 'draft-one', to: 'new@example.com' } }))
})
