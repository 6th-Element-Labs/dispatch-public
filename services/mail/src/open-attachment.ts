import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

export interface EnsureAttachmentInput {
  readonly accountId: string
  readonly messageId: string
  readonly attachmentId: string
  readonly filename: string
  /** Asks the connector for the attachment. Only called when the cache has no copy. */
  readonly loadPayload: () => Promise<unknown>
  readonly cacheDir: string
  /** Fetches the bytes behind a connector download URL. Defaults to an https-only fetch. */
  readonly download?: (url: string) => Promise<Buffer>
}

export interface OpenAttachmentInput extends EnsureAttachmentInput {
  readonly openPath: (path: string) => Promise<void>
}

export interface CachedAttachment {
  readonly path: string
  readonly filename: string
  readonly mediaType: string
  /** True when the file was already on disk and the connector was not asked. */
  readonly cached: boolean
}

/** Connector responses may exceed this before Dispatch refuses to write them to disk. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export interface OpenedAttachment {
  readonly path: string
  readonly filename: string
}

export function defaultAttachmentCacheDir(): string {
  if (process.env.DISPATCH_ATTACHMENT_CACHE) return process.env.DISPATCH_ATTACHMENT_CACHE
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'Dispatch', 'attachments')
  return join(homedir(), '.cache', 'dispatch', 'attachments')
}

export function defaultOpenPath(path: string): Promise<void> {
  const { command, args } = nativeOpenCommand(path)
  return new Promise((resolveOpen, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolveOpen()
      else reject(new Error(`The default app failed to open ${path} (exit ${code ?? 'null'})`))
    })
  })
}

export function nativeOpenCommand(path: string): { command: string; args: string[] } {
  if (process.platform === 'darwin') return { command: 'open', args: [path] }
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', path] }
  return { command: 'xdg-open', args: [path] }
}

export async function defaultDownload(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Attachment download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
  return bytes
}

/**
 * The Codex Gmail connector answers an attachment read with either inline
 * base64 (`base64_url_content` / `data`) or a signed https `download_url`
 * (top level, under `file_uri`, or in a nested `structuredContent`). Inline
 * bytes win; otherwise the URL is fetched. Anything else is a hard failure.
 */
export async function resolveAttachmentBytes(payload: unknown, download: (url: string) => Promise<Buffer> = defaultDownload): Promise<Buffer> {
  const failure = connectorFailure(payload)
  if (failure) throw new Error(`Gmail connector could not read the attachment: ${failure}`)
  const inline = inlineAttachmentBytes(payload)
  const url = inline === undefined ? attachmentDownloadUrl(payload) : undefined
  if (inline === undefined && !url) throw new Error('Gmail attachment response did not contain downloadable bytes')
  const bytes = inline ?? await download(url!)
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
  const expected = expectedAttachmentSize(payload)
  if (expected !== undefined && expected !== bytes.length) {
    throw new Error(`Gmail attachment download returned ${bytes.length} bytes, expected ${expected}`)
  }
  return bytes
}

export function attachmentDownloadUrl(payload: unknown): string | undefined {
  const record = asRecord(payload)
  const content = asRecord(record?.structuredContent) ?? record
  const candidates = [content, asRecord(content?.file_uri), asRecord(content?.structuredContent), asRecord(asRecord(content?.structuredContent)?.file_uri)]
  for (const candidate of candidates) {
    const url = candidate?.download_url
    if (typeof url !== 'string' || !url) continue
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Gmail attachment download URL is not valid')
    }
    if (parsed.protocol !== 'https:') throw new Error(`Gmail attachment download URL must use https, got ${parsed.protocol}`)
    return url
  }
  return undefined
}

function expectedAttachmentSize(payload: unknown): number | undefined {
  const record = asRecord(payload)
  const content = asRecord(record?.structuredContent) ?? record
  const size = content?.size_bytes ?? asRecord(content?.structuredContent)?.size_bytes
  return typeof size === 'number' && Number.isInteger(size) && size >= 0 ? size : undefined
}

const cacheFlights = new Map<string, Promise<CachedAttachment>>()
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const identitySegment = (value: string) => `${safeId(value).slice(0, 24)}-${digest(value)}`
interface CacheManifest { version: 2; accountId: string; messageId: string; attachmentId: string; filename: string; mediaType: string; bytes: number; sha256: string }

/** Account identity and a verified manifest are required even when Gmail is offline. */
export async function ensureAttachmentFile(input: EnsureAttachmentInput): Promise<CachedAttachment> {
  if (!input.accountId || !input.messageId || !input.attachmentId) throw new Error('Account, message and attachment identities are required')
  const filename = safeAttachmentName(input.filename)
  // Hash the original IDs too: lossy path sanitization must not alias two records.
  const directory = join(input.cacheDir, 'v2', identitySegment(input.accountId), identitySegment(input.messageId), identitySegment(input.attachmentId))
  const path = join(directory, 'payload', filename)
  if (!resolve(path).startsWith(resolve(input.cacheDir) + sep)) {
    throw new Error('Attachment filename is missing or unsafe')
  }
  const key = resolve(path)
  const prior = cacheFlights.get(key)
  if (prior) return prior
  const flight = cacheAttachment(input, directory, path, filename)
  cacheFlights.set(key, flight)
  try { return await flight } finally { if (cacheFlights.get(key) === flight) cacheFlights.delete(key) }
}

