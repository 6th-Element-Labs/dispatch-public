export interface MailAddress {
  readonly name: string
  readonly address: string
  readonly initials: string
}

export interface AttachmentProjection {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly sizeLabel: string
  readonly contentId?: string
}

export interface MessageSummary {
  readonly id: string
  readonly threadId: string
  readonly sender: MailAddress
  readonly subject: string
  readonly receivedAt: string
  readonly receivedLabel: string
  readonly receivedFullLabel: string
  readonly preview: string
  readonly unread: boolean
  readonly hasAttachment?: boolean
  readonly accountId?: string
  readonly accountLabel?: string
}

export interface MessageProjection extends MessageSummary {
  readonly body: {
    readonly kind: 'sanitized-html' | 'plain-text'
    readonly content: string
  }
  readonly attachments: readonly AttachmentProjection[]
  readonly to?: readonly MailAddress[]
  readonly cc?: readonly MailAddress[]
  readonly bcc?: readonly MailAddress[]
  readonly labels?: readonly string[]
  readonly source: 'demo' | 'gmail'
}

export interface DraftAttachment {
  readonly contentId?: string
  readonly id?: string
  readonly name: string
  readonly mediaType: string
  readonly contentBase64?: string
  readonly sizeLabel?: string
  readonly sourceMessageId?: string
}

export interface DraftProjection {
  readonly cachedAt?: string
  readonly gmailThreadId?: string
  readonly gmailMessageId?: string
  readonly id: string
  readonly inReplyToMessageId: string
  readonly to: readonly MailAddress[]
  readonly cc?: string
  readonly bcc?: string
  readonly subject: string
  readonly bodyMarkdown: string
  readonly bodyHtml: string
  readonly bodyText: string
  readonly attachments: readonly DraftAttachment[]
  readonly state: 'draft'
  readonly accountId?: string
}

export type MailStateFilter = 'all' | 'unread' | 'read'
export type GmailMailbox = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash'

/** Folder badges: unread conversations in Inbox, total conversations in Drafts and Spam. */
export interface MailboxCounts { readonly inbox: number; readonly drafts: number; readonly spam: number }
export type GmailConversationAction = 'archive' | 'spam' | 'trash' | 'inbox'

export interface ConversationSummary {
  readonly id: string
  readonly threadId: string
  readonly accountId?: string
  readonly accountLabel?: string
  readonly latestMessageId: string
  readonly sender: MailAddress
  readonly subject: string
  readonly receivedAt: string
  readonly receivedLabel: string
  readonly receivedFullLabel: string
  readonly preview: string
  readonly unread: boolean
  readonly hasAttachment?: boolean
  readonly messageCount: number
  readonly downloaded?: boolean
}

export interface ConversationProjection extends ConversationSummary {
  readonly availability?: { readonly mode: 'live' | 'downloaded'; readonly cachedAt: string; readonly reason?: string }
  readonly messages: readonly MessageProjection[]
  readonly source: 'demo' | 'gmail'
}
