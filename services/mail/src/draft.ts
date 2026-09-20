import { renderDraftMarkdown } from './draft-markdown.js'
import TurndownService from 'turndown'
import type { DraftAttachment, DraftProjection, MailAddress, MessageProjection } from './model.js'

export interface DraftFields {
  readonly id: string
  readonly inReplyToMessageId: string
  readonly to: readonly MailAddress[]
  readonly cc?: string
  readonly bcc?: string
  readonly subject: string
  readonly bodyMarkdown: string
  readonly attachments?: readonly DraftAttachment[]
  readonly accountId?: string
}

export function projectDraft(fields: DraftFields): DraftProjection {
  const bodyMarkdown = fields.bodyMarkdown
  return {
    id: fields.id,
    inReplyToMessageId: fields.inReplyToMessageId,
    to: fields.to,
    cc: fields.cc ?? '',
    bcc: fields.bcc ?? '',
    subject: fields.subject,
    bodyMarkdown,
    bodyHtml: renderDraftMarkdown(bodyMarkdown),
    bodyText: bodyMarkdown,
    attachments: fields.attachments ?? [],
    state: 'draft',
    accountId: fields.accountId,
  }
}

export function plainBodyFromMessage(message: MessageProjection): string {
  if (message.body.kind === 'plain-text') return message.body.content.trim()
  const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
  converter.remove(['script', 'style'])
  converter.keep(['table', 'sub', 'sup'])
  return converter.turndown(message.body.content)
}

export function quoteReplyMarkdown(message: MessageProjection): string {
  const quoted = plainBodyFromMessage(message).split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')
  return `\n\n${quoted}`
}
