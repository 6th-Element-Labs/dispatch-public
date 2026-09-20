import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type CodexBindingKey =
  | { readonly kind: 'unbound' }
  | { readonly kind: 'draft'; readonly draftKey: string }
  | { readonly kind: 'conversation'; readonly accountId: string; readonly gmailThreadId: string }

export function bindingRecordKey(key: CodexBindingKey): string {
  if (key.kind === 'unbound') return 'unbound'
  if (key.kind === 'draft') return `draft:${key.draftKey}`
  return `conversation:${key.accountId}:${key.gmailThreadId}`
}

export function defaultBindingsPath(): string {
  if (process.env.DISPATCH_CODEX_BINDINGS) return process.env.DISPATCH_CODEX_BINDINGS
  return join(homedir(), 'Library', 'Application Support', 'Dispatch', 'codex-bindings.json')
}

/** Working directory for in-app Codex threads. Kept off the Dispatch repo so repository-level agent instructions do not bind the email assistant. */
export function defaultCodexWorkspace(): string {
  if (process.env.DISPATCH_CODEX_CWD) return process.env.DISPATCH_CODEX_CWD
  return join(homedir(), 'Library', 'Application Support', 'Dispatch', 'codex-workspace')
}

export class CodexBindingStore {
  #records = new Map<string, string>()
  #loaded = false
  #loadFlight: Promise<void> | undefined
  #writeFlight: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loadFlight ??= this.#readOnce().finally(() => { this.#loadFlight = undefined })
    await this.#loadFlight
  }

  async #readOnce(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex binding file is not an object')
      this.#records = new Map(Object.entries(value as Record<string, unknown>).flatMap(([key, threadId]) => (
        typeof threadId === 'string' && threadId ? [[key, threadId] as const] : []
      )))
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code !== 'ENOENT') throw error
      this.#records = new Map()
    }
    this.#loaded = true
  }

  get(key: CodexBindingKey): string | undefined {
    return this.#records.get(bindingRecordKey(key))
  }

  async put(key: CodexBindingKey, threadId: string): Promise<void> {
    if (!this.#loaded) await this.load()
    this.#records.set(bindingRecordKey(key), threadId)
    await this.#flush()
  }

  async replace(key: CodexBindingKey, threadId: string): Promise<void> {
    await this.put(key, threadId)
  }

  async #flush(): Promise<void> {
    const write = this.#writeFlight.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(Object.fromEntries(this.#records), null, 2)}\n`)
      await rename(tmp, this.path)
    })
    this.#writeFlight = write
    await write
  }
}
