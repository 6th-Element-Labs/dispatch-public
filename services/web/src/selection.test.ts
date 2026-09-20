import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, decodeDragPayload, dropActionForMailbox, encodeDragPayload, moveLabel, pruneSelection, selectionAfterArrow, selectionAfterClick, undoActionsFor } from './selection.js'

const order = ['a', 'b', 'c', 'd', 'e']

describe('selectionAfterClick', () => {
  it('selects one row and sets the anchor on a plain click', () => {
    expect(selectionAfterClick(EMPTY_SELECTION, order, 'c')).toEqual({ ids: ['c'], anchor: 'c' })
  })

  it('selects the range from the anchor on shift-click in either direction', () => {
    const state = selectionAfterClick(EMPTY_SELECTION, order, 'c')
    expect(selectionAfterClick(state, order, 'e', { shift: true })).toEqual({ ids: ['c', 'd', 'e'], anchor: 'c' })
    expect(selectionAfterClick(state, order, 'a', { shift: true })).toEqual({ ids: ['a', 'b', 'c'], anchor: 'c' })
  })

  it('replaces the range on a second shift-click instead of growing it', () => {
    let state = selectionAfterClick(EMPTY_SELECTION, order, 'b')
    state = selectionAfterClick(state, order, 'e', { shift: true })
    expect(selectionAfterClick(state, order, 'c', { shift: true }).ids).toEqual(['b', 'c'])
  })

  it('toggles a row on cmd-click and keeps list order', () => {
    let state = selectionAfterClick(EMPTY_SELECTION, order, 'd')
    state = selectionAfterClick(state, order, 'a', { toggle: true })
    expect(state).toEqual({ ids: ['a', 'd'], anchor: 'a' })
    state = selectionAfterClick(state, order, 'd', { toggle: true })
    expect(state.ids).toEqual(['a'])
  })

  it('uses the clicked row as anchor when the old anchor left the list', () => {
    const state = { ids: ['zz'], anchor: 'zz' }
    expect(selectionAfterClick(state, order, 'b', { shift: true })).toEqual({ ids: ['b'], anchor: 'b' })
  })

  it('ignores rows that are not listed', () => {
    const state = selectionAfterClick(EMPTY_SELECTION, order, 'b')
    expect(selectionAfterClick(state, order, 'zz')).toBe(state)
  })
})

describe('selectionAfterArrow', () => {
  it('moves one row and extends with shift', () => {
    let state = selectionAfterClick(EMPTY_SELECTION, order, 'b')
    state = selectionAfterArrow(state, order, 1, false)
    expect(state).toEqual({ ids: ['c'], anchor: 'c' })
    state = selectionAfterArrow(state, order, 1, true)
    expect(state.ids).toEqual(['c', 'd'])
    state = selectionAfterArrow(state, order, -1, true)
    expect(state.ids).toEqual(['b', 'c'])
  })

  it('starts from the first row with nothing selected and clamps at the ends', () => {
    expect(selectionAfterArrow(EMPTY_SELECTION, order, 1, false).ids).toEqual(['a'])
    expect(selectionAfterArrow({ ids: ['e'], anchor: 'e' }, order, 1, false).ids).toEqual(['e'])
  })
})

describe('pruneSelection', () => {
  it('drops ids that left the list and reanchors', () => {
    expect(pruneSelection({ ids: ['a', 'x', 'c'], anchor: 'x' }, order)).toEqual({ ids: ['a', 'c'], anchor: 'a' })
  })
})

describe('drag payload', () => {
  it('round-trips ids and rejects junk', () => {
    expect(decodeDragPayload(encodeDragPayload(['a', 'b']))).toEqual(['a', 'b'])
    expect(decodeDragPayload('not json')).toEqual([])
    expect(decodeDragPayload(JSON.stringify([1, 'a']))).toEqual(['a'])
    expect(decodeDragPayload(undefined)).toEqual([])
  })
})

describe('dropActionForMailbox', () => {
  it('maps folder targets to the existing actions and refuses no-op drops', () => {
    expect(dropActionForMailbox('archive', 'inbox')).toBe('archive')
    expect(dropActionForMailbox('trash', 'inbox')).toBe('trash')
    expect(dropActionForMailbox('spam', 'archive')).toBe('spam')
    expect(dropActionForMailbox('inbox', 'trash')).toBe('inbox')
    expect(dropActionForMailbox('inbox', 'inbox')).toBeUndefined()
    expect(dropActionForMailbox('archive', 'trash')).toBeUndefined()
    expect(dropActionForMailbox('sent', 'inbox')).toBeUndefined()
    expect(dropActionForMailbox('drafts', 'inbox')).toBeUndefined()
    expect(dropActionForMailbox('trash', 'drafts')).toBeUndefined()
  })
})

describe('undo', () => {
  it('labels a move by action and count', () => {
    expect(moveLabel('trash', 1)).toBe('Moved 1 conversation to Trash')
    expect(moveLabel('archive', 3)).toBe('Archived 3 conversations')
    expect(moveLabel('spam', 2)).toBe('Marked 2 conversations as spam')
    expect(moveLabel('inbox', 2)).toBe('Moved 2 conversations to Inbox')
  })

  it('restores a thread to the folder it came from', () => {
    expect(undoActionsFor('archive', 'inbox')).toEqual(['inbox'])
    expect(undoActionsFor('trash', 'inbox')).toEqual(['inbox'])
    expect(undoActionsFor('trash', 'archive')).toEqual(['inbox', 'archive'])
    expect(undoActionsFor('spam', 'archive')).toEqual(['inbox', 'archive'])
    expect(undoActionsFor('inbox', 'trash')).toEqual(['trash'])
    expect(undoActionsFor('inbox', 'archive')).toEqual(['archive'])
    expect(undoActionsFor('inbox', 'inbox')).toEqual([])
  })
})
