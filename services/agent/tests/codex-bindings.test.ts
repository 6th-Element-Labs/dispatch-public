import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindingRecordKey, CodexBindingStore, defaultCodexWorkspace } from '../src/codex-bindings.js'

describe('CodexBindingStore', () => {
  it('keeps the Codex workspace out of the Dispatch repository', () => {
    expect(defaultCodexWorkspace()).toContain('Application Support/Dispatch/codex-workspace')
    expect(defaultCodexWorkspace()).not.toContain('/Git/dispatch')
  })

  it('encodes unbound and conversation keys', () => {
    expect(bindingRecordKey({ kind: 'unbound' })).toBe('unbound')
    expect(bindingRecordKey({ kind: 'conversation', accountId: 'link-one', gmailThreadId: 't1' })).toBe('conversation:link-one:t1')
  })

  it('persists a binding and reloads it', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'dispatch-bindings-')), 'codex-bindings.json')
    const first = new CodexBindingStore(path)
    await first.put({ kind: 'unbound' }, 'thread-unbound')
    await first.put({ kind: 'conversation', accountId: 'one', gmailThreadId: 't1' }, 'thread-t1')
    const second = new CodexBindingStore(path)
    await second.load()
    expect(second.get({ kind: 'unbound' })).toBe('thread-unbound')
    expect(second.get({ kind: 'conversation', accountId: 'one', gmailThreadId: 't1' })).toBe('thread-t1')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      unbound: 'thread-unbound',
      'conversation:one:t1': 'thread-t1',
    })
  })

  it('replaces a dead thread id for the same key', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'dispatch-bindings-')), 'codex-bindings.json')
    const store = new CodexBindingStore(path)
    await store.put({ kind: 'unbound' }, 'old')
    await store.replace({ kind: 'unbound' }, 'new')
    expect(store.get({ kind: 'unbound' })).toBe('new')
  })

  it('keeps two new compose tasks separate and persists concurrent bindings', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'dispatch-compose-bindings-')), 'bindings.json')
    const store = new CodexBindingStore(path)
    await Promise.all([store.put({ kind: 'draft', draftKey: 'one' }, 'task-one'), store.put({ kind: 'draft', draftKey: 'two' }, 'task-two')])
    const reopened = new CodexBindingStore(path)
    await reopened.load()
    expect(reopened.get({ kind: 'draft', draftKey: 'one' })).toBe('task-one')
    expect(reopened.get({ kind: 'draft', draftKey: 'two' })).toBe('task-two')
    expect(reopened.get({ kind: 'unbound' })).toBeUndefined()
  })

  it('fails in the open when the file cannot be written', async () => {
    const store = new CodexBindingStore('/dev/null/codex-bindings.json')
    await expect(store.put({ kind: 'unbound' }, 'thread-1')).rejects.toThrow()
  })
})
