import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type CodexBindingKey =
  | { readonly kind: 'contact' | 'topic'; readonly accountId: string; readonly contextId: string }
  | { readonly kind: 'unbound' }
  | { readonly kind: 'draft'; readonly draftKey: string }
  | { readonly kind: 'conversation'; readonly accountId: string; readonly gmailThreadId: string }

export function bindingRecordKey(key: CodexBindingKey): string {
  if (key.kind === 'unbound') return 'unbound'
  if (key.kind === 'draft') return `draft:${key.draftKey}`
  if (key.kind === 'conversation') return `conversation:${key.accountId}:${key.gmailThreadId}`
  return `${key.kind}:${JSON.stringify([key.accountId,key.contextId])}`
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

  workBindings():Array<{kind:'conversation'|'contact'|'topic';accountId:string;contextId:string;codexThreadId:string}> {
    return [...this.#records].flatMap<{kind:'conversation'|'contact'|'topic';accountId:string;contextId:string;codexThreadId:string}>(([key,codexThreadId])=>{
      if(key.startsWith('conversation:')){const tail=key.slice(13),separator=tail.lastIndexOf(':');return separator>0?[{kind:'conversation' as const,accountId:tail.slice(0,separator),contextId:tail.slice(separator+1),codexThreadId}]:[];}
      const match=/^(contact|topic):(\[.*\])$/.exec(key);if(!match)return [];
      const [accountId,contextId]=JSON.parse(match[2]!);return [{kind:match[1] as 'contact'|'topic',accountId,contextId,codexThreadId}];
    });
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
