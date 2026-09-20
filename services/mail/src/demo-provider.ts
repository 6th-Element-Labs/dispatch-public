import { groupConversations, projectConversation } from './conversation.js'
import { projectDraft } from './draft.js'
import type { ConversationProjection, ConversationSummary, DraftProjection, MailAddress, MailStateFilter, MessageProjection, MessageSummary } from './model.js'

const messages: readonly MessageProjection[] = [
  {
    id: 'demo-message-opua',
    threadId: 'demo-thread-opua',
    sender: { name: 'Ana Morales', address: 'ana@opuamarina.example', initials: 'AM' },
    subject: 'Opua berth confirmation',
    receivedAt: '2026-09-04T09:42:00+12:00',
    receivedLabel: 'Sep 4, 9:42 AM',
    receivedFullLabel: 'September 4, 2026 at 9:42 AM',
    preview: 'The quarantine berth is confirmed for your expected arrival…',
    unread: true,
    body: {
      kind: 'sanitized-html',
      content: '<p><strong>Hi Steve,</strong></p><p>The quarantine berth is confirmed for your expected arrival on 18 September. Please call the marina on VHF 73 before entering the basin.</p><p>I have attached the arrival instructions. The berth assignment can still change if your arrival time moves by more than six hours.</p><p>Regards,<br>Ana</p>',
    },
    attachments: [
      { id: 'demo-attachment-opua', name: 'Opua arrival instructions.pdf', mediaType: 'application/pdf', sizeLabel: '824 KB' },
    ],
    source: 'demo',
  },
  {
    id: 'demo-message-contract',
    threadId: 'demo-thread-contract',
    sender: { name: 'James Liu', address: 'james@acme.example', initials: 'JL' },
    subject: 'Re: Services agreement',
    receivedAt: '2026-09-04T08:16:00+12:00',
    receivedLabel: 'Sep 4, 8:16 AM',
    receivedFullLabel: 'September 4, 2026 at 8:16 AM',
    preview: 'I added our comments to sections 4 and 7. The pricing schedule…',
    unread: true,
    body: {
      kind: 'sanitized-html',
      content: '<p><strong>Steve,</strong></p><p>I added our comments to sections 4 and 7. The pricing schedule is acceptable, subject to the revised service-credit cap.</p><p>Can you confirm that the September 15 start date still works?</p><p>Best,<br>James</p>',
    },
    attachments: [
      { id: 'demo-attachment-contract', name: 'Services agreement redline.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeLabel: '146 KB' },
    ],
    source: 'demo',
  },
  {
    id: 'demo-message-invoice',
    threadId: 'demo-thread-invoice',
    sender: { name: 'OpenInvoice', address: 'notifications@openinvoice.example', initials: 'OP' },
    subject: 'Invoice status update',
    receivedAt: '2026-09-03T16:31:00+12:00',
    receivedLabel: 'Sep 3, 4:31 PM',
    receivedFullLabel: 'September 3, 2026 at 4:31 PM',
    preview: 'Invoice TKN-2026-0001 has moved to the next review stage…',
    unread: false,
    body: {
      kind: 'sanitized-html',
      content: '<p>Invoice <strong>TKN-2026-0001</strong> has moved to the next review stage.</p><p>No action is required from you at this time.</p>',
    },
    attachments: [],
    source: 'demo',
  },
]

export class DemoMailProvider {
  readonly #drafts = new Map<string, DraftProjection>()

  listMessages(): readonly MessageSummary[] {
    return messages.map(({ body: _body, attachments: _attachments, source: _source, ...summary }) => summary)
  }

  readMessage(id: string): MessageProjection | undefined {
    return messages.find((message) => message.id === id)
  }

  listRecipients(query: string): readonly MailAddress[] {
    const needle = query.trim().toLowerCase()
    const seen = new Map<string, MailAddress>()
    for (const message of messages) {
      const address = message.sender.address.toLowerCase()
      if (seen.has(address)) continue
      if (needle && !message.sender.name.toLowerCase().includes(needle) && !address.includes(needle)) continue
      seen.set(address, message.sender)
    }
    return [...seen.values()].slice(0, 20)
  }

  listConversations(state: MailStateFilter): readonly ConversationSummary[] {
    return groupConversations(messages, state)
  }

  readConversation(threadId: string): ConversationProjection | undefined {
    const thread = messages.filter((message) => message.threadId === threadId)
    return thread.length > 0 ? projectConversation(thread, 'demo') : undefined
  }

  createDraft(messageId: string, fields?: { bodyMarkdown?: string }): DraftProjection | undefined {
    const message = this.readMessage(messageId)
    if (!message) return undefined
    const defaultBodyMarkdown = `Hi ${message.sender.name.split(' ')[0] ?? message.sender.name},\n\nThank you.\n\nRegards,\nSteve`
    const bodyMarkdown = typeof fields?.bodyMarkdown === 'string' ? fields.bodyMarkdown : defaultBodyMarkdown
    const draft = projectDraft({
      id: `demo-draft-${message.id}`,
      inReplyToMessageId: message.id,
      to: [message.sender],
      subject: message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
      bodyMarkdown,
    })
    this.#drafts.set(draft.id, draft)
    return draft
  }

  readDraft(draftId: string): DraftProjection | undefined {
    return this.#drafts.get(draftId)
  }

  discardDraft(draftId: string): boolean {
    return this.#drafts.delete(draftId)
  }

  readAttachment(messageId: string, attachmentId: string): { filename: string; mime_type: string; data: string } | undefined {
    const message = this.readMessage(messageId)
    const attachment = message?.attachments.find((item) => item.id === attachmentId)
    if (!attachment) return undefined
    const bytes = attachment.mediaType === 'application/pdf' ? demoPdf() : demoDocx(attachment.name)
    return { filename: attachment.name, mime_type: attachment.mediaType, data: bytes.toString('base64') }
  }
}

function demoPdf(): Buffer {
  return Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
}

function demoDocx(title: string): Buffer {
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${title}</w:t></w:r></w:p></w:body></w:document>`) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') },
  ])
}

function zipStore(files: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local, file.data)
    const header = Buffer.alloc(46 + name.length)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(file.data.length, 20)
    header.writeUInt32LE(file.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    name.copy(header, 46)
    central.push(header)
    offset += local.length + file.data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
