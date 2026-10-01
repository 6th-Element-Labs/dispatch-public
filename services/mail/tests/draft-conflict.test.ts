import { expect, it } from 'vitest'
import { projectDraft } from '../src/draft.js'
import { conflictingDraftFields, draftChanges } from '../src/draft-conflict.js'

const base = () => projectDraft({ id: 'draft', accountId: 'one', inReplyToMessageId: '', to: [{ address: 'one@example.com', name: 'One', initials: 'O' }], cc: '', subject: 'Subject', bodyMarkdown: 'Original', attachments: [] })

it('preserves externally edited fields when the editor submitted unchanged placeholders', () => {
  const original = base()
  expect(draftChanges({ to: 'One <one@example.com>', cc: '', subject: 'Subject', bodyMarkdown: 'Local edit', attachments: [] }, original)).toEqual({ bodyMarkdown: 'Local edit' })
  const external = { ...original, subject: 'External subject', cc: 'new@example.com' }
  expect(conflictingDraftFields({ bodyMarkdown: 'Local edit' }, original, external)).toEqual([])
})

it('detects external edits to the same fields but accepts already applied retries', () => {
  const original = base()
  const external = { ...original, bodyMarkdown: 'External edit', subject: 'Remote title' }
  expect(conflictingDraftFields({ bodyMarkdown: 'Local edit', subject: 'Local title' }, original, external)).toEqual(['subject', 'bodyMarkdown'])
  expect(conflictingDraftFields({ bodyMarkdown: 'Local edit' }, original, { ...external, bodyMarkdown: 'Local edit' })).toEqual([])
})

it('does not strip intentional paragraph or formatting changes as unchanged text', () => {
  const original = { ...base(), bodyMarkdown: 'First paragraph\n\nSecond paragraph' }
  expect(draftChanges({ bodyMarkdown: 'First paragraph Second paragraph' }, original)).toHaveProperty('bodyMarkdown')
  expect(draftChanges({ bodyMarkdown: '**First paragraph**\n\nSecond paragraph' }, original)).toHaveProperty('bodyMarkdown')
})

it('compares attachment bytes and multiplicity, rather than only filenames', () => {
  const file = { name: 'same.txt', mediaType: 'text/plain', contentBase64: Buffer.from('original').toString('base64') }
  const original = { ...base(), attachments: [file] }
  expect(draftChanges({ attachments: [{ ...file }] }, original)).toEqual({})
  const current = { ...original, attachments: [{ ...file, contentBase64: Buffer.from('external').toString('base64') }] }
  expect(conflictingDraftFields({ attachments: [] }, original, current)).toEqual(['attachments'])
  expect(draftChanges({ attachments: [file, file] }, original)).toHaveProperty('attachments')
})
