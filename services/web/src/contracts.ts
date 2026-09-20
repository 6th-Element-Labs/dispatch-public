export interface MailAddress {
  readonly name: string
  readonly address: string
  readonly initials: string
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
  readonly body: { readonly kind: 'sanitized-html' | 'plain-text'; readonly content: string }
  readonly attachments: readonly { readonly id: string; readonly name: string; readonly mediaType: string; readonly sizeLabel: string; readonly contentId?: string }[]
  readonly to?: readonly MailAddress[]
  readonly cc?: readonly MailAddress[]
  readonly bcc?: readonly MailAddress[]
  readonly labels?: readonly string[]
  readonly source: 'demo' | 'gmail'
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
  readonly attachments: readonly {
    readonly id?: string
    readonly name: string
    readonly mediaType: string
    readonly contentBase64?: string
    readonly sizeLabel?: string
    readonly sourceMessageId?: string
  }[]
  readonly state: 'draft'
  readonly accountId?: string
}

export interface DispatchModel {
  readonly id: string
  readonly label: string
  readonly efforts: readonly string[]
  readonly exhausted: boolean | null
  readonly resetsAt: number | null
}

export interface DispatchModelCatalog {
  readonly models: readonly DispatchModel[]
  readonly defaults: { readonly model: string; readonly effort: string }
  readonly rateLimitsError: string | null
}

export interface AppSummary {
  readonly id: string
  readonly name: string
  readonly isAccessible: boolean
  readonly isEnabled: boolean
}

export interface GmailAccount {
  readonly id: string
  readonly connectorId: string
  readonly name: string
  readonly email: string
}

export type MailStateFilter = 'all' | 'unread' | 'read'
export type GmailMailbox = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash'
export interface MailboxCounts { readonly inbox: number; readonly drafts: number; readonly spam: number }
export type GmailConversationAction = 'archive' | 'spam' | 'trash' | 'inbox'

export interface GmailSyncStatus {
  readonly mailRevision?: number
  readonly draftsRevision?: number
  readonly state: 'idle' | 'syncing' | 'partial' | 'ready' | 'failed'
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly error: string | null
  readonly messageCount: number
  readonly accountCount?: number
  readonly accountsCompleted?: number
  readonly pagesFetched?: number
  readonly fetchedMessages?: number
  readonly currentAccount?: string | null
}

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


export interface SearchHit { readonly messageId: string; readonly quote: string; readonly excerpt: string; readonly matchStart: number; readonly matchEnd: number; readonly reason: string }
export interface SearchResult { readonly conversation: ConversationSummary; readonly hits: readonly SearchHit[] }
export interface SearchResults { readonly query: string; readonly requestId?: string; readonly results: readonly SearchResult[] }

export interface ReceiptDetails { to: string[]; cc: string[]; bcc: string[]; subject: string; attachments: { name: string; mediaType: string; sizeLabel?: string }[] }
export interface SendReceipt {
  id: string; accountId: string; accountLabel: string; draftId?: string; messageId?: string
  status: 'preparing' | 'sending' | 'accepted' | 'verified' | 'failed' | 'unknown'
  requestedAt: string; acceptedAt?: string; verifiedAt?: string; sentAt?: string
  detailsSource: 'draft' | 'sent-message' | 'unavailable'; details?: ReceiptDetails; intended?: ReceiptDetails
  error?: string; warnings?: string[]
}
export interface OfflineDownload { id: string; state: 'running' | 'complete' | 'partial' | 'cancelled' | 'interrupted'; mailbox: string; accountId?: string; total: number; completed: number; errors: string[]; startedAt: string }


export interface OfflineStatus { conversations: number; bytes: number; download?: OfflineDownload }
