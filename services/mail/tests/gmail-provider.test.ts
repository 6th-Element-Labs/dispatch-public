import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { projectConversation } from '../src/conversation.js'
import { projectDraft } from '../src/draft.js'
import { folderFlagsFromLabels, GmailIndex } from '../src/gmail-index.js'
import { LocalMailStore } from '../src/local-mail-store.js'
import { GmailConnectorProvider, mergeIndexedMessages, projectGmailMessage, projectGmailSearchEmail } from '../src/gmail-provider.js'

const servers: ReturnType<typeof createServer>[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

/** Serves the ID-only search from a fake's detailed search: the same page, as message IDs. */
function answerIdsFromDetails(request: IncomingMessage, response: ServerResponse): void {
  if (request.url !== '/v1/connectors/gmail/search') return
  request.url = '/v1/connectors/gmail/search-messages'
  const end = response.end.bind(response) as (body?: string) => ServerResponse
  response.end = ((body?: string) => {
    const content = JSON.parse(body || '{}').structuredContent
    return end(Array.isArray(content?.emails) ? JSON.stringify({ structuredContent: { message_ids: content.emails.map((email: { id: string }) => email.id), next_page_token: content.next_page_token ?? '' } }) : body)
  }) as typeof response.end
}

const gmailMessage = {
  structuredContent: {
    id: 'gmail-message-1', thread_id: 'gmail-thread-1', label_ids: ['INBOX', 'UNREAD'], snippet: 'A short preview', internal_date: '1788486120000',
    payload: {
      mime_type: 'multipart/alternative',
      headers: [{ name: 'From', value: 'Ana Morales <ana@example.com>' }, { name: 'To', value: 'Steve <work@example.com>, Ops <ops@example.com>' }, { name: 'Cc', value: 'Manager <manager@example.com>' }, { name: 'Subject', value: 'Berth confirmation' }],
      parts: [
        { part_id: 'plain', mime_type: 'text/plain', filename: '', body: { content: 'Hello.' } },
        { part_id: 'html', mime_type: 'text/html', filename: '', body: { content: '<p>Hello.</p>' } },
        { part_id: 'file', mime_type: 'application/pdf', filename: 'arrival.pdf', body: { size: 824000, attachment_id: 'a1' } },
      ],
    },
  },
}

const gmailDraftMessage = {
  structuredContent: {
    ...gmailMessage.structuredContent,
    payload: {
      ...gmailMessage.structuredContent.payload,
      parts: gmailMessage.structuredContent.payload.parts.filter((part) => !part.filename),
    },
  },
}

type FakeDraftFile = { filename: string; mime_type: string; data: string; contentId?: string }

async function startAttachmentConnector(options: { files?: FakeDraftFile[]; loseFirstUpdateReply?: boolean; pauseCreate?: boolean; pauseUpdate?: boolean; emptyFileWithoutDownloadId?: boolean; omitEmptyFileContent?: boolean } = {}) {
  let files = [...(options.files ?? [])]
  let draftId: string | undefined = options.pauseCreate ? undefined : 'draft'
  let bodyText = 'Original plain MIME body.\n'
  let bodyHtml = '<p>Original <strong>formatted</strong> body.</p>'
  let to = 'work@example.com, ops@example.com'
  let cc = 'manager@example.com'
  let bcc = 'private@example.com'
  let subject = 'Keep'
  let updateCount = 0
  let attachmentReadCount = 0
  let createStarted!: () => void
  let releaseCreate!: () => void
  let updateStarted!: () => void
  let releaseUpdate!: () => void
  const createReached = new Promise<void>(resolve => { createStarted = resolve })
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
  const updateReached = new Promise<void>(resolve => { updateStarted = resolve })
  const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve })
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
    if (request.url === '/v1/connectors/gmail') return response.end(JSON.stringify({ accounts: [{ linkId: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
    if (request.url === '/v1/connectors/gmail/drafts/list') return response.end(JSON.stringify({ structuredContent: { drafts: draftId ? [{ draft_id: draftId, message_id: 'gmail-message-1', thread_id: 'gmail-thread-1', subject, to: to.split(',') }] : [] } }))
    if (request.url === '/v1/connectors/gmail/drafts/create') {
      createStarted()
      if (options.pauseCreate) await createGate
      draftId = 'remote-created'
      bodyText = typeof input.bodyText === 'string' ? input.bodyText : ''
      bodyHtml = typeof input.bodyHtml === 'string' ? input.bodyHtml : ''
      to = typeof input.to === 'string' ? input.to : ''
      cc = typeof input.cc === 'string' ? input.cc : ''
      bcc = typeof input.bcc === 'string' ? input.bcc : ''
      subject = typeof input.subject === 'string' ? input.subject : ''
      files = Array.isArray(input.attachments) ? input.attachments as FakeDraftFile[] : []
      return response.end(JSON.stringify({ structuredContent: { draft_id: draftId, message: { id: 'gmail-message-1', thread_id: 'gmail-thread-1' } } }))
    }
    if (request.url === '/v1/connectors/gmail/read') {
      const headers = [
        { name: 'From', value: 'Steve <work@example.com>' }, { name: 'To', value: to }, { name: 'Cc', value: cc },
        { name: 'Bcc', value: bcc }, { name: 'Subject', value: subject },
      ]
      const parts = [
        { mime_type: 'text/plain', filename: '', body: { content: bodyText } },
        { mime_type: 'text/html', filename: '', body: { content: bodyHtml } },
        ...files.map((file, index) => ({ part_id: String(index + 1), mime_type: file.mime_type, filename: file.filename, headers: file.contentId ? [{ name: 'Content-ID', value: `<${file.contentId}>` }] : [], body: options.emptyFileWithoutDownloadId && file.data === ''
          ? { attachment_id: null, size: 0, content: options.omitEmptyFileContent ? null : '', base64_url_content: null }
          : { attachment_id: String(index), size: Buffer.from(file.data, 'base64').length } })),
      ]
      return response.end(JSON.stringify({ structuredContent: { id: 'gmail-message-1', thread_id: 'gmail-thread-1', label_ids: ['DRAFT'], snippet: '', internal_date: '1788486120000', payload: { mime_type: 'multipart/mixed', headers, parts } } }))
    }
    if (request.url === '/v1/connectors/gmail/attachment') {
      attachmentReadCount += 1
      return response.end(JSON.stringify({ structuredContent: { data: files[Number(input.attachmentId)]?.data } }))
    }
    if (request.url === '/v1/connectors/gmail/drafts/update') {
      updateCount += 1
      if (options.pauseUpdate && updateCount === 1) { updateStarted(); await updateGate }
      if (typeof input.bodyText === 'string') bodyText = input.bodyText
      if (typeof input.bodyHtml === 'string') bodyHtml = input.bodyHtml
      if (typeof input.to === 'string') to = input.to
      if (typeof input.cc === 'string') cc = input.cc
      if (typeof input.bcc === 'string') bcc = input.bcc
      if (typeof input.subject === 'string') subject = input.subject
      if (Array.isArray(input.attachments)) files = input.attachments as FakeDraftFile[]
      if (options.loseFirstUpdateReply && updateCount === 1) return response.destroy()
      return response.end(JSON.stringify({ structuredContent: { draft_id: draftId ?? 'draft' } }))
    }
    response.statusCode = 404
    response.end('{}')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false, draftListLagMs: 0 })
  return { provider, createReached, releaseCreate, updateReached, releaseUpdate, get files() { return files }, get updateCount() { return updateCount }, get attachmentReadCount() { return attachmentReadCount } }
}

function conversationMessage(id: string, threadId = 'thread-large') {
  return {
    id, thread_id: threadId, label_ids: ['INBOX'], snippet: `Preview ${id}`, internal_date: '1788486120000',
    payload: { mime_type: 'text/plain', headers: [{ name: 'From', value: 'Ana <ana@example.com>' }, { name: 'To', value: 'Work <work@example.com>' }, { name: 'Subject', value: `Subject ${id}` }], body: { content: `Body ${id}` } },
  }
}

async function startThreadConnector(options: { indexedIds: string[]; returnedIds: string[]; failedReadIds?: string[]; labelsById?: Record<string,string[]>; threadError?: unknown }) {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-thread-completeness-')); directories.push(directory)
  const indexPath = join(directory, 'gmail.sqlite')
  const index = new GmailIndex(indexPath)
  const account = { id: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }
  index.replaceAccount('one', options.indexedIds.map((id) => ({
    ...projectGmailSearchEmail({ id, thread_id: 'thread-large', from_: 'Ana <ana@example.com>', subject: `Subject ${id}`, snippet: `Preview ${id}`, labels: options.labelsById?.[id]??['INBOX'], email_ts: '2026-09-30T12:00:00Z' }, account),
    ...folderFlagsFromLabels(options.labelsById?.[id]??['INBOX']),
  })), 'fixture', true)
  index.close()
  const readIds: string[] = []
  const failed = new Set(options.failedReadIds ?? [])
  const byId = new Map(options.indexedIds.map(id => [id, {...conversationMessage(id),label_ids:options.labelsById?.[id]??['INBOX']}]))
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
    if (request.url === '/v1/connectors/gmail') return response.end(JSON.stringify({ accounts: [{ linkId: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
    if (request.url === '/v1/connectors/gmail/read-thread') return response.end(JSON.stringify(options.threadError??{ structuredContent: { messages: options.returnedIds.map(id => byId.get(id)).filter(Boolean) } }))
    if (request.url === '/v1/connectors/gmail/read') {
      const messageId = String(input.messageId ?? '')
      readIds.push(messageId)
      if (failed.has(messageId)) { response.statusCode = 503; return response.end(JSON.stringify({ error: 'temporary read failure' })) }
      const message = byId.get(messageId)
      return response.end(JSON.stringify({ structuredContent: message }))
    }
    response.statusCode = 404
    response.end('{}')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const localPath = join(directory, 'mail.sqlite')
  const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath, localPath, draftListLagMs: 0 })
  return { provider, indexPath, localPath, readIds }
}

describe('GmailConnectorProvider', () => {
  it('does not present the draft identity marker as an attachment', () => {
    const input = structuredClone(gmailMessage)
    const plain = input.structuredContent.payload.parts[0] as Record<string, unknown>
    plain.headers = [{ name: 'Content-ID', value: '<dispatch-key@draft.dispatch.local>' }]
    expect(projectGmailMessage(input, true).attachments.map(file => file.name)).toEqual(['arrival.pdf'])
  })
  it.each([false, true])('appends local file bytes and verifies the saved provider copy (corrupt=%s)', async corrupt => {
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-local-attach-')); directories.push(directory)
    const path = join(directory, 'new.txt'); writeFileSync(path, 'new file bytes')
    const secondPath = join(directory, 'second', 'new.txt'); mkdirSync(join(directory, 'second')); writeFileSync(secondPath, 'different new bytes')
    let files: Array<{ filename: string; mime_type: string; data: string; contentId?: string }> = [
      { filename: 'logo.png', mime_type: 'image/png', data: Buffer.from('inline image').toString('base64'), contentId: 'logo@draft' },
      { filename: 'arrival.pdf', mime_type: 'application/pdf', data: Buffer.from('old bytes').toString('base64') },
    ]
    const plainBody = 'Keep exact plain MIME text.\nSecond line.\n'
    let written: Record<string, unknown> | undefined
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json')
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
      if (req.url === '/v1/connectors/gmail/drafts/list') return res.end(JSON.stringify({ structuredContent: { drafts: [{ draft_id: 'draft', message_id: 'gmail-message-1', thread_id: 'gmail-thread-1', subject: 'Keep', to: ['work@example.com'] }] } }))
      if (req.url === '/v1/connectors/gmail/read') return res.end(JSON.stringify({ structuredContent: { ...gmailMessage.structuredContent, payload: { ...gmailMessage.structuredContent.payload, headers: [...gmailMessage.structuredContent.payload.headers, { name: 'Bcc', value: 'Hidden <private@example.com>' }], parts: [
        { mime_type: 'text/plain', filename: '', body: { content: plainBody } },
        { mime_type: 'text/html', filename: '', body: { content: '<p><strong>Keep formatting</strong><img src="cid:logo@draft"></p>' } },
        ...files.map((file, index) => ({ mime_type: file.mime_type, filename: file.filename, headers: file.contentId ? [{ name: 'Content-ID', value: `<${file.contentId}>` }] : [], body: { attachment_id: String(index), size: 20 } })),
      ] } } }))
      if (req.url === '/v1/connectors/gmail/attachment') return res.end(JSON.stringify({ structuredContent: { data: corrupt && written && files[Number(input.attachmentId)]?.filename === 'new.txt' ? Buffer.from('wrong bytes').toString('base64') : files[Number(input.attachmentId)]?.data } }))
      if (req.url === '/v1/connectors/gmail/drafts/update') { written = input; files = input.attachments.map((file: { filename: string; mime_type: string; data: string; contentId?: string }) => ({ ...file })); return res.end(JSON.stringify({ structuredContent: { draft_id: 'draft' } })) }
      res.statusCode = 404; res.end('{}')
    })
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    const operationId = randomUUID()
    const results = corrupt
      ? [await provider.attachDraftFiles('one', 'draft', [path], operationId)]
      : await Promise.all([
        provider.attachDraftFiles('one', 'draft', [path], operationId),
        provider.attachDraftFiles('one', 'draft', [secondPath], randomUUID()),
      ])
    const result = results[0]!
    if (corrupt) {
      expect(result.syncState).toBe('pending')
      expect(result.verifiedFiles).toEqual([])
    } else {
      expect(results.every(item => item.verifiedFiles.length === 1)).toBe(true)
      expect(result.verifiedFiles[0]).toMatchObject({ name: 'new.txt', bytes: 14, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
      const current = await provider.readGmailDraft('one', 'draft', true)
      expect(current.attachments.map(file => file.name)).toEqual(['logo.png', 'arrival.pdf', 'new.txt', 'new.txt'])
      expect(files.filter(file => file.filename === 'new.txt').map(file => file.data).sort()).toEqual([
        Buffer.from('different new bytes').toString('base64'), Buffer.from('new file bytes').toString('base64'),
      ].sort())
    }
    expect(written?.bodyHtml).toBe('<p><strong>Keep formatting</strong><img src="cid:logo@draft"></p>')
    expect(written?.bodyText).toBe(plainBody)
    expect(written?.to).toBe('work@example.com, ops@example.com')
    expect(written?.cc).toBe('manager@example.com')
    expect(written?.bcc).toBe('private@example.com')
    expect(files.map(file => file.filename)).toEqual(corrupt ? ['logo.png', 'arrival.pdf', 'new.txt'] : ['logo.png', 'arrival.pdf', 'new.txt', 'new.txt'])
    provider.stopBackgroundSync()
  })

  it('durably accepts an attachment for an offline remote draft before attempting the provider read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-offline-attach-')); directories.push(directory)
    const path = join(directory, 'offline.txt'); writeFileSync(path, 'keep this offline')
    const localPath = join(directory, 'mail.sqlite')
    const provider = new GmailConnectorProvider('http://127.0.0.1:18411', { indexPath: false, localPath })
    const operationId = randomUUID()
    const result = await provider.attachDraftFiles('one', 'remote-draft', [path], operationId)
    expect(result).toMatchObject({ operationId, syncState: 'pending', verifiedFiles: [] })
    expect(result.draft.attachments).toEqual([expect.objectContaining({ name: 'offline.txt', contentBase64: Buffer.from('keep this offline').toString('base64') })])
    provider.stopBackgroundSync()

    const restarted = new GmailConnectorProvider('http://127.0.0.1:18411', { indexPath: false, localPath })
    await expect(restarted.readGmailDraft('one', result.draft.id)).resolves.toMatchObject({ syncState: 'pending', attachments: [expect.objectContaining({ name: 'offline.txt' })] })
    restarted.stopBackgroundSync()
  })

  it('retries a lost Gmail update response with the same operation ID without duplicating the file', async () => {
    const fixture = await startAttachmentConnector({ loseFirstUpdateReply: true })
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-lost-attach-')); directories.push(directory)
    const path = join(directory, 'once.txt'); writeFileSync(path, 'only one copy')
    const operationId = randomUUID()
    const first = await fixture.provider.attachDraftFiles('one', 'draft', [path], operationId)
    expect(first.syncState).toBe('pending')
    expect(fixture.files.filter(file => file.filename === 'once.txt')).toHaveLength(1)

    const retried = await fixture.provider.attachDraftFiles('one', 'draft', [path], operationId)
    expect(retried.syncState).toBeUndefined()
    expect(retried.verifiedFiles).toMatchObject([{ name: 'once.txt', bytes: 13 }])
    expect(fixture.updateCount).toBe(1)
    expect(fixture.files.filter(file => file.filename === 'once.txt')).toHaveLength(1)
    fixture.provider.stopBackgroundSync()
  })

  it('confirms and deduplicates a zero-byte attachment by its empty-byte hash', async () => {
    const fixture = await startAttachmentConnector({ loseFirstUpdateReply: true })
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-empty-attach-')); directories.push(directory)
    const path = join(directory, 'empty.txt'); writeFileSync(path, Buffer.alloc(0))
    const operationId = randomUUID()
    const first = await fixture.provider.attachDraftFiles('one', 'draft', [path], operationId)
    expect(first.syncState).toBe('pending')
    const retried = await fixture.provider.attachDraftFiles('one', 'draft', [path], operationId)
    expect(retried.syncState).toBeUndefined()
    expect(retried.verifiedFiles).toEqual([{ name: 'empty.txt', bytes: 0, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(fixture.updateCount).toBe(1)
    expect(fixture.files.filter(file => file.filename === 'empty.txt')).toHaveLength(1)
    expect(fixture.files[0]?.data).toBe('')
    fixture.provider.stopBackgroundSync()
  })

  it('confirms an empty Gmail MIME file without a download ID and never requests a nonexistent attachment', async () => {
    const fixture = await startAttachmentConnector({ emptyFileWithoutDownloadId: true })
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-embedded-empty-')); directories.push(directory)
    const path = join(directory, 'empty.txt'); writeFileSync(path, Buffer.alloc(0))
    const operationId = randomUUID()
    const result = await fixture.provider.attachDraftFiles('one', 'draft', [path], operationId)
    expect(result.syncState).toBeUndefined()
    expect(result.verifiedFiles).toEqual([{ name: 'empty.txt', bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }])
    expect(result.draft.attachments).toMatchObject([{ name: 'empty.txt', contentBase64: '' }])
    expect(fixture.attachmentReadCount).toBe(0)
    const repeated = await fixture.provider.attachDraftFiles('one', 'draft', [path], operationId)
    expect(repeated.syncState).toBeUndefined()
    expect(fixture.updateCount).toBe(1)
    fixture.provider.stopBackgroundSync()
  })

  it('does not confirm an empty MIME attachment when Gmail omits its content', async () => {
    const fixture = await startAttachmentConnector({ emptyFileWithoutDownloadId: true, omitEmptyFileContent: true })
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-missing-empty-')); directories.push(directory)
    const path = join(directory, 'empty.txt'); writeFileSync(path, Buffer.alloc(0))
    const result = await fixture.provider.attachDraftFiles('one', 'draft', [path], randomUUID())
    expect(result.syncState).toBe('pending')
    expect(result.verifiedFiles).toEqual([])
    expect(fixture.attachmentReadCount).toBe(0)
    fixture.provider.stopBackgroundSync()
  })

  it('does not report an applied attachment operation as verified after a later save removes the file', async () => {
    const fixture = await startAttachmentConnector()
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-removed-attach-')); directories.push(directory)
    const path = join(directory, 'once.txt'); writeFileSync(path, 'only one copy')
    const operationId = randomUUID()
    const first = await fixture.provider.attachDraftFiles('one', 'draft', [path], operationId)
    expect(first.verifiedFiles).toHaveLength(1)

    fixture.provider.enqueueDraftSave('one', '', { attachments: [] }, 'draft')
    await fixture.provider.flushDraftSaves('one')
    expect(fixture.files).toEqual([])
    await expect(fixture.provider.attachDraftFiles('one', 'draft', [path], operationId)).rejects.toMatchObject({ code: 'draft_attachment_not_present' })
    expect(fixture.updateCount).toBe(2)
    fixture.provider.stopBackgroundSync()
  })

  it('does not let a stale editor attachment replacement erase an accepted append', async () => {
    const fixture = await startAttachmentConnector({ pauseUpdate: true })
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-stale-attach-')); directories.push(directory)
    const path = join(directory, 'append.txt'); writeFileSync(path, 'survive stale replacement')
    const baseline = await fixture.provider.readGmailDraft('one', 'draft', true)
    const attaching = fixture.provider.attachDraftFiles('one', 'draft', [path], randomUUID())
    await fixture.updateReached
    fixture.provider.enqueueDraftSave('one', '', { attachments: baseline.attachments, subject: 'Edited subject' }, 'draft', undefined, baseline)
    fixture.releaseUpdate()
    const result = await attaching
    await fixture.provider.flushDraftSaves('one')
    expect(result.verifiedFiles).toHaveLength(1)
    expect(fixture.files.map(file => file.filename)).toEqual(['append.txt'])
    const saved = await fixture.provider.readGmailDraft('one', 'draft', true)
    expect(saved.subject).toBe('Edited subject')
    expect(saved.attachments.map(file => file.name)).toEqual(['append.txt'])
    fixture.provider.stopBackgroundSync()
  })

  it('attaches to a queued creation ID and resolves it after Gmail creates the draft', async () => {
    const fixture = await startAttachmentConnector({ pauseCreate: true })
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-queued-attach-')); directories.push(directory)
    const path = join(directory, 'queued.txt'); writeFileSync(path, 'attached before remote ID')
    const clientDraftId = randomUUID()
    const queued = fixture.provider.enqueueDraftSave('one', '', { to: 'work@example.com', subject: 'Keep' }, undefined, clientDraftId)
    const attaching = fixture.provider.attachDraftFiles('one', queued.id, [path], randomUUID())
    void attaching.catch(() => undefined)
    try {
      await fixture.createReached
      // Creation and local file staging are independent. Wait for the append's durable
      // acceptance before submitting the editor snapshot; reaching Create is not that ACK.
      await expect.poll(async () => (await fixture.provider.readGmailDraft('one', queued.id)).attachments.map(file => file.name)).toEqual(['queued.txt'])
      // Simulate an editor autosave that still submits the empty attachment array from its original snapshot.
      fixture.provider.enqueueDraftSave('one', '', { attachments: [] }, queued.id, undefined, queued)
      expect(fixture.files).toEqual([])
      fixture.releaseCreate()
      const result = await attaching
      expect(result.syncState).toBeUndefined()
      expect(result.draft).toMatchObject({ id: 'remote-created', resolvedFromDraftId: queued.id })
      expect(fixture.files.map(file => file.filename)).toEqual(['queued.txt'])
      expect(fixture.updateCount).toBe(1)
    } finally {
      fixture.releaseCreate()
      fixture.provider.stopBackgroundSync()
    }
  })

  it('projects Gmail headers, MIME, attachments, and stable identity', () => {
    expect(projectGmailMessage(gmailMessage, true)).toMatchObject({
      id: 'gmail-message-1', threadId: 'gmail-thread-1', subject: 'Berth confirmation', unread: true,
      sender: { name: 'Ana Morales', address: 'ana@example.com', initials: 'AM' },
      to: [{ name: 'Steve', address: 'work@example.com' }, { name: 'Ops', address: 'ops@example.com' }],
      cc: [{ name: 'Manager', address: 'manager@example.com' }],
      body: { kind: 'sanitized-html', content: '<p>Hello.</p>' },
      attachments: [{ id: 'a1', name: 'arrival.pdf', sizeLabel: '824 KB' }], source: 'gmail',
    })
    expect(projectGmailMessage({ structuredContent: { ...gmailMessage.structuredContent, label_ids: null } }, true)).toMatchObject({ id: 'gmail-message-1', unread: false })
  })

  it('supplements a 100-message thread with only indexed message IDs missing from the capped response', async () => {
    const indexedIds = Array.from({ length: 101 }, (_, index) => `large-${index}`)
    const fixture = await startThreadConnector({ indexedIds, returnedIds: indexedIds.slice(0, 100) })
    const conversation = await fixture.provider.readConversation('one', 'thread-large')
    expect(fixture.readIds).toEqual(['large-100'])
    expect(conversation.messages).toHaveLength(101)
    expect(conversation.completeness).toMatchObject({ complete: false, knownCount: 101, loadedCount: 101 })
    expect(conversation.completeness?.reason).toContain('lower bound')
    fixture.provider.stopBackgroundSync()
  })

  it('does not make per-message reads for a short complete thread', async () => {
    const indexedIds = ['short-1', 'short-2']
    const fixture = await startThreadConnector({ indexedIds, returnedIds: indexedIds })
    const conversation = await fixture.provider.readConversation('one', 'thread-large')
    expect(fixture.readIds).toEqual([])
    expect(conversation.completeness).toMatchObject({ complete: true, knownCount: 2, loadedCount: 2 })
    fixture.provider.stopBackgroundSync()
  })

  it.each([{labels:['SENT']}, {labels:[]}])('reviews eligible non-Inbox mail live and from its complete cache ($labels)', async ({labels}) => {
    const fixture=await startThreadConnector({indexedIds:['eligible'],returnedIds:['eligible'],labelsById:{eligible:labels}})
    expect((await fixture.provider.readWorkConversation('one','thread-large')).messages.map(m=>m.id)).toEqual(['eligible'])
    expect((await fixture.provider.readWorkConversation('one','thread-large')).availability?.mode).toBe('downloaded')
    fixture.provider.stopBackgroundSync()
  })

  it.each(['SPAM','TRASH','DRAFT'])('reports a thread containing only %s as unavailable work evidence',async label=>{
    const fixture=await startThreadConnector({indexedIds:['excluded'],returnedIds:['excluded'],labelsById:{excluded:[label]}})
    await expect(fixture.provider.readWorkConversation('one','thread-large')).rejects.toMatchObject({code:'work_evidence_unavailable'})
    fixture.provider.stopBackgroundSync()
  })

  it.each([
    {error_code:'NOT_FOUND',error_data:{type:'http_error',code:404},missing:true},
    {error_code:'NOT_FOUND',error_data:{type:'http_error',response:{status:404}},missing:true},
    {error_code:'NOT_FOUND',error_data:{type:'http_error',code:403},missing:false},
    {error_code:'NOT_FOUND',error_data:{type:'http_error',code:503},missing:false},
    {error_code:'NOT_FOUND',error_data:{type:'connection_error',code:404},missing:false},
    {error_code:'OTHER',error_data:{type:'http_error',code:404},missing:false},
  ])('retires only structured Gmail thread 404 evidence ($error_code, $error_data)',async({missing,...error})=>{
    const fixture=await startThreadConnector({indexedIds:['missing'],returnedIds:[],threadError:{isError:true,structuredContent:{error:'HTTP status: 404 not found',...error}}})
    try {
      if(missing)await expect(fixture.provider.readWorkConversation('one','thread-large')).rejects.toMatchObject({code:'work_evidence_unavailable'})
      else await expect(fixture.provider.readWorkConversation('one','thread-large')).rejects.not.toMatchObject({code:'work_evidence_unavailable'})
    } finally {fixture.provider.stopBackgroundSync()}
  })

  it('retains eligible replies when other messages in the thread are excluded',async()=>{
    const fixture=await startThreadConnector({indexedIds:['sent','trash','spam','draft'],returnedIds:['sent','trash','spam','draft'],labelsById:{sent:['SENT'],trash:['TRASH'],spam:['SPAM'],draft:['DRAFT']}})
    expect((await fixture.provider.readWorkConversation('one','thread-large')).messages.map(m=>m.id)).toEqual(['sent'])
    fixture.provider.stopBackgroundSync()
  })

  it('keeps a complete cache when a capped thread supplement fails and does not mark a partial download complete', async () => {
    const indexedIds = Array.from({ length: 101 }, (_, index) => `partial-${index}`)
    const fixture = await startThreadConnector({ indexedIds, returnedIds: indexedIds.slice(0, 100), failedReadIds: ['partial-100'] })
    const account = { id: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }
    const oldComplete = {
      ...projectConversation(indexedIds.map(id => projectGmailMessage({ structuredContent: conversationMessage(id) }, true, account)), 'gmail'),
      completeness: { complete: true, knownCount: 101, loadedCount: 101 },
    }
    const store = new LocalMailStore(fixture.localPath)
    store.cache(oldComplete)
    store.close()

    const partial = await fixture.provider.readConversation('one', 'thread-large')
    expect(partial.messages).toHaveLength(100)
    expect(partial.completeness).toMatchObject({ complete: false, knownCount: 101, loadedCount: 100 })
    expect(partial.completeness?.reason).toContain('could not be loaded')
    const checked = new LocalMailStore(fixture.localPath)
    expect(checked.conversation('one', 'thread-large')?.conversation).toMatchObject({ completeness: { complete: true, loadedCount: 101 }, messages: expect.arrayContaining([expect.objectContaining({ id: 'partial-100' })]) })
    checked.close()
    fixture.provider.stopBackgroundSync()

    const partialDownload = await startThreadConnector({ indexedIds, returnedIds: indexedIds.slice(0, 100), failedReadIds: ['partial-100'] })
    partialDownload.provider.startOfflineDownload('inbox', 'one')
    for (let attempt = 0; attempt < 100 && partialDownload.provider.offlineStatus().download?.state === 'running'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
    expect(partialDownload.provider.offlineStatus().download).toMatchObject({ state: 'partial', completed: 0, errors: [expect.stringContaining('could not be loaded')] })
    expect(partialDownload.provider.downloadedConversations('inbox', 'all', 'one')[0]?.downloaded).toBe(false)
    partialDownload.provider.stopBackgroundSync()
  })

  it('rewrites cid images to the mail attachment URL', () => {
    const projected = projectGmailMessage({
      structuredContent: {
        ...gmailMessage.structuredContent,
        payload: {
          ...gmailMessage.structuredContent.payload,
          parts: [
            { part_id: 'html', mime_type: 'text/html', filename: '', body: { content: '<p><img src="cid:logo@mail"></p>' } },
            { part_id: 'img', mime_type: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-ID', value: '<logo@mail>' }], body: { size: 1200, attachment_id: 'img-1' } },
          ],
        },
      },
    }, true, { id: 'link-one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' })
    expect(projected.body.content).toContain('http://127.0.0.1:8411/v1/messages/gmail-message-1/attachments/img-1?account=link-one&filename=logo.png')
    expect(projected.attachments).toEqual([
      expect.objectContaining({ id: 'img-1', name: 'logo.png', contentId: 'logo@mail' }),
    ])
  })

  it('projects bounded Gmail search results without a second read call', () => {
    expect(projectGmailSearchEmail({
      id: 'm1', thread_id: 't1', from_: 'Ana <ana@example.com>', subject: 'Hello', snippet: 'Preview', labels: ['INBOX', 'UNREAD'], email_ts: '2026-09-03T21:42:00Z',
    }, { id: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' })).toMatchObject({
      id: 'm1', threadId: 't1', unread: true, accountId: 'one', receivedAt: '2026-09-03T21:42:00.000Z', sender: { name: 'Ana', address: 'ana@example.com' },
    })
    expect(projectGmailSearchEmail({
      id: 'm2', thread_id: 't2', from_: 'Daniel Campbell daniel@example.com', subject: 'Hello', labels: ['INBOX'], email_ts: '2026-09-03T21:42:00Z',
    }, { id: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' })).toMatchObject({ sender: { name: 'Daniel Campbell', address: 'daniel@example.com' } })
  })

  it('rejects missing state labels and invalid timestamps during normalization', () => {
    const account = { id: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }
    expect(() => projectGmailSearchEmail({
      id: 'm1', thread_id: 't1', from_: 'Ana <ana@example.com>', email_ts: '2026-09-03T21:42:00Z',
    }, account)).toThrow('missing labels')
    expect(() => projectGmailSearchEmail({
      id: 'm1', thread_id: 't1', from_: 'Ana <ana@example.com>', labels: ['INBOX'], email_ts: 'not-a-date',
    }, account)).toThrow('invalid or missing received timestamp')
  })

  it('reads the message when a search result has no email_ts instead of failing the whole page', async () => {
    const reads: string[] = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messageId?: string } : {}
      if (request.url === '/v1/connectors/gmail') return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      if (request.url === '/v1/connectors/gmail/search-messages') {
        return response.end(JSON.stringify({ structuredContent: { emails: [
          { id: 'sent-ok', thread_id: 't-ok', from_: 'Steve <work@example.com>', subject: 'Normal', snippet: '', labels: ['SENT'], email_ts: '2026-09-03T21:42:00Z' },
          { id: 'sent-accept', thread_id: 't-accept', from_: 'Steve <work@example.com>', subject: 'Event accepted: Quick meeting', snippet: '', labels: ['SENT'], email_ts: '' },
        ] } }))
      }
      if (request.url === '/v1/connectors/gmail/read') {
        reads.push(body.messageId ?? '')
        return response.end(JSON.stringify({ structuredContent: { ...gmailMessage.structuredContent, id: 'sent-accept', thread_id: 't-accept', internal_date: '1788486120000' } }))
      }
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    const messages = await provider.listMessages('link-one', 10)
    expect(reads).toEqual(['sent-accept'])
    expect(messages.map((message) => [message.id, message.receivedAt])).toEqual([
      ['sent-ok', '2026-09-03T21:42:00.000Z'],
      ['sent-accept', new Date(1788486120000).toISOString()],
    ])
  })

  it('reads an attachment by id only so duplicate filenames stay unambiguous', async () => {
    const bodies: Record<string, unknown>[] = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      let raw = ''
      for await (const chunk of request) raw += chunk
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      response.end(JSON.stringify({ structuredContent: { mime_type: 'image/png', data: 'cG5n' } }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    await provider.readAttachment('link-one', 'm1', 'att-long-id', 'image.png')
    expect(bodies).toEqual([{ linkId: 'link-one', messageId: 'm1', attachmentId: 'att-long-id' }])
  })

  it('names the message and account when no timestamp exists even after reading it', async () => {
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      for await (const _chunk of request) { /* drain */ }
      if (request.url === '/v1/connectors/gmail') return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      if (request.url === '/v1/connectors/gmail/search-messages') {
        return response.end(JSON.stringify({ structuredContent: { emails: [
          { id: 'sent-accept', thread_id: 't-accept', from_: 'Steve <work@example.com>', subject: 'Event accepted', snippet: '', labels: ['SENT'], email_ts: '' },
        ] } }))
      }
      if (request.url === '/v1/connectors/gmail/read') {
        const { internal_date: _drop, ...rest } = gmailMessage.structuredContent
        return response.end(JSON.stringify({ structuredContent: { ...rest, id: 'sent-accept', thread_id: 't-accept', payload: { ...rest.payload, headers: rest.payload.headers.filter((header) => header.name !== 'Date') } } }))
      }
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    await expect(provider.listMessages('link-one', 10)).rejects.toThrow(/sent-accept.*work@example\.com.*invalid or missing received timestamp/)
  })

  it('uses the agent service instead of reading connector state directly', async () => {
    const searches: Array<{ query?: string; labelIds?: string[] }> = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      if (request.url === '/v1/connectors/gmail/search-messages') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        searches.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query?: string; labelIds?: string[] })
        return response.end(JSON.stringify({ structuredContent: { emails: [{
          id: 'gmail-message-1', thread_id: 'gmail-thread-1', from_: 'Ana Morales <ana@example.com>', subject: 'Berth confirmation', snippet: 'A short preview', labels: ['INBOX', 'UNREAD'], email_ts: '2026-09-03T21:42:00Z',
        }] } }))
      }
      if (request.url === '/v1/connectors/gmail/modify') return response.end(JSON.stringify({ ok: true }))
      if (request.url === '/v1/connectors/gmail/read-thread') return response.end(JSON.stringify({ structuredContent: { messages: [gmailMessage.structuredContent] } }))
      if (request.url === '/v1/connectors/gmail/read') return response.end(JSON.stringify(gmailMessage))
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    expect(await provider.accounts()).toEqual([{ id: 'link-one', connectorId: '', name: 'Work', email: 'work@example.com' }])
    expect(await provider.listMessages('link-one', 1)).toHaveLength(1)
    await provider.listConversations('link-one', 'all', 1)
    await provider.listConversations('link-one', 'unread', 1)
    await provider.listConversations('link-one', 'read', 1)
    expect(searches).toEqual([
      expect.objectContaining({ query: '-in:spam -in:trash', labelIds: ['INBOX'] }),
      expect.objectContaining({ query: 'in:inbox -in:spam -in:trash -in:drafts', labelIds: ['INBOX'] }),
      expect.objectContaining({ query: 'in:inbox is:unread -in:spam -in:trash -in:drafts', labelIds: ['INBOX', 'UNREAD'] }),
      expect.objectContaining({ query: 'in:inbox is:read -in:spam -in:trash', labelIds: ['INBOX'] }),
    ])
    expect(await provider.readMessage('link-one', 'gmail-message-1')).toMatchObject({ id: 'gmail-message-1', source: 'gmail' })
    expect(await provider.readConversation('link-one', 'gmail-thread-1')).toMatchObject({ threadId: 'gmail-thread-1', messageCount: 1, source: 'gmail' })
  })

  it('paginates Gmail into the durable index and serves the indexed result', async () => {
    const requests: Array<{ labelIds?: string[]; nextPageToken?: string }> = []
    let failSearch = false
    let failInventory = false
    const server = createServer(async (request, response) => {
      answerIdsFromDetails(request, response)
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') {
        if (failInventory) {
          response.statusCode = 502
          return response.end(JSON.stringify({ error: 'inventory_failed' }))
        }
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
      }
      if (request.url === '/v1/connectors/gmail/search-messages') {
        if (failSearch) {
          response.statusCode = 502
          return response.end(JSON.stringify({ error: 'connector_failed' }))
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { labelIds?: string[]; nextPageToken?: string }
        requests.push(payload)
        // m3 is archived and unread: Gmail lists it under Unread and under the label-less Archive query.
        const unread = (payload.labelIds?.includes('UNREAD') === true && payload.labelIds.includes('INBOX') !== true) || payload.labelIds?.length === 0
        const inbox = payload.labelIds?.includes('INBOX') === true
        const second = payload.nextPageToken === 'page-2'
        const emails = unread
          ? [{ id: 'm3', thread_id: 't3', from_: 'Cara <cara@example.com>', subject: 'Archived unread', snippet: 'Three', labels: ['UNREAD'], email_ts: '2026-09-04T07:00:00Z' }]
          : inbox
            ? [{ id: second ? 'm2' : 'm1', thread_id: second ? 't2' : 't1', from_: 'Ana <ana@example.com>', subject: second ? 'Unread' : 'Inbox', snippet: 'One', labels: second ? ['INBOX', 'UNREAD'] : ['INBOX'], email_ts: second ? '2026-09-04T08:00:00Z' : '2026-09-04T09:00:00Z' }]
            : []
        return response.end(JSON.stringify({ structuredContent: { emails, next_page_token: inbox && !second ? 'page-2' : '' } }))
      }
      if (request.url === '/v1/connectors/gmail/modify') return response.end(JSON.stringify({ ok: true }))
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-sync-'))
    directories.push(directory)
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: join(directory, 'gmail.sqlite') })
    await provider.syncNow()
    expect(provider.syncStatus()).toMatchObject({ state: 'ready', messageCount: 3 })
    expect(await provider.listUnifiedConversations('all')).toHaveLength(2)
    expect(await provider.listUnifiedConversations('unread')).toHaveLength(1)
    await provider.setConversationUnread('link-one', 't2', false)
    expect(await provider.listUnifiedConversations('unread')).toHaveLength(0)
    expect(requests.filter((request) => request.labelIds?.includes('INBOX'))).toHaveLength(2)
    expect(requests.filter((request) => request.labelIds?.includes('UNREAD') === true && request.labelIds.includes('INBOX') !== true)).toHaveLength(1)
    expect(requests.some((request) => request.nextPageToken === 'page-2')).toBe(true)
    await provider.refreshNow()
    // A refresh after a full sync lists IDs and reads only what the index does not match: one page here.
    expect(provider.syncStatus()).toMatchObject({ state: 'ready', messageCount: 3, pagesFetched: 1 })
    expect(await provider.listUnifiedConversations('all')).toHaveLength(2)
    expect(await provider.listUnifiedConversations('unread')).toHaveLength(0)
    failSearch = true
    await expect(provider.syncNow()).rejects.toThrow('Gmail connector request failed (502)')
    expect(provider.syncStatus()).toMatchObject({ state: 'failed', messageCount: 3 })
    await expect(provider.listUnifiedConversations('all')).resolves.toHaveLength(2)
    failInventory = true
    await expect(provider.accounts()).resolves.toMatchObject([{ id: 'link-one', email: 'work@example.com' }])
    expect(provider.syncStatus()).toMatchObject({ state: 'failed', error: expect.stringContaining('Gmail account refresh failed') })
    provider.stopBackgroundSync()
  })

  it('merges folder flags from multiple streams and treats system labels as not archive', () => {
    const base = {
      id: 'm1', threadId: 't1', accountId: 'one', accountLabel: 'Work',
      sender: { name: 'Ana', address: 'ana@example.com', initials: 'A' },
      subject: 'Hello', receivedAt: '2026-09-06T01:00:00Z', receivedLabel: 'x', receivedFullLabel: 'x',
      preview: '', unread: false, inInbox: false, inSent: false, inDrafts: false,
      inArchive: false, inSpam: false, inTrash: false,
    }
    expect(mergeIndexedMessages([
      { ...base, inInbox: true },
      { ...base, inSent: true, inArchive: true },
    ])).toMatchObject([{ id: 'm1', inInbox: true, inSent: true, inArchive: false }])
  })

  it('lists Sent from the index and does not live-search folders', async () => {
    const searches: Array<{ query?: string; labelIds?: string[] }> = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
      }
      if (request.url === '/v1/connectors/gmail/search-messages') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query?: string; labelIds?: string[] }
        searches.push(payload)
        const emails = payload.labelIds?.includes('SENT')
          ? Array.from({ length: 51 }, (_, offset) => ({
              id: `sent-${offset}`, thread_id: `thread-sent-${offset}`, from_: 'Ana <ana@example.com>',
              subject: `Sent ${offset}`, snippet: '', labels: ['SENT'],
              email_ts: `2026-09-06T01:${String(offset).padStart(2, '0')}:00Z`,
            }))
          : []
        return response.end(JSON.stringify({ structuredContent: { emails } }))
      }
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-folder-'))
    directories.push(directory)
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      indexPath: join(directory, 'gmail.sqlite'),
    })
    await provider.syncNow()
    const before = searches.length
    const sent = await provider.listMailboxConversations('sent', 'all', 'link-one')
    expect(sent).toHaveLength(51)
    expect(searches.length).toBe(before)
    provider.stopBackgroundSync()
  })

  it('fails folder lists when the durable index is missing', async () => {
    const provider = new GmailConnectorProvider('http://127.0.0.1:9', { indexPath: false })
    await expect(provider.listMailboxConversations('sent', 'all', 'link-one')).rejects.toThrow(
      'Durable Gmail index is required for mailbox lists',
    )
  })

  it('persists compose attachments on Gmail draft create and update', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push({ path: request.url ?? '', body })
      if (request.url === '/v1/connectors/gmail/drafts/create') {
        return response.end(JSON.stringify({ structuredContent: { draft_id: 'draft-1' } }))
      }
      if (request.url === '/v1/connectors/gmail/drafts/update') return response.end(JSON.stringify({ ok: true }))
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    await expect(provider.createGmailDraft('link-one', 'message-1', 'to@example.com', '', '', 'Hello', '**Hi**', [
      { id: 'attachment-1', name: 'arrival.pdf', mediaType: 'application/pdf' },
    ])).rejects.toMatchObject({
      message: 'Gmail draft attachment is missing file bytes',
      code: 'gmail_attachment_bytes_required',
    })
    const created = await provider.createGmailDraft('link-one', 'message-1', 'to@example.com', '', '', 'Hello', '**Hi**', [
      { name: 'arrival.pdf', mediaType: 'application/pdf', contentBase64: 'cGRm' },
    ])
    expect(created).toMatchObject({ id: 'draft-1', attachments: [{ name: 'arrival.pdf', mediaType: 'application/pdf' }] })
    await provider.updateGmailDraft(projectDraft({ ...created, subject: 'Updated', bodyMarkdown: '_Updated_' }))
    expect(requests).toEqual([
      expect.objectContaining({
        path: '/v1/connectors/gmail/drafts/create',
        body: expect.objectContaining({
          attachments: [{ filename: 'arrival.pdf', mime_type: 'application/pdf', data: 'cGRm' }],
        }),
      }),
      expect.objectContaining({
        path: '/v1/connectors/gmail/drafts/update',
        body: expect.objectContaining({
          attachments: [{ filename: 'arrival.pdf', mime_type: 'application/pdf', data: 'cGRm' }],
        }),
      }),
    ])
  })

  it('loads Forward attachment bytes from the source Gmail message', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push({ path: request.url ?? '', body })
      if (request.url === '/v1/connectors/gmail/attachment') {
        return response.end(JSON.stringify({ structuredContent: { filename: 'arrival.pdf', mime_type: 'application/pdf', data: 'cGRm' } }))
      }
      if (request.url === '/v1/connectors/gmail/drafts/create') {
        return response.end(JSON.stringify({ structuredContent: { draft_id: 'draft-fwd' } }))
      }
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    const draft = await provider.createGmailDraft('link-one', '', 'to@example.com', '', '', 'Fwd: Hello', 'Forwarded', [
      { id: 'a1', name: 'arrival.pdf', mediaType: 'application/pdf', sourceMessageId: 'gmail-message-1' },
    ])
    expect(draft.id).toBe('draft-fwd')
    expect(requests).toEqual([
      expect.objectContaining({
        path: '/v1/connectors/gmail/attachment',
        body: { linkId: 'link-one', messageId: 'gmail-message-1', attachmentId: 'a1' },
      }),
      expect.objectContaining({
        path: '/v1/connectors/gmail/drafts/create',
        body: expect.objectContaining({
          attachments: [{ filename: 'arrival.pdf', mime_type: 'application/pdf', data: 'cGRm' }],
        }),
      }),
    ])
  })

  it.each(['string', 'array'] as const)('opens an existing Gmail draft with %s recipient fields', async (format) => {
    const recipients = (address: string) => format === 'array' ? [address] : address
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push({ path: request.url ?? '', body })
      if (request.url === '/v1/connectors/gmail/drafts/list') {
        const second = body.nextPageToken === 'page-2'
        return response.end(JSON.stringify({ structuredContent: {
          drafts: second
            ? [{ draft_id: 'draft-opened', message_id: 'gmail-message-1', thread_id: 'gmail-thread-1', to: recipients('client@example.com'), cc: recipients('copy@example.com'), bcc: recipients('audit@example.com'), subject: 'Saved draft' }]
            : [{ draft_id: 'other-draft', message_id: 'other-message', thread_id: 'other-thread', to: 'other@example.com', subject: 'Other' }],
          next_page_token: second ? '' : 'page-2',
        } }))
      }
      if (request.url === '/v1/connectors/gmail/read') return response.end(JSON.stringify(gmailDraftMessage))
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    const draft = await provider.openGmailDraft('link-one', 'gmail-message-1')
    expect(draft).toMatchObject({
      id: 'draft-opened',
      inReplyToMessageId: 'gmail-message-1',
      to: [{ address: 'client@example.com' }],
      cc: 'copy@example.com',
      bcc: 'audit@example.com',
      subject: 'Saved draft',
      bodyMarkdown: 'Hello.',
      attachments: [],
    })
    expect(requests.map((request) => request.path)).toEqual([
      '/v1/connectors/gmail/drafts/list',
      '/v1/connectors/gmail/drafts/list',
      '/v1/connectors/gmail/read',
    ])
    expect(requests).not.toContainEqual(expect.objectContaining({ path: '/v1/connectors/gmail/drafts/create' }))
    // After Codex updates a draft its message id changes; the thread id still finds it.
    const byThread = await provider.openGmailDraft('link-one', 'stale-message-id-after-codex-update', 'gmail-thread-1')
    expect(byThread.id).toBe('draft-opened')
  })

  it('opens a listed Gmail draft that already has attachments', async () => {
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      }
      if (request.url === '/v1/connectors/gmail/drafts/list') {
        return response.end(JSON.stringify({ structuredContent: { drafts: [{
          draft_id: 'draft-attached', message_id: 'gmail-message-1', thread_id: 'gmail-thread-1',
          to: 'client@example.com', subject: 'Saved draft', has_attachment: true,
        }] } }))
      }
      if (request.url === '/v1/connectors/gmail/read') return response.end(JSON.stringify(gmailMessage))
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    await expect(provider.openGmailDraft('link-one', 'gmail-message-1')).resolves.toMatchObject({
      id: 'draft-attached',
      attachments: [{ id: 'a1', name: 'arrival.pdf', mediaType: 'application/pdf' }],
    })
  })

  it('refreshes a Gmail draft whose read message includes attachments', async () => {
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail/drafts/list') {
        return response.end(JSON.stringify({ structuredContent: { drafts: [{
          draft_id: 'draft-1', message_id: 'gmail-message-1', thread_id: 'gmail-thread-1',
          to: 'client@example.com', subject: 'Saved draft',
        }] } }))
      }
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      }
      if (request.url === '/v1/connectors/gmail/read') return response.end(JSON.stringify(gmailMessage))
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    await expect(provider.readGmailDraft('link-one', 'draft-1')).resolves.toMatchObject({
      id: 'draft-1',
      attachments: [{ id: 'a1', name: 'arrival.pdf', mediaType: 'application/pdf' }],
    })
  })

  it('refreshes a Gmail draft from the connector instead of returning stale local state', async () => {
    let listedSubject = 'Original subject'
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail/drafts/create') {
        return response.end(JSON.stringify({ structuredContent: { draft_id: 'draft-1' } }))
      }
      if (request.url === '/v1/connectors/gmail/drafts/list') {
        return response.end(JSON.stringify({ structuredContent: { drafts: [{
          draft_id: 'draft-1', message_id: 'gmail-message-1', thread_id: 'gmail-thread-1',
          to: 'client@example.com', cc: '', bcc: '', subject: listedSubject,
        }] } }))
      }
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      }
      if (request.url === '/v1/connectors/gmail/read') return response.end(JSON.stringify(gmailDraftMessage))
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    await provider.createGmailDraft('link-one', '', 'old@example.com', '', '', 'Local subject', 'Local body')
    listedSubject = 'Codex revised subject'

    await expect(provider.readGmailDraft('link-one', 'draft-1')).resolves.toMatchObject({
      id: 'draft-1',
      subject: 'Codex revised subject',
      bodyMarkdown: 'Hello.',
    })
  })

  it('keeps folder rows when archiving and refreshes the index after draft writes', async () => {
    const searches: Array<{ query?: string; labelIds?: string[] }> = []
    const server = createServer(async (request, response) => {
      answerIdsFromDetails(request, response)
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
      }
      if (request.url === '/v1/connectors/gmail/search-messages') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        searches.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query?: string; labelIds?: string[] })
        return response.end(JSON.stringify({ structuredContent: { emails: [{
          id: 'm1', thread_id: 't1', from_: 'Ana <ana@example.com>', subject: 'Inbox', snippet: '',
          labels: ['INBOX'], email_ts: '2026-09-06T02:00:00Z',
        }] } }))
      }
      if (request.url === '/v1/connectors/gmail/archive') return response.end(JSON.stringify({ ok: true }))
      if (request.url === '/v1/connectors/gmail/drafts/create') {
        return response.end(JSON.stringify({ structuredContent: { draft_id: 'draft-1' } }))
      }
      if (request.url === '/v1/connectors/gmail/drafts/update'
        || request.url === '/v1/connectors/gmail/drafts/discard'
        || request.url === '/v1/connectors/gmail/drafts/send'
        || request.url === '/v1/connectors/gmail/drafts/list') {
        return response.end(JSON.stringify({
          structuredContent: {
            drafts: [{
              draft_id: 'draft-1', message_id: 'm1', thread_id: 't1',
              to: '', cc: '', bcc: '', subject: 'Inbox',
            }],
          },
        }))
      }
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-mutate-'))
    directories.push(directory)
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      indexPath: join(directory, 'gmail.sqlite'),
    })
    await provider.syncNow()
    await provider.mutateConversation('link-one', 't1', ['m1'], 'archive')
    expect(await provider.listMailboxConversations('archive', 'all', 'link-one')).toHaveLength(1)
    expect(await provider.listMailboxConversations('inbox', 'all', 'link-one')).toHaveLength(0)

    const before = searches.length
    await provider.createGmailDraft('link-one', '', 'client@example.com', '', '', 'Subject', 'Body')
    await provider.discardGmailDraft('link-one', 'draft-1')
    expect(searches.length).toBe(before)
    await provider.sendGmailDraft('link-one', 'draft-1')
    await provider.refreshNow()
    expect(searches.length).toBeGreaterThan(before)
    provider.stopBackgroundSync()
  })

  it('fails a complete sync when one folder stream exceeds 100 pages', async () => {
    let sentPage = 0
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/connectors/gmail') {
        return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
      }
      if (request.url === '/v1/connectors/gmail/search-messages') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { labelIds?: string[] }
        const looping = payload.labelIds?.includes('SENT') === true
        if (looping) sentPage += 1
        return response.end(JSON.stringify({
          structuredContent: {
            emails: looping ? [{
              id: `sent-${sentPage}`, thread_id: 't-sent', from_: 'Ana <ana@example.com>', subject: 'Sent',
              snippet: '', labels: ['SENT'], email_ts: '2026-09-06T03:00:00Z',
            }] : [],
            next_page_token: looping ? `more-${sentPage}` : '',
          },
        }))
      }
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const directory = mkdtempSync(join(tmpdir(), 'dispatch-cap-'))
    directories.push(directory)
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      indexPath: join(directory, 'gmail.sqlite'),
    })
    await expect(provider.syncNow()).rejects.toThrow('Gmail pagination exceeded 100 pages')
    expect(provider.syncStatus()).toMatchObject({ state: 'failed' })
    provider.stopBackgroundSync()
  })

  it('discards Gmail drafts and maps connector failures to typed errors', async () => {
    let failure = ''
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      if (failure) {
        response.statusCode = 503
        return response.end(JSON.stringify({ error: failure }))
      }
      response.end(JSON.stringify({ ok: true }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    await expect(provider.discardGmailDraft('link-one', 'draft-1')).resolves.toBeUndefined()

    failure = 'gmail_html_unsupported'
    await expect(provider.createGmailDraft('link-one', '', '', '', '', '', 'Hi')).rejects.toMatchObject({ code: 'gmail_html_unsupported' })
    failure = 'attachment upload failed'
    await expect(provider.createGmailDraft('link-one', '', '', '', '', '', 'Hi')).rejects.toMatchObject({ code: 'gmail_attachment_unsupported' })
    failure = 'gmail_draft_discard_unavailable'
    await expect(provider.discardGmailDraft('link-one', 'draft-1')).rejects.toMatchObject({ code: 'gmail_draft_discard_unavailable' })
  })
})

