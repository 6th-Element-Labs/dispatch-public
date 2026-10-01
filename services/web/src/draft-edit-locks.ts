/**
 * Cross-window claim on the draft a window is editing.
 *
 * The main window and message windows share local draft recovery. The window
 * editing a draft holds a Web Lock for each of its identities (the local
 * recovery key and, once saved, the Gmail draft id). Other windows do not open
 * that draft and do not save its local copy in the background, so an older
 * checkpoint can never overwrite newer edits in Gmail. Locks end with the
 * window, including when it crashes.
 */
export interface DraftIdentity {
  readonly localKey?: string
  readonly gmailDraftId?: string
  readonly accountId?: string
}

export type LockManagerLike = {
  request(name: string, options: { mode: 'exclusive' }, callback: () => Promise<void>): Promise<unknown>
  query(): Promise<{ held?: ReadonlyArray<{ name?: string }> }>
}

const PREFIX = 'dispatch.draft-edit:'
const LOCAL = `${PREFIX}local:`
const GMAIL = `${PREFIX}gmail:`

function names(identity: DraftIdentity | undefined): string[] {
  const gmailName = identity?.gmailDraftId
    ? identity.accountId
      ? `${GMAIL}${encodeURIComponent(identity.accountId)}:${encodeURIComponent(identity.gmailDraftId)}`
      : `${GMAIL}${identity.gmailDraftId}`
    : undefined
  return [identity?.localKey && `${LOCAL}${identity.localKey}`, gmailName].filter((name): name is string => Boolean(name))
}

export class DraftEditLocks {
  readonly #locks: LockManagerLike | undefined
  readonly #requested = new Map<string, () => void>()
  // Which request holds each granted lock, so a late settlement of a released request cannot drop a newer grant.
  readonly #granted = new Map<string, symbol>()
  readonly #flights = new Set<Promise<unknown>>()

  constructor(locks: LockManagerLike | undefined) { this.#locks = locks }

  get available(): boolean { return Boolean(this.#locks) }

  /** Hold exactly the locks for this draft; nothing when no draft is open. */
  hold(identity: DraftIdentity | undefined): void {
    const wanted = new Set(names(identity))
    for (const [name, release] of this.#requested) {
      if (wanted.has(name)) continue
      release()
      this.#requested.delete(name)
    }
    if (!this.#locks) return
    for (const name of wanted) {
      if (this.#requested.has(name)) continue
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      const token = Symbol(name)
      this.#requested.set(name, release)
      const flight = this.#locks.request(name, { mode: 'exclusive' }, () => { this.#granted.set(name, token); return released })
        .catch((error: unknown) => console.error(`Draft edit lock ${name} failed:`, error))
        .finally(() => { if (this.#granted.get(name) === token) this.#granted.delete(name); this.#flights.delete(flight) })
      this.#flights.add(flight)
    }
  }

  /** Wait for the browser to release claims before another window restores this editor. */
  async release(): Promise<void> {
    const flights = [...this.#flights]
    this.hold(undefined)
    await Promise.all(flights)
  }

  /** Whether another window is editing this draft. */
  async heldElsewhere(identity: DraftIdentity): Promise<boolean> {
    const held = await this.#heldElsewhere()
    return names(identity).some((name) => held.has(name))
  }

  /** Local recovery keys of drafts that other windows are editing. */
  async localKeysHeldElsewhere(): Promise<Set<string>> {
    return new Set([...await this.#heldElsewhere()].filter((name) => name.startsWith(LOCAL)).map((name) => name.slice(LOCAL.length)))
  }

  async #heldElsewhere(): Promise<Set<string>> {
    if (!this.#locks) return new Set()
    const state = await this.#locks.query()
    return new Set((state.held ?? []).map((lock) => lock.name ?? '').filter((name) => name.startsWith(PREFIX) && !this.#granted.has(name)))
  }
}
