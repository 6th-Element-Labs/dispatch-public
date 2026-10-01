import { describe, expect, it } from 'vitest'
import { waitingForGmailLabel } from './sync-label.js'

describe('waitingForGmailLabel', () => {
  it('names only the accounts Gmail is holding back', () => {
    expect(waitingForGmailLabel('Error: steve@6elementlabs.com: Error: Gmail is rate limiting this account. Retry after 2026-09-24T11:05:01.424Z')).toBe('Waiting for Gmail · steve@6elementlabs.com')
    expect(waitingForGmailLabel('Error: a@example.com: Error: RATE_LIMITED; b@example.com: Error: Gmail is rate limiting this account. Retry after 2026-09-24T11:05:01.424Z; a@example.com: again')).toBe('Waiting for Gmail · a@example.com, b@example.com')
  })

  it('stays general when the error names no account', () => {
    expect(waitingForGmailLabel('Error: Gmail is rate limiting this account. Retry after 2026-09-24T11:05:01.424Z')).toBe('Waiting for Gmail')
    expect(waitingForGmailLabel(null)).toBe('Waiting for Gmail')
  })
})