describe('stale rows', () => {
  it('drops a draft from the Drafts list once Gmail stops returning it, even when the mailbox is too big to sync completely', async () => {
    let draftsPresent = true
    const server = createServer(async (request, response) => {
      answerIdsFromDetails(request, response)
      response.setHeader('content-type', 'application/json')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
      if (request.url === '/v1/connectors/gmail') return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      if (request.url === '/v1/connectors/gmail/search-messages') {
        const labels = (body.labelIds as string[] | undefined) ?? []
        if (labels.includes('DRAFT')) return response.end(JSON.stringify({ structuredContent: { emails: draftsPresent ? [{ id: 'draft-msg', thread_id: 't-draft', from_: 'Steve <work@example.com>', subject: 'Unsent', snippet: '', labels: ['DRAFT'], email_ts: '2026-09-05T21:42:00Z' }] : [] } }))
        if (labels.includes('INBOX')) {
          // Two pages: the 60-second refresh reads only the first, so this stream is never complete for it.
          if (body.nextPageToken === 'more') return response.end(JSON.stringify({ structuredContent: { emails: [{ id: 'in-2', thread_id: 't-in-2', from_: 'Bo <bo@example.com>', subject: 'Older', snippet: '', labels: ['INBOX'], email_ts: '2026-09-03T21:42:00Z' }], next_page_token: '' } }))
          return response.end(JSON.stringify({ structuredContent: { emails: [{ id: 'in-1', thread_id: 't-in', from_: 'Ana <ana@example.com>', subject: 'Hello', snippet: '', labels: ['INBOX'], email_ts: '2026-09-04T21:42:00Z' }], next_page_token: 'more' } }))
        }
        return response.end(JSON.stringify({ structuredContent: { emails: [] } }))
      }
      if (request.url === '/v1/connectors/gmail/drafts/list') return response.end(JSON.stringify({ structuredContent: { drafts: draftsPresent ? [{ draft_id: 'r-1', message_id: 'draft-msg', thread_id: 't-draft', from_: 'work@example.com', subject: 'Unsent' }] : [], next_page_token: '' } }))
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: ':memory:' })
    await provider.syncNow()
    expect((await provider.listMailboxConversations!('drafts', 'all')).map((conversation) => conversation.latestMessageId)).toEqual(['draft-msg'])
    draftsPresent = false
    await provider.refreshNow()
    expect(await provider.listMailboxConversations!('drafts', 'all')).toEqual([])
    expect((await provider.listMailboxConversations!('inbox', 'all')).map((conversation) => conversation.latestMessageId)).toEqual(['in-1', 'in-2'])
    await provider.syncNow()
    expect(await provider.listMailboxConversations!('drafts', 'all')).toEqual([])
    await expect(provider.openGmailDraft('link-one', 'draft-msg', 't-draft')).rejects.toThrow('no longer exists in Gmail')
  })
})

