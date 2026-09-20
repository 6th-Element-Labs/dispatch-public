import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentDownloadUrl, ensureAttachmentFile, mediaTypeFor, nativeOpenCommand, openAttachmentFile, safeId } from '../src/open-attachment.js'

async function cacheDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dispatch-attachment-'))
}

describe('nativeOpenCommand', () => {
  it('uses the OS default app for the file path', () => {
    const command = nativeOpenCommand('/tmp/arrival.pdf')
    if (process.platform === 'darwin') expect(command).toEqual({ command: 'open', args: ['/tmp/arrival.pdf'] })
    else if (process.platform === 'win32') expect(command).toEqual({ command: 'cmd', args: ['/c', 'start', '', '/tmp/arrival.pdf'] })
    else expect(command).toEqual({ command: 'xdg-open', args: ['/tmp/arrival.pdf'] })
  })
})

describe('openAttachmentFile', () => {
  it('writes the attachment under its safe filename and opens that path', async () => {
    const opened: string[] = []
    const cache = await cacheDir()
    const result = await openAttachmentFile({
      messageId: 'msg/1',
      attachmentId: 'att/9',
      filename: 'Opua arrival instructions.pdf',
      loadPayload: async () => ({ data: Buffer.from('%PDF-1.1 demo').toString('base64') }),
      cacheDir: cache,
      openPath: async (path) => { opened.push(path) },
    })

    expect(result.filename).toBe('Opua arrival instructions.pdf')
    expect(result.path).toBe(join(cache, 'msg-1', 'att-9', 'Opua arrival instructions.pdf'))
    expect(opened).toEqual([result.path])
    await expect(readFile(result.path, 'utf8')).resolves.toBe('%PDF-1.1 demo')
  })

  it('decodes URL-safe base64 from structuredContent', async () => {
    const cache = await cacheDir()
    const bytes = Buffer.from('hello+/world')
    const result = await openAttachmentFile({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: 'note.txt',
      loadPayload: async () => ({ structuredContent: { base64_url_content: bytes.toString('base64url') } }),
      cacheDir: cache,
      openPath: async () => undefined,
    })
    await expect(readFile(result.path)).resolves.toEqual(bytes)
  })

  it('downloads the bytes from the connector file URL when nothing is inline', async () => {
    const cache = await cacheDir()
    const requested: string[] = []
    const url = 'https://files.example.com/att/9?sig=abc'
    const result = await openAttachmentFile({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: '1670281874.pdf',
      loadPayload: async () => ({ content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { message_id: 'm1', filename: '1670281874.pdf', mime_type: 'application/pdf', size_bytes: 13, file_uri: { download_url: url, file_id: 'file_1' }, content: [{ type: 'text', text: 'extracted text' }], content_truncated: true } }),
      cacheDir: cache,
      openPath: async () => undefined,
      download: async (target) => { requested.push(target); return Buffer.from('%PDF-1.1 demo') },
    })
    expect(requested).toEqual([url])
    await expect(readFile(result.path, 'utf8')).resolves.toBe('%PDF-1.1 demo')
  })

  it('refuses a download URL that is not https and a body of the wrong size', async () => {
    expect(() => attachmentDownloadUrl({ structuredContent: { download_url: 'http://files.example.com/x' } })).toThrow('must use https')
    expect(attachmentDownloadUrl({ structuredContent: { structuredContent: { file_uri: { download_url: 'https://files.example.com/nested' } } } })).toBe('https://files.example.com/nested')
    await expect(openAttachmentFile({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: 'note.pdf',
      loadPayload: async () => ({ structuredContent: { size_bytes: 99, download_url: 'https://files.example.com/x' } }),
      cacheDir: await cacheDir(),
      openPath: async () => undefined,
      download: async () => Buffer.from('short'),
    })).rejects.toThrow('returned 5 bytes, expected 99')
  })

  it('keeps a 400-character Gmail attachment id inside one path segment', async () => {
    const longId = 'ANGjdJ' + 'x'.repeat(420)
    const segment = safeId(longId)
    expect(segment.length).toBeLessThanOrEqual(80)
    expect(segment).not.toBe(safeId(longId + 'y'))
    expect(safeId('att/9')).toBe('att-9')
    const cache = await cacheDir()
    const result = await openAttachmentFile({
      messageId: '1a073fd8fd45e872',
      attachmentId: longId,
      filename: '1670281874.pdf',
      loadPayload: async () => ({ data: Buffer.from('%PDF').toString('base64') }),
      cacheDir: cache,
      openPath: async () => undefined,
    })
    expect(result.path).toBe(join(cache, '1a073fd8fd45e872', segment, '1670281874.pdf'))
  })

  it('reuses a cached file without asking the connector again', async () => {
    const cache = await cacheDir()
    let loads = 0
    const input = { messageId: 'm1', attachmentId: 'a1', filename: 'photo.png', cacheDir: cache, loadPayload: async () => { loads += 1; return { structuredContent: { mime_type: 'image/png', data: Buffer.from('png-bytes').toString('base64') } } } }
    const first = await ensureAttachmentFile(input)
    const second = await ensureAttachmentFile(input)
    expect(first).toMatchObject({ cached: false, mediaType: 'image/png' })
    expect(second).toMatchObject({ cached: true, path: first.path, mediaType: 'image/png' })
    expect(loads).toBe(1)
    expect(mediaTypeFor('Report.PDF')).toBe('application/pdf')
    expect(mediaTypeFor('unknown.bin')).toBe('application/octet-stream')
  })

  it('surfaces the connector error instead of a generic missing-bytes message', async () => {
    await expect(openAttachmentFile({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: 'image.png',
      loadPayload: async () => ({ isError: true, content: [{ type: 'text', text: 'GmailConnectorError: Failed to read attachment' }], structuredContent: { error: 'GmailConnectorError: Failed to read attachment', error_data: { message: 'Attachment selector ambiguous' } } }),
      cacheDir: await cacheDir(),
      openPath: async () => undefined,
    })).rejects.toThrow('Gmail connector could not read the attachment: Attachment selector ambiguous')
  })

  it('rejects a missing attachment payload', async () => {
    await expect(openAttachmentFile({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: 'note.pdf',
      loadPayload: async () => ({}),
      cacheDir: await cacheDir(),
      openPath: async () => undefined,
    })).rejects.toThrow('Gmail attachment response did not contain downloadable bytes')
  })

  it('keeps a traversal filename inside the cache directory', async () => {
    const cache = await cacheDir()
    const result = await openAttachmentFile({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: '../../etc/passwd',
      loadPayload: async () => ({ data: Buffer.from('x').toString('base64') }),
      cacheDir: cache,
      openPath: async () => undefined,
    })
    expect(result.filename).toBe('passwd')
    expect(result.path).toBe(join(cache, 'm1', 'a1', 'passwd'))
  })

  it('rejects an empty or dot filename', async () => {
    const cache = await cacheDir()
    for (const filename of ['', '.', '..', '/']) {
      await expect(openAttachmentFile({
        messageId: 'm1',
        attachmentId: 'a1',
        filename,
        loadPayload: async () => ({ data: Buffer.from('x').toString('base64') }),
        cacheDir: cache,
        openPath: async () => undefined,
      })).rejects.toThrow('Attachment filename is missing or unsafe')
    }
  })

  it('does not hide a failed default-app open', async () => {
    await expect(openAttachmentFile({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: 'note.pdf',
      loadPayload: async () => ({ data: Buffer.from('x').toString('base64') }),
      cacheDir: await cacheDir(),
      openPath: async () => { throw new Error('Preview is not available') },
    })).rejects.toThrow('Preview is not available')
  })
})
