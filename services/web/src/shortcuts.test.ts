import { describe, expect, it } from 'vitest'
import { SHORTCUT_GROUPS, TOOLBAR_KEYS, resolveShortcut } from './shortcuts.js'

const press = (key: string, extra: Partial<KeyboardEvent> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra })

describe('resolveShortcut', () => {
  it('maps Gmail letters to commands', () => {
    expect(resolveShortcut(press('r'), false)).toEqual({ command: 'reply' })
    expect(resolveShortcut(press('A'), false)).toEqual({ command: 'replyAll' })
    expect(resolveShortcut(press('e'), false)).toEqual({ command: 'archive' })
    expect(resolveShortcut(press('!', { shiftKey: true }), false)).toEqual({ command: 'spam' })
    expect(resolveShortcut(press('#', { shiftKey: true }), false)).toEqual({ command: 'trash' })
    expect(resolveShortcut(press('u'), false)).toEqual({ command: 'toggleRead' })
    expect(resolveShortcut(press('j'), false)).toEqual({ command: 'next' })
    expect(resolveShortcut(press('k'), false)).toEqual({ command: 'previous' })
    expect(resolveShortcut(press('c'), false)).toEqual({ command: 'compose' })
    expect(resolveShortcut(press('?', { shiftKey: true }), false)).toEqual({ command: 'help' })
  })

  it('treats G as a chord prefix for folders', () => {
    expect(resolveShortcut(press('g'), false)).toEqual({ pendingGo: true })
    expect(resolveShortcut(press('i'), true)).toEqual({ command: { goto: 'inbox' } })
    expect(resolveShortcut(press('t'), true)).toEqual({ command: { goto: 'trash' } })
    expect(resolveShortcut(press('x'), true)).toBeUndefined()
  })

  it('ignores modifier combinations except Cmd-Enter', () => {
    expect(resolveShortcut(press('e', { metaKey: true }), false)).toBeUndefined()
    expect(resolveShortcut(press('e', { altKey: true }), false)).toBeUndefined()
    expect(resolveShortcut(press('Enter', { metaKey: true }), false)).toEqual({ command: 'ask' })
    expect(resolveShortcut(press('x'), false)).toBeUndefined()
  })

  it('lists every toolbar key in the cheat sheet', () => {
    const shown = SHORTCUT_GROUPS.flatMap((group) => group.items.map((item) => item.keys)).join(' ')
    for (const key of Object.values(TOOLBAR_KEYS)) expect(shown).toContain(key)
  })
})
