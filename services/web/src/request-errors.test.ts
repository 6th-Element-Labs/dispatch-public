import { describe, expect, it } from 'vitest'
import { describeRequestError, requestErrorCode } from './request-errors.js'

describe('describeRequestError', () => {
  it('maps known service codes to a sentence', () => {
    expect(describeRequestError('Request failed (404): {"error":"gmail_draft_not_found","detail":"Gmail draft r-77 was not found"}')).toBe('Gmail no longer has this draft. It was sent, deleted, or replaced.')
    expect(describeRequestError('Request failed (502): {"error":"codex_binding_failed","detail":"thread x already has an active writer"}')).toBe('Codex could not open the chat for this email.')
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
