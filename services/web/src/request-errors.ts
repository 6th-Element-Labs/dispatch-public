/** Turns a raw service failure into a sentence for the Codex pane and draft footer; the raw text stays in the log. */
const MESSAGES: Readonly<Record<string, string>> = {
  gmail_draft_not_found: 'Gmail no longer has this draft. It was sent, deleted, or replaced.',
  codex_binding_failed: 'Codex could not open the chat for this email.',
  codex_thread_busy: 'This chat is open in another Codex app.',
  gmail_unavailable: 'Gmail is unavailable right now.',
  gmail_action_failed: 'Gmail could not apply that change.',
  gmail_conversation_list_failed: 'Gmail could not list this folder.',
  gmail_not_connected: 'No Gmail account is connected.',
}

export function requestErrorCode(text: string): string | undefined {
  const match = /"error"\s*:\s*"([a-z0-9_]+)"/i.exec(text)
  return match?.[1]
}

export function describeRequestError(text: string): string {
  if (!/Request failed \(\d+\)|\{"error"/.test(text)) return text
  const code = requestErrorCode(text)
  if (code === 'gmail_backoff' || /Gmail is rate limiting this account/.test(text)) {
    // Gmail rate limited the account and named when to retry; the mail service blocks calls until then.
    // Some routes wrap it in their own code, so the sentence is matched as well.
    const until = new Date(/Retry after (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(text)?.[1] ?? '')
    if (Number.isNaN(until.getTime())) return 'Gmail is limiting requests from this account. Try again in a few minutes.'
    const today = until.toDateString() === new Date().toDateString()
    return `Gmail is limiting requests from this account until ${until.toLocaleString([], today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Try again then.`
  }
  if (code && MESSAGES[code]) return MESSAGES[code]
  const status = /Request failed \((\d+)\)/.exec(text)?.[1]
  const detail = /"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]?.replace(/\\"/g, '"')
  if (detail && detail.length < 160 && !/[{}]/.test(detail)) return detail
  return status ? `The mail service refused this request (${code ?? status}). Try again.` : 'The mail service refused this request. Try again.'
}
