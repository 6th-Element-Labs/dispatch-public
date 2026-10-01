import { createHash } from 'node:crypto'
import { renderDraftMarkdown } from './draft-markdown.js'
import TurndownService from 'turndown'
import type { DraftSaveFields } from './draft-save-queue.js'
import type { DraftAttachment, DraftProjection } from './model.js'

export const draftFields = ['to', 'cc', 'bcc', 'subject', 'bodyMarkdown', 'attachments'] as const
export type DraftField = typeof draftFields[number]
const markdown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
markdown.keep(['table', 'sub', 'sup'])
const addresses = (value = '') => value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(value => (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase()).filter(Boolean).sort().join(',')
const text = (value = '') => markdown.turndown(renderDraftMarkdown(value)).replaceAll('\r\n', '\n').trim()
const bytesHash = (file: DraftAttachment) => file.contentBase64 === undefined ? undefined : createHash('sha256').update(Buffer.from(file.contentBase64, 'base64')).digest('hex')

function sameFiles(a: readonly DraftAttachment[] = [], b: readonly DraftAttachment[] = []): boolean {
  if (a.length !== b.length) return false
  const remaining = [...b]
  for (const file of a) {
    const match = remaining.findIndex(other => file.name === other.name && file.mediaType === other.mediaType
      && file.contentId === other.contentId
      && (file.contentBase64 !== undefined && other.contentBase64 !== undefined ? bytesHash(file) === bytesHash(other)
        : file.id || other.id ? file.id === other.id && file.sourceMessageId === other.sourceMessageId
          : file.contentBase64 === other.contentBase64 && file.sizeLabel === other.sizeLabel))
    if (match < 0) return false
    remaining.splice(match, 1)
  }
  return true
}

function draftValue(draft: DraftProjection, field: DraftField): unknown {
  return field === 'to' ? draft.to.map(item => item.address).join(', ') : draft[field]
}

function equal(field: DraftField, a: unknown, b: unknown): boolean {
  if (field === 'attachments') return sameFiles(a as readonly DraftAttachment[] | undefined, b as readonly DraftAttachment[] | undefined)
  if (field === 'bodyMarkdown') return text(a as string | undefined) === text(b as string | undefined)
  if (field === 'to' || field === 'cc' || field === 'bcc') return addresses(a as string | undefined) === addresses(b as string | undefined)
  return (a ?? '') === (b ?? '')
}

/** Preserve externally changed fields that the local editor did not change. */
export function draftChanges(fields: DraftSaveFields, base?: DraftProjection): DraftSaveFields {
  if (!base) return fields
  const changes = { ...fields }
  for (const field of draftFields) if (fields[field] !== undefined && equal(field, fields[field], draftValue(base, field))) delete changes[field]
  return changes
}

/** Detect a same-field conflict, while allowing already-applied retries and disjoint edits. */
export function conflictingDraftFields(fields: DraftSaveFields, base: DraftProjection | undefined, current: DraftProjection): DraftField[] {
  if (!base) return []
  return draftFields.filter(field => fields[field] !== undefined
    && !equal(field, fields[field], draftValue(base, field))
    && !equal(field, draftValue(base, field), draftValue(current, field))
    && !equal(field, fields[field], draftValue(current, field)))
}

export class DraftConflictError extends Error {
  readonly code = 'draft_conflict'
  constructor(readonly fields: readonly DraftField[], readonly remote: DraftProjection) {
    super(`draft_conflict: This draft changed in Gmail (${fields.map(field => field === 'bodyMarkdown' ? 'message' : field).join(', ')}). Both versions are kept. Review the Gmail version or keep your edits.`)
  }
}
