import type { Writable } from 'node:stream'

export interface RpcMessage {
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class JsonLineRpc {
  readonly #output: Writable
  readonly #pending = new Map<number, Pending>()
  readonly #listeners = new Set<(message: RpcMessage) => void>()
  #nextId = 1

  constructor(output: Writable) {
    this.#output = output
  }

  notify(method: string, params: unknown = {}): void {
    this.#write({ method, params })
  }

  respond(id: number | string, result: unknown): void {
    this.#write({ id, result })
  }

  request(method: string, params: unknown = {}, timeoutMs = 45_000): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Codex App Server request timed out after ${timeoutMs} ms: ${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#write({ id, method, params })
    })
  }

  acceptLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.#listeners.forEach((listener) => listener({ method: 'dispatch/protocolError', params: { line } }))
      return
    }

    if (typeof message.id === 'number' && !message.method) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex App Server request failed'))
      else pending.resolve(message.result)
      return
    }
    this.#listeners.forEach((listener) => listener(message))
  }

  subscribe(listener: (message: RpcMessage) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  rejectAll(reason: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.#pending.clear()
  }

  #write(message: RpcMessage): void {
    this.#output.write(`${JSON.stringify(message)}\n`)
  }
}
