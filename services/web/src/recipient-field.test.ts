import { describe, expect, it } from 'vitest'
import { commitRecipientToken, parseRecipientList, serializeRecipientList } from './recipient-field.js'

describe('recipient field', () => {
  it('keeps a typed address in the leftover input until a separator arrives', () => {
    expect(commitRecipientToken('client@example.com')).toEqual({
      committed: [],
      leftover: 'client@example.com',
    })
    expect(commitRecipientToken('client@example.com, ')).toEqual({
      committed: ['client@example.com'],
      leftover: '',
    })
  })

  it('serializes chips plus leftover input for the mail API', () => {
    expect(parseRecipientList('ana@example.com, ops@example.com')).toEqual(['ana@example.com', 'ops@example.com'])
    expect(serializeRecipientList(['ana@example.com'], 'ops@example.com')).toBe('ana@example.com, ops@example.com')
  })
})
