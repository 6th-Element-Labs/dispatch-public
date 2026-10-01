import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { describeRequestError, requestErrorCode } from './request-errors.js'

describe('describeRequestError', () => {
  it('maps known service codes to a sentence', () => {
    expect(describeRequestError('Request failed (404): {"error":"gmail_draft_not_found","detail":"Gmail draft r-77 was not found"}')).toBe('Gmail no longer has this draft. It was sent, deleted, or replaced.')
    expect(describeRequestError('Request failed (502): {"error":"codex_binding_failed","detail":"thread x already has an active writer"}')).toBe('Codex could not open the chat for this email.')
  })

  it('names the local time Gmail asked Dispatch to wait until, with the date when it is not today', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T10:40:00.000Z'))
    onTestFinished(() => { vi.useRealTimers() })
    const until = new Date('2026-09-24T10:54:58.101Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const later = new Date('2026-09-26T10:54:58.101Z').toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    expect(describeRequestError('Request failed (502): {"error":"gmail_backoff","detail":"Gmail is rate limiting this account. Retry after 2026-09-26T10:54:58.101Z"}')).toBe(`Gmail is limiting requests from this account until ${later}. Try again then.`)
    expect(describeRequestError('Request failed (502): {"error":"gmail_backoff","detail":"Gmail is rate limiting this account. Retry after 2026-09-24T10:54:58.101Z"}')).toBe(`Gmail is limiting requests from this account until ${until}. Try again then.`)
    expect(describeRequestError('Request failed (502): {"error":"gmail_backoff","detail":"Gmail is rate limiting this account."}')).toBe('Gmail is limiting requests from this account. Try again in a few minutes.')
    expect(describeRequestError('Request failed (502): {"error":"gmail_read_failed","detail":"Gmail is rate limiting this account. Retry after 2026-09-24T10:54:58.101Z: {\\"isError\\":true}"}')).toBe(`Gmail is limiting requests from this account until ${until}. Try again then.`)
  })

  it('falls back to a short detail, then a generic sentence', () => {
    expect(describeRequestError('Request failed (400): {"error":"odd_code","detail":"Attachments must be under 25 MB."}')).toBe('Attachments must be under 25 MB.')
    expect(describeRequestError('Request failed (500): {"error":"weird","detail":"{\\"nested\\":true}"}')).toBe('The mail service refused this request (weird). Try again.')
    expect(describeRequestError('Request failed (503): {}')).toBe('The mail service refused this request (503). Try again.')
  })

  it('leaves plain messages alone', () => {
    expect(describeRequestError('The draft changed before sending. Review it again.')).toBe('The draft changed before sending. Review it again.')
    expect(requestErrorCode('no json here')).toBeUndefined()
  })
})