async function cacheAttachment(input: EnsureAttachmentInput, directory: string, path: string, filename: string): Promise<CachedAttachment> {
  const manifestPath = join(directory, 'manifest.json')
  // Legacy cache paths omit the account and have no integrity proof. Never reuse them.
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CacheManifest
    if (manifest.version === 2 && manifest.accountId === input.accountId && manifest.messageId === input.messageId
      && manifest.attachmentId === input.attachmentId && manifest.filename === filename
      && typeof manifest.mediaType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(manifest.mediaType)
      && Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 0 && manifest.bytes <= MAX_ATTACHMENT_BYTES
      && typeof manifest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.sha256)) {
      const bytes = await readFile(path)
      if (bytes.length === manifest.bytes && digest(bytes) === manifest.sha256) return { path, filename, mediaType: manifest.mediaType, cached: true }
    }
  } catch { /* Missing or interrupted cache entries must be fetched, never treated as ready. */ }
  const payload = await input.loadPayload()
  const bytes = await resolveAttachmentBytes(payload, input.download)
  const mediaType = mediaTypeFor(filename, payload)
  const manifest: CacheManifest = { version: 2, accountId: input.accountId, messageId: input.messageId, attachmentId: input.attachmentId, filename, mediaType, bytes: bytes.length, sha256: digest(bytes) }
  await mkdir(join(directory, 'payload'), { recursive: true })
  const staging = `${path}.${randomUUID()}.partial`
  const manifestStaging = `${manifestPath}.${randomUUID()}.partial`
  try {
    await durableWrite(staging, bytes)
    await durableWrite(manifestStaging, Buffer.from(JSON.stringify(manifest)))
    await rename(staging, path)
    // The manifest is the readiness marker. A crash between the renames fails validation.
    await rename(manifestStaging, manifestPath)
    await syncDirectory(join(directory, 'payload'))
    await syncDirectory(directory)
  } finally {
    await Promise.all([rm(staging, { force: true }), rm(manifestStaging, { force: true })])
  }
  return { path, filename, mediaType, cached: false }
}

async function durableWrite(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export async function openAttachmentFile(input: OpenAttachmentInput): Promise<OpenedAttachment> {
  const file = await ensureAttachmentFile(input)
  await input.openPath(file.path)
  return { path: file.path, filename: file.filename }
}

export async function cachedAttachmentStatus(input: Pick<EnsureAttachmentInput, 'accountId' | 'messageId' | 'attachmentId' | 'filename' | 'cacheDir'>): Promise<{ cached: boolean }> {
  try {
    await ensureAttachmentFile({ ...input, loadPayload: async () => { throw Object.assign(new Error('Attachment is not downloaded'), { code: 'cache_miss' }) } })
    return { cached: true }
  } catch (error) {
    if ((error as { code?: string }).code === 'cache_miss') return { cached: false }
    throw error
  }
}

const MEDIA_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic',
  txt: 'text/plain', csv: 'text/csv', html: 'text/html', json: 'application/json', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mediaTypeFor(filename: string, payload?: unknown): string {
  const record = asRecord(payload)
  const content = asRecord(record?.structuredContent) ?? record
  const declared = content?.mime_type
  if (typeof declared === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(declared)) return declared
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_TYPES[extension] ?? 'application/octet-stream'
}

/** The connector reports failures inside a 200 response: `isError` plus an error record. */
function connectorFailure(payload: unknown): string | undefined {
  const record = asRecord(payload)
  if (!record) return undefined
  const content = asRecord(record.structuredContent)
  const data = asRecord(content?.error_data)
  const message = [data?.message, content?.error, asRecord(asArray(record.content)[0])?.text]
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  if (record.isError === true || typeof content?.error === 'string') return message ?? 'unknown connector error'
  return undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function safeAttachmentName(filename: string): string {
  const base = basename(filename.replaceAll('\\', '/'))
  const cleaned = base.replaceAll(/[\0\r\n]/g, '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('Attachment filename is missing or unsafe')
  }
  return cleaned
}

/** Gmail attachment ids run past 400 characters, longer than a path segment may be, so long ids are shortened to a prefix plus a digest. */
export function safeId(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '')
  if (!cleaned) return 'attachment'
  if (cleaned.length <= MAX_ID_SEGMENT) return cleaned
  return `${cleaned.slice(0, 24)}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

const MAX_ID_SEGMENT = 80

function inlineAttachmentBytes(payload: unknown): Buffer | undefined {
  const record = asRecord(payload)
  const content = asRecord(record?.structuredContent) ?? record
  const value = content?.base64_url_content ?? content?.data ?? asRecord(content?.attachment)?.data
  if (typeof value !== 'string') return undefined
  const encoded = value.replaceAll(/\s/g, '')
  return Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
