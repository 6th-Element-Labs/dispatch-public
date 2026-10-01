import { describe, expect, it } from 'vitest'
import { DraftEditLocks } from './draft-edit-locks.js'

/** An in-memory LockManager shared by several "windows", granting exclusive locks in request order. */
function lockManager() {
  const holders = new Map<string, number>()
  const queues = new Map<string, Array<() => void>>()
  let nextClient = 0
  return {
    client() {
      const id = ++nextClient
      return {
        async request(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<void>) {
          if (holders.has(name)) await new Promise<void>((resolve) => queues.set(name, [...(queues.get(name) ?? []), resolve]))
          holders.set(name, id)
          try { await callback() } finally {
            holders.delete(name)
            const [next, ...rest] = queues.get(name) ?? []
            queues.set(name, rest)
            next?.()
          }
        },
        async query() { return { held: [...holders.keys()].map((name) => ({ name })) } },
      }
    },
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('DraftEditLocks', () => {
  it('reports a draft another window is editing, by local key and by Gmail id', async () => {
    const manager = lockManager()
    const pop = new DraftEditLocks(manager.client())
    const main = new DraftEditLocks(manager.client())
    pop.hold({ localKey: 'reply-1', gmailDraftId: 'd1' })
    await settle()
    expect(await main.heldElsewhere({ localKey: 'reply-1' })).toBe(true)
    expect(await main.heldElsewhere({ gmailDraftId: 'd1' })).toBe(true)
    expect(await main.heldElsewhere({ gmailDraftId: 'd2' })).toBe(false)
    expect([...await main.localKeysHeldElsewhere()]).toEqual(['reply-1'])
    // A window's own draft is never "elsewhere".
    expect(await pop.heldElsewhere({ localKey: 'reply-1', gmailDraftId: 'd1' })).toBe(false)
    expect((await pop.localKeysHeldElsewhere()).size).toBe(0)
  })

  it('scopes Gmail draft edit locks by account', async () => {
    const manager = lockManager()
    const first = new DraftEditLocks(manager.client())
    const second = new DraftEditLocks(manager.client())
    first.hold({ accountId: 'work', gmailDraftId: 'same-id' })
    await settle()
    expect(await second.heldElsewhere({ accountId: 'work', gmailDraftId: 'same-id' })).toBe(true)
    expect(await second.heldElsewhere({ accountId: 'personal', gmailDraftId: 'same-id' })).toBe(false)
  })

  it('follows the draft as its identity changes and releases it when the editor closes', async () => {
    const manager = lockManager()
    const pop = new DraftEditLocks(manager.client())
    const main = new DraftEditLocks(manager.client())
    pop.hold({ localKey: 'first' })
    await settle()
    // Saving clears the recovery copy; the next edit checkpoints under a new key.
    pop.hold({ gmailDraftId: 'd1' })
    pop.hold({ localKey: 'second', gmailDraftId: 'd1' })
    await settle()
    expect([...await main.localKeysHeldElsewhere()]).toEqual(['second'])
    expect(await main.heldElsewhere({ gmailDraftId: 'd1' })).toBe(true)
    pop.hold(undefined)
    await settle()
    expect(await main.heldElsewhere({ localKey: 'second', gmailDraftId: 'd1' })).toBe(false)
  })

  it('keeps a re-held lock its own when the earlier request settles late', async () => {
    const manager = lockManager()
    const pop = new DraftEditLocks(manager.client())
    pop.hold({ localKey: 'k' })
    await settle()
    pop.hold(undefined)
    pop.hold({ localKey: 'k' })
    await settle(); await settle()
    expect(await pop.heldElsewhere({ localKey: 'k' })).toBe(false)
  })

  it('without a lock manager, holds nothing and sees nothing', async () => {
    const locks = new DraftEditLocks(undefined)
    locks.hold({ localKey: 'k' })
    expect(locks.available).toBe(false)
    expect(await locks.heldElsewhere({ localKey: 'k' })).toBe(false)
  })
})