describe('live drafts', () => {
  it('lists a draft Gmail search has not indexed yet, and drops it once Gmail no longer lists it', async () => {
    let live = [{ draft_id: 'r-new', message_id: 'fresh-draft-msg', thread_id: 't-fresh', from_: 'steve@example.com', to: ['andy@example.com'], subject: 'Materials for Chris' }]
    const reads: string[] = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
      if (request.url === '/v1/connectors/gmail') return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      if (request.url === '/v1/connectors/gmail/search-messages') {
        const labels = (body.labelIds as string[] | undefined) ?? []
        return response.end(JSON.stringify({ structuredContent: { emails: labels.includes('INBOX') ? [{ id: 'in-1', thread_id: 't-in', from_: 'Ana <ana@example.com>', subject: 'Hello', snippet: '', labels: ['INBOX'], email_ts: '2026-09-04T21:42:00Z' }] : [] } }))
      }
      if (request.url === '/v1/connectors/gmail/drafts/list') return response.end(JSON.stringify({ structuredContent: { drafts: live, next_page_token: '' } }))
      if (request.url === '/v1/connectors/gmail/read') {
        reads.push(String(body.messageId))
        return response.end(JSON.stringify({ structuredContent: { ...gmailMessage.structuredContent, id: body.messageId, thread_id: 't-fresh', label_ids: ['DRAFT'], internal_date: '1788486120000', payload: { ...gmailMessage.structuredContent.payload, headers: [{ name: 'From', value: 'Steve <work@example.com>' }, { name: 'To', value: 'Andy <andy@example.com>' }, { name: 'Subject', value: 'Materials for Chris' }] } } }))
      }
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: ':memory:' })
    await provider.syncNow()
    await provider.refreshDrafts(undefined, true)
    const drafts = await provider.listMailboxConversations!('drafts', 'all')
    expect(drafts.map((conversation) => [conversation.latestMessageId, conversation.subject])).toEqual([['fresh-draft-msg', 'Materials for Chris']])
    expect(reads).toEqual(['fresh-draft-msg'])
    await provider.listMailboxConversations!('drafts', 'all')
    expect(reads).toEqual(['fresh-draft-msg'])
    expect((await provider.listMailboxConversations!('inbox', 'all')).map((conversation) => conversation.latestMessageId)).toEqual(['in-1'])
    live = []
    await provider.refreshDrafts(undefined, true)
    expect(await provider.listMailboxConversations!('drafts', 'all')).toEqual([])
  })
})

