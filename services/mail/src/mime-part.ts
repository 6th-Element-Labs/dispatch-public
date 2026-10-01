/**
 * Minimal MIME reader for raw RFC 2822 messages. Gmail's `read_email` with
 * `format: "raw"` returns the whole message base64url-encoded, which always
 * contains the bytes. Dispatch reads it when the connector cannot serve a part
 * itself: attachments `read_attachment` refuses (such as calendar invites), and
 * text parts in charsets other than UTF-8, which the connector decodes wrongly.
 */

export interface MimePart {
  readonly mimeType: string
  readonly filename: string
  readonly headers: ReadonlyMap<string, string>
  readonly body: Buffer
  readonly children: readonly MimePart[]
}

export interface PartMatch {
  readonly filename: string
  readonly mimeType?: string
  /** Which of several parts with the same filename and type, in document order. */
  readonly ordinal?: number
}

/** A MIME part declared a charset this runtime cannot decode. Dispatch reports it rather than guessing. */
export class UnsupportedCharsetError extends Error {
  readonly code = 'unsupported_charset'
  constructor(readonly charset: string) {
    super(`This message uses a character set Dispatch cannot read: ${charset}.`)
  }
}

/** The charset a Content-Type declares, lowercased; empty when it declares none. */
export function mimeCharset(contentType: string): string {
  return parameter(contentType, 'charset').trim().toLowerCase()
}

/** Charsets whose text the Gmail connector returns intact. */
export function isUnicodeCharset(charset: string): boolean {
  return ['', 'utf-8', 'utf8', 'us-ascii', 'ascii'].includes(charset.trim().toLowerCase())
}

/** Bytes in a named charset, decoded with the WHATWG decoders. US-ASCII when no charset is named (RFC 2045). */
export function decodeCharset(bytes: Uint8Array, charset: string): string {
  const label = charset.trim().toLowerCase() || 'us-ascii'
  let decoder: TextDecoder
  try { decoder = new TextDecoder(label) } catch { throw new UnsupportedCharsetError(label) }
  // WHATWG maps a few legacy labels (ISO-2022-KR, HZ) to a decoder that only emits U+FFFD.
  if (decoder.encoding === 'replacement') throw new UnsupportedCharsetError(label)
  return decoder.decode(bytes)
}

/** A text part's content, decoded with the charset its Content-Type declares. */
export function decodeText(part: MimePart): string {
  return decodeCharset(part.body, mimeCharset(part.headers.get('content-type') ?? ''))
}

/** The part at a Gmail part id: '' is the message itself, '1' its second part, '0.1' the second part of the first. */
export function partAt(root: MimePart, partId: string): MimePart | undefined {
  if (!partId) return root
  let part: MimePart | undefined = root
  for (const step of partId.split('.')) {
    if (!/^\d+$/.test(step)) return undefined
    part = part?.children[Number(step)]
  }
  return part
}

export function decodeRawMessage(raw: string): Buffer {
  const cleaned = raw.replaceAll(/\s/g, '').replaceAll('-', '+').replaceAll('_', '/')
  return Buffer.from(cleaned, 'base64')
}

export function parseMime(source: Buffer): MimePart {
  const { headers, body } = splitHeaders(source)
  const contentType = headers.get('content-type') ?? 'text/plain'
  const mimeType = contentType.split(';')[0]!.trim().toLowerCase()
  const filename = partFilename(headers)
  if (mimeType.startsWith('multipart/')) {
    const boundary = parameter(contentType, 'boundary')
    if (boundary) {
      return { mimeType, filename, headers, body: Buffer.alloc(0), children: splitMultipart(body, boundary).map(parseMime) }
    }
  }
  return { mimeType, filename, headers, body: decodeBody(body, headers.get('content-transfer-encoding') ?? ''), children: [] }
}

export function flattenParts(part: MimePart): MimePart[] {
  return [part, ...part.children.flatMap(flattenParts)]
}

/**
 * Find an attachment. Gmail's API names unnamed parts itself (a `text/calendar`
 * body becomes `invite.ics`), so a filename match is tried first, then an
 * unnamed part of the same type, then the filename alone. `ordinal` picks
 * among duplicates in document order.
 */
