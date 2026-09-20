import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GmailConnectorProvider, unsupportedAttachmentType } from '../src/gmail-provider.js'
import { resolveAttachmentBytes } from '../src/open-attachment.js'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Steve <> Mallun\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
const icsBase64 = Buffer.from(ics).toString('base64')
const rawInvite = Buffer.from([
  'MIME-Version: 1.0',
  'From: Mallun Yen <mallun@example.com>',
  'Subject: Invitation',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<p>You have been invited.</p>',
  '--outer',
  'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="invite.ics"',
  '',
  icsBase64,
  '--outer',
  'Content-Type: application/ics; name="invite.ics"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="invite.ics"',
  '',
  icsBase64,
  '--outer--',
  '',
].join('\r\n'), 'latin1').toString('base64url')

const refusal = {
  content: [{ type: 'text', text: 'GmailConnectorError: Failed to read attachment' }],
  structuredContent: { error: 'GmailConnectorError: Failed to read attachment', error_code: 'UNKNOWN', error_data: { type: 'gmail_connector_error', code: 'unsupported_attachment_type', message: 'Unsupported attachment type', reason: 'unsupported_attachment_type' } },
  isError: true,
}

const fullMessage = {
  structuredContent: {
    id: 'm-invite', thread_id: 't-invite', label_ids: ['INBOX'], snippet: 'Invitation', internal_date: '1788486120000',
    payload: {
      mime_type: 'multipart/mixed',
      headers: [{ name: 'From', value: 'Mallun Yen <mallun@example.com>' }, { name: 'To', value: 'Steve <work@example.com>' }, { name: 'Subject', value: 'Invitation' }, { name: 'Date', value: 'Thu, 18 Sep 2026 08:22:00 -0600' }],
      parts: [
        { part_id: '0', mime_type: 'text/html', filename: '', body: { content: '<p>You have been invited.</p>' } },
        { part_id: '1', mime_type: 'text/calendar', filename: 'invite.ics', body: { size: 3394, attachment_id: 'att-calendar' } },
        { part_id: '2', mime_type: 'application/ics', filename: 'invite.ics', body: { size: 3394, attachment_id: 'att-ics' } },
      ],
    },
  },
}

describe('attachment fallback for types the connector refuses', () => {
  it('recognises the connector refusal', () => {
    expect(unsupportedAttachmentType(refusal)).toBe(true)
    expect(unsupportedAttachmentType({ structuredContent: { download_url: 'https://x' } })).toBe(false)
  })

  it('cuts the calendar part out of the raw message when read_attachment refuses it', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json')
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
      requests.push({ url: req.url ?? '', body })
      if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
      if (req.url === '/v1/connectors/gmail/attachment') return res.end(JSON.stringify(refusal))
      if (req.url === '/v1/connectors/gmail/read') {
        if (body.format === 'raw') return res.end(JSON.stringify({ structuredContent: { id: 'm-invite', raw: rawInvite } }))
        return res.end(JSON.stringify(fullMessage))
      }
      res.statusCode = 404; res.end('{}')
    })
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    try {
      const payload = await provider.readAttachment('one', 'm-invite', 'att-ics', 'invite.ics')
      const bytes = await resolveAttachmentBytes(payload)
      expect(bytes.toString('utf8')).toBe(ics)
      expect((payload as { structuredContent: { mime_type: string } }).structuredContent.mime_type).toBe('application/ics')
      expect(requests.map((item) => `${item.url}:${String(item.body.format ?? item.body.attachmentId ?? '')}`)).toEqual([
        '/v1/connectors/gmail/attachment:att-ics',
        '/v1/connectors/gmail:',
        '/v1/connectors/gmail/read:full',
        '/v1/connectors/gmail/read:raw',
      ])
    } finally {
      provider.stopBackgroundSync()
    }
  })

  it('still returns the connector payload for supported types', async () => {
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json')
      for await (const _chunk of req) { /* drain */ }
      if (req.url === '/v1/connectors/gmail') return res.end(JSON.stringify({ accounts: [{ linkId: 'one', connectorId: 'gmail', name: 'Work', email: 'work@example.com' }] }))
      if (req.url === '/v1/connectors/gmail/attachment') return res.end(JSON.stringify({ structuredContent: { base64_url_content: Buffer.from('%PDF').toString('base64url') } }))
      res.statusCode = 404; res.end('{}')
    })
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const provider = new GmailConnectorProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { indexPath: false })
    try {
      const bytes = await resolveAttachmentBytes(await provider.readAttachment('one', 'm1', 'a1', 'arrival.pdf'))
      expect(bytes.toString()).toBe('%PDF')
    } finally {
      provider.stopBackgroundSync()
    }
  })
})
