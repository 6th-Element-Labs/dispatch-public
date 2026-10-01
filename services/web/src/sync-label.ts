/**
 * The mail service fails a refresh with one `<account>: <error>` entry per failed account,
 * joined by '; '. Naming those accounts keeps a rate limit on one account from reading as
 * every account's mail being stale.
 */
export function waitingForGmailLabel(error: string | null | undefined): string {
  const accounts = [...new Set([...(error ?? '').matchAll(/(?:^|; )(?:Error: )?([^\s:;]+@[^\s:;]+): /g)].map(match => match[1]))]
  return accounts.length ? `Waiting for Gmail · ${accounts.join(', ')}` : 'Waiting for Gmail'
}
