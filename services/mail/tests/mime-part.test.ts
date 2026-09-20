import { describe, expect, it } from 'vitest'
import { decodeRawMessage, findPart, parseMime } from '../src/mime-part.js'

const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Steve <> Mallun\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
const icsBase64 = Buffer.from(ics).toString('base64').replace(/(.{76})/g, '$1\r\n')

const invite = [
  'MIME-Version: 1.0',
  'From: Mallun Yen <mallun@example.com>',
  'Subject: Invitation: Steve Ridder (Taikun) <> Mallun',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'You have been invited =E2=80=94 see attached.',
  '--inner',
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<p>You have been invited.</p>',
  '--inner',
  'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
  'Content-Transfer-Encoding: 7bit',
  '',
  ics.trimEnd(),
  '--inner--',
  '--outer',
  'Content-Type: application/ics; name="invite.ics"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="invite.ics"',
  '',
  icsBase64,
  '--outer--',
  '',
].join('\r\n')

describe('mime-part', () => {
  it('decodes a base64url raw message', () => {
    const raw = Buffer.from('hello').toString('base64url')
    expect(decodeRawMessage(raw).toString()).toBe('hello')
  })

  it('walks nested multipart and decodes transfer encodings', () => {
    const root = parseMime(Buffer.from(invite, 'latin1'))
    expect(root.mimeType).toBe('multipart/mixed')
    expect(root.children.map((part) => part.mimeType)).toEqual(['multipart/alternative', 'application/ics'])
    const plain = root.children[0]!.children[0]!
    expect(plain.body.toString('utf8')).toBe('You have been invited — see attached.')
  })

  it('finds the unnamed calendar body by the type Gmail reports, and named files by name', () => {
    const root = parseMime(Buffer.from(invite, 'latin1'))
    const calendar = findPart(root, { filename: 'invite.ics', mimeType: 'text/calendar' })
    expect(calendar?.mimeType).toBe('text/calendar')
    expect(calendar?.body.toString('utf8').trimEnd()).toBe(ics.trimEnd())
    const second = findPart(root, { filename: 'invite.ics', ordinal: 1 })
    expect(second?.mimeType).toBe('application/ics')
    expect(second?.body.toString('utf8')).toBe(ics)
    expect(findPart(root, { filename: 'missing.pdf' })).toBeUndefined()
  })

  it('reads filenames from the content-type name parameter and RFC 2047 words', () => {
    const source = [
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: application/pdf; name="=?UTF-8?B?UmVwb3J0IMOgLnBkZg==?="',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF').toString('base64'),
      '--b--',
    ].join('\r\n')
    const root = parseMime(Buffer.from(source, 'latin1'))
    expect(findPart(root, { filename: 'Report à.pdf' })?.body.toString()).toBe('%PDF')
  })
})
