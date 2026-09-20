import type { ConversationProjection, ConversationSummary, GmailMailbox, MailStateFilter, MessageProjection, MessageSummary } from './model.js'

function key(message: MessageSummary): string {
  return `${message.accountId ?? 'demo'}:${message.threadId}`
}

export function summarizeConversation(messages: readonly MessageSummary[]): ConversationSummary {
  const ordered = [...messages].sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
  const latest = ordered.at(-1)
  if (!latest) throw new Error('Cannot summarize an empty conversation')
  return {
    id: key(latest),
    threadId: latest.threadId,
    accountId: latest.accountId,
    accountLabel: latest.accountLabel,
    latestMessageId: latest.id,
    sender: latest.sender,
    subject: latest.subject,
    receivedAt: latest.receivedAt,
    receivedLabel: latest.receivedLabel,
    receivedFullLabel: latest.receivedFullLabel,
    preview: latest.preview,
    unread: ordered.some((message) => message.unread),
    hasAttachment: ordered.some((message) => message.hasAttachment === true),
    messageCount: ordered.length,
  }
}

export function groupConversations(messages: readonly MessageSummary[], state: MailStateFilter): readonly ConversationSummary[] {
  const groups = new Map<string, MessageSummary[]>()
  for (const message of messages) {
    const messagesForThread = groups.get(key(message)) ?? []
    messagesForThread.push(message)
    groups.set(key(message), messagesForThread)
  }
  return [...groups.values()]
    .map(summarizeConversation)
    .filter((conversation) => state === 'all' || (state === 'unread' ? conversation.unread : !conversation.unread))
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
}

export function projectConversation(messages: readonly MessageProjection[], source: 'demo' | 'gmail'): ConversationProjection {
  const chronological = [...messages].sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
  return { ...summarizeConversation(chronological), hasAttachment: chronological.some((message) => message.attachments.length > 0), messageCount: chronological.length, messages: chronological.reverse(), source }
}

export function replySourceMessage(conversation: ConversationProjection): MessageProjection {
  const latest = conversation.messages.find((message) => message.id === conversation.latestMessageId)
  if (!latest) throw new Error('Conversation is missing its latest message')
  return latest
}

/** A raw Gmail thread can contain drafts and trashed messages. They are not inbox mail. */
export function conversationForMailbox(conversation: ConversationProjection, mailbox: GmailMailbox): ConversationProjection {
  const visible = conversation.messages.filter(message => {
    const labels = new Set(message.labels ?? [])
    if (mailbox === 'trash') return labels.has('TRASH')
    if (mailbox === 'drafts') return labels.has('DRAFT') && !labels.has('TRASH')
    if (mailbox === 'spam') return labels.has('SPAM') && !labels.has('TRASH')
    return !labels.has('TRASH') && !labels.has('SPAM') && !labels.has('DRAFT')
  })
  if (!visible.length) throw Object.assign(new Error(`No messages in this conversation are available in ${mailbox}. Refresh the mailbox.`), { code: 'conversation_not_in_mailbox' })
  return projectConversation(visible, conversation.source)
}