export function findPart(root: MimePart, match: PartMatch): MimePart | undefined {
  const wanted = match.filename.trim().toLowerCase()
  const type = match.mimeType?.toLowerCase()
  const leaves = flattenParts(root).filter((part) => part.children.length === 0)
  const pick = (candidates: MimePart[]) => candidates[match.ordinal ?? 0] ?? candidates[0]
  const named = leaves.filter((part) => part.filename.toLowerCase() === wanted && (!type || part.mimeType === type))
  if (named.length) return pick(named)
  if (type) {
    const unnamed = leaves.filter((part) => part.mimeType === type && !part.filename)
    if (unnamed.length) return pick(unnamed)
  }
  const byName = leaves.filter((part) => part.filename.toLowerCase() === wanted)
  return byName.length ? pick(byName) : undefined
}

function splitHeaders(source: Buffer): { headers: Map<string, string>; body: Buffer } {
  const text = source.toString('latin1')
  let end = text.indexOf('\r\n\r\n')
  let skip = 4
  if (end < 0) { end = text.indexOf('\n\n'); skip = 2 }
  const headerText = end < 0 ? text : text.slice(0, end)
  const body = end < 0 ? Buffer.alloc(0) : source.subarray(Buffer.byteLength(headerText, 'latin1') + skip)
  const headers = new Map<string, string>()
  for (const line of headerText.replaceAll(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { headers, body }
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1')
  const marker = `--${boundary}`
  const parts: Buffer[] = []
  let cursor = text.indexOf(marker)
  while (cursor >= 0) {
    const lineEnd = text.indexOf('\n', cursor)
    if (lineEnd < 0) break
    if (text.slice(cursor + marker.length, cursor + marker.length + 2) === '--') break
    const start = lineEnd + 1
    let next = text.indexOf(`\r\n${marker}`, start)
    let trim = 2
    if (next < 0) { next = text.indexOf(`\n${marker}`, start); trim = 1 }
    if (next < 0) break
    parts.push(Buffer.from(text.slice(start, next), 'latin1'))
    cursor = next + trim
  }
  return parts
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  const kind = encoding.trim().toLowerCase()
  if (kind === 'base64') return Buffer.from(body.toString('latin1').replaceAll(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (kind === 'quoted-printable') return decodeQuotedPrintable(body.toString('latin1'))
  return body
}

function decodeQuotedPrintable(text: string): Buffer {
  const unfolded = text.replaceAll(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i]!
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) { bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16)); i += 2 }
    else bytes.push(ch.charCodeAt(0) & 0xff)
  }
  return Buffer.from(bytes)
}

function partFilename(headers: ReadonlyMap<string, string>): string {
  const disposition = headers.get('content-disposition') ?? ''
  const fromDisposition = parameter(disposition, 'filename')
  if (fromDisposition) return decodeEncodedWord(fromDisposition)
  const fromType = parameter(headers.get('content-type') ?? '', 'name')
  return fromType ? decodeEncodedWord(fromType) : ''
}

function parameter(headerValue: string, name: string): string {
  const pattern = new RegExp(`(?:^|;)\\s*${name}\\*?\\s*=\\s*("([^"]*)"|([^;]*))`, 'i')
  const match = pattern.exec(headerValue)
  if (!match) return ''
  const value = (match[2] ?? match[3] ?? '').trim()
  const extended = /^([\w-]*)'[\w-]*'(.*)$/.exec(value)
  return extended ? decodeCharset(percentBytes(extended[2]!), extended[1] || 'us-ascii') : value
}

/** RFC 2231 value bytes: %XX escapes, everything else as ASCII. */
function percentBytes(value: string): Buffer {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) { bytes.push(parseInt(value.slice(i + 1, i + 3), 16)); i += 2 }
    else bytes.push(value.charCodeAt(i) & 0xff)
  }
  return Buffer.from(bytes)
}

function decodeEncodedWord(value: string): string {
  return value.replaceAll(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, kind: string, data: string) => {
    const bytes = kind.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : decodeQuotedPrintable(data.replaceAll('_', ' '))
    return decodeCharset(bytes, charset.split('*')[0]!)
  })
}