describe('message bodies in charsets other than UTF-8', () => {
  // The Outlook invite that showed "RÃ©union": Windows-1252, quoted-printable.
  const outlookRaw = [
    'From: "Laurent, Arnaud" <arnaud@example.com>',
    'Subject: Taikun update',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=WINDOWS-1252',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'R=E9union Microsoft Teams',
    '--alt',
    'Content-Type: text/html; charset=WINDOWS-1252',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>R=E9union Microsoft Teams</p><p>=C9tats-Unis</p>',
    '--alt--',
    '',
  ].join('\r\n')
  // What the connector returns for it: the Windows-1252 text re-read as Latin-1.
  const connectorMessage = (charset: string) => ({
    id: 'm-fr', thread_id: 't-fr', label_ids: ['INBOX'], snippet: 'Réunion Microsoft Teams', internal_date: '1788486120000',
    payload: {
      part_id: '', mime_type: 'multipart/alternative',
      headers: [{ name: 'From', value: '"Laurent, Arnaud" <arnaud@example.com>' }, { name: 'Subject', value: 'Taikun update' }],
      parts: [
        { part_id: '0', mime_type: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: `text/plain; charset=${charset}` }], body: { content: 'RÃ©union Microsoft Teams' } },
        { part_id: '1', mime_type: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: `text/html; charset=${charset}` }], body: { content: '<p>RÃ©union Microsoft Teams</p><p>Ã‰tats-Unis</p>' } },
      ],
    },
  })
  async function connector(charset: string, raw = outlookRaw) {
    const formats: string[] = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as { format?: string } : {}
      if (request.url === '/v1/connectors/gmail') return response.end(JSON.stringify({ accounts: [{ linkId: 'link-one', name: 'Work', email: 'work@example.com' }] }))
      if (request.url === '/v1/connectors/gmail/read-thread') return response.end(JSON.stringify({ structuredContent: { messages: [connectorMessage(charset)] } }))
      if (request.url === '/v1/connectors/gmail/read') {
        formats.push(body.format ?? '')
        return response.end(JSON.stringify({ structuredContent: body.format === 'raw' ? { raw: Buffer.from(raw, 'latin1').toString('base64url') } : connectorMessage(charset) }))
      }
      response.statusCode = 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { provider: new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false }), formats }
  }

  it('decodes a Windows-1252 body from the raw message instead of the connector text', async () => {
    const { provider, formats } = await connector('WINDOWS-1252')
    const conversation = await provider.readConversation('link-one', 't-fr')
    expect(conversation.messages[0]!.body).toEqual({ kind: 'sanitized-html', content: '<p>Réunion Microsoft Teams</p><p>États-Unis</p>' })
    expect(formats).toEqual(['raw'])
    expect((await provider.readMessage('link-one', 'm-fr')).body.content).toBe('<p>Réunion Microsoft Teams</p><p>États-Unis</p>')
  })

  it('keeps the connector text for UTF-8 bodies, without a raw read', async () => {
    const { provider, formats } = await connector('UTF-8')
    await provider.readConversation('link-one', 't-fr')
    expect(formats).toEqual([])
  })

  it('names a charset it cannot read in place of the body instead of guessing', async () => {
    const { provider } = await connector('x-made-up', outlookRaw.replaceAll('WINDOWS-1252', 'x-made-up'))
    const conversation = await provider.readConversation('link-one', 't-fr')
    expect(conversation.messages[0]!.body).toEqual({ kind: 'plain-text', content: 'This message uses a character set Dispatch cannot read: x-made-up.' })
  })
})
