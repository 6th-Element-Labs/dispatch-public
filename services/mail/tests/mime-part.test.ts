import { describe, expect, it } from 'vitest'
import { decodeCharset, decodeRawMessage, decodeText, findPart, isUnicodeCharset, mimeCharset, parseMime, partAt, UnsupportedCharsetError } from '../src/mime-part.js'

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

/** One text part as a raw message, encoded with the given Content-Transfer-Encoding. */
function textMessage(contentType: string, encoding: 'quoted-printable' | 'base64' | '8bit', body: Buffer): Buffer {
  const encoded = encoding === 'base64' ? body.toString('base64') : body.toString('latin1')
  return Buffer.concat([Buffer.from(`From: a@example.com\r\nContent-Type: ${contentType}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`, 'latin1'), Buffer.from(encoded, 'latin1')])
}

describe('text part charsets', () => {
  it('decodes UTF-8 quoted-printable HTML and base64 plain text', () => {
    expect(decodeText(parseMime(textMessage('text/html; charset="utf-8"', 'quoted-printable', Buffer.from('<p>R=C3=A9union</p>'))))).toBe('<p>Réunion</p>')
    expect(decodeText(parseMime(textMessage('text/plain; charset=UTF-8', 'base64', Buffer.from('Numéro de réunion', 'utf8'))))).toBe('Numéro de réunion')
  })

  it('decodes Windows-1252 and ISO-8859-1 parts by their declared charset', () => {
    // The Outlook invite that showed "RÃ©union": Windows-1252, quoted-printable, with curly quotes.
    expect(decodeText(parseMime(textMessage('text/html; charset=WINDOWS-1252', 'quoted-printable', Buffer.from('R=E9union =93Teams=94 =C9tats-Unis'))))).toBe('Réunion “Teams” États-Unis')
    expect(decodeText(parseMime(textMessage('text/plain; charset=iso-8859-1', 'quoted-printable', Buffer.from('Participer par t=E9l=E9phone'))))).toBe('Participer par téléphone')
    expect(decodeText(parseMime(textMessage('text/plain; charset="ISO-8859-1"', 'base64', Buffer.from('Référence système', 'latin1'))))).toBe('Référence système')
    expect(decodeText(parseMime(textMessage('text/plain; charset=windows-1252', '8bit', Buffer.from([0x52, 0xe9, 0x75, 0x6e, 0x69, 0x6f, 0x6e]))))).toBe('Réunion')
  })

  it('reads a part without a charset as US-ASCII', () => {
    expect(mimeCharset('text/plain')).toBe('')
    expect(decodeText(parseMime(textMessage('text/plain', '8bit', Buffer.from('Plain ASCII.'))))).toBe('Plain ASCII.')
  })

  it('refuses a charset it cannot decode instead of guessing', () => {
    expect(() => decodeText(parseMime(textMessage('text/plain; charset=x-made-up', 'quoted-printable', Buffer.from('R=E9union'))))).toThrow(UnsupportedCharsetError)
    expect(() => decodeCharset(Buffer.from('x'), 'x-made-up')).toThrow('This message uses a character set Dispatch cannot read: x-made-up.')
    // WHATWG decodes ISO-2022-KR to a single U+FFFD; that is not a reading.
    expect(() => decodeCharset(Buffer.from('x'), 'iso-2022-kr')).toThrow(UnsupportedCharsetError)
  })

  it('knows which charsets the connector already returns intact', () => {
    for (const charset of ['', 'utf-8', 'UTF8', 'us-ascii']) expect(isUnicodeCharset(charset)).toBe(true)
    for (const charset of ['windows-1252', 'iso-8859-1', 'shift_jis']) expect(isUnicodeCharset(charset)).toBe(false)
  })

  it('finds a part by its Gmail part id', () => {
    const root = parseMime(Buffer.from(invite))
    expect(partAt(root, '')).toBe(root)
    expect(partAt(root, '0.1')?.mimeType).toBe('text/html')
    expect(partAt(root, '1')?.filename).toBe('invite.ics')
    expect(partAt(root, '0.9')).toBeUndefined()
    expect(partAt(root, 'html')).toBeUndefined()
  })

  it('decodes encoded-word and RFC 2231 filenames by their charset', () => {
    const attachment = (disposition: string) => parseMime(Buffer.from(`Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; ${disposition}\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERg==\r\n--b--\r\n`, 'latin1')).children[0]!.filename
    expect(attachment('filename="=?iso-8859-1?Q?R=E9sum=E9.pdf?="')).toBe('Résumé.pdf')
    expect(attachment('filename="=?UTF-8?B?UsOpc3Vtw6kucGRm?="')).toBe('Résumé.pdf')
    expect(attachment("filename*=iso-8859-1''R%E9sum%E9.pdf")).toBe('Résumé.pdf')
    expect(attachment("filename*=UTF-8''R%C3%A9sum%C3%A9.pdf")).toBe('Résumé.pdf')
  })
})
