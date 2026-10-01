import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { existsSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { JsonLineRpc, type RpcMessage } from './json-line-rpc.js'
import { ConnectorAuthRecovery, isRevokedConnectorToken } from './connector-auth.js'
import { CodexRuntimeManager, UPDATE_INTERVAL_MS, UPDATE_RETRY_MS, type RuntimeRelease, type RuntimeUpdateStatus, type RuntimeUpdater } from './codex-runtime.js'

const INITIAL_RESTART_DELAY_MS = 500
const MAX_RESTART_DELAY_MS = 30_000

export class CodexProcess {
  #command: string
  readonly #listeners = new Set<(message: RpcMessage) => void>()
  #process: ChildProcessWithoutNullStreams | undefined
  #rpc: JsonLineRpc | undefined
  #ready: Promise<void>
  #lastError: string | null = null
  #lastWarning: string | null = null
  #restartTimer: NodeJS.Timeout | undefined
  #closed = false
  #startedOnce = false
  #restartDelayMs = INITIAL_RESTART_DELAY_MS
  #manager: RuntimeUpdater | undefined
  #updateTimer: NodeJS.Timeout | undefined
  #nextUpdateCheck = 0
  #pendingUpdate: RuntimeRelease | undefined
  #updateRunning = false
  #replacing = false
  #launching = false
  #pendingRequests = 0
  #idleGuard = () => true
  #auth = new ConnectorAuthRecovery(async (method, params) => {
    this.#pendingRequests++
    try {
      if (!this.#rpc) throw new Error('Codex App Server transport is unavailable')
      return await this.#rpc.request(method, params)
    } finally { this.#pendingRequests-- }
  })

  constructor(command = process.env.DISPATCH_CODEX_COMMAND ?? 'codex', options: { manager?: RuntimeUpdater } = {}) {
    this.#command = command
    this.#manager = options.manager ?? (process.env.DISPATCH_CODEX_AUTO_UPDATE === '1' ? new CodexRuntimeManager(command) : undefined)
    this.#launching = true
    this.#ready = this.#observed((async () => {
      if (this.#manager) this.#command = await this.#manager.initial()
      if (this.#closed) return
      await this.#launch()
    })())
    if (this.#manager) {
      this.#updateTimer = setInterval(() => { void this.checkForUpdates() }, 30_000)
      this.#updateTimer.unref()
      void this.checkForUpdates()
    }
  }

  /**
   * Readiness is awaited lazily by /ready and request(); between probes nobody
   * holds the promise. Attach a no-op handler so a rejected launch is reported
   * through ready() and lastError() instead of crashing the service as an
   * unhandled rejection. The returned promise still rejects for callers.
   */
  #observed(promise: Promise<void>): Promise<void> {
    promise.catch(() => undefined)
    return promise
  }

  /** Delay before the next relaunch attempt. Doubles on repeated failure, resets on success. */
  nextRestartDelayMs(): number {
    return this.#restartDelayMs
  }

  async #launch(): Promise<void> {
    this.#launching = true
    const env = { ...globalThis.process.env }
    delete env.DISPATCH_PARENT_PID
    const tools = join(dirname(this.#command), '..', 'codex-path')
    if (isAbsolute(this.#command) && existsSync(tools)) env.PATH = `${tools}:${env.PATH ?? ''}`
    const process = spawn(this.#command, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env })
    const rpc = new JsonLineRpc(process.stdin)
    let terminated = false
    this.#process = process
    this.#rpc = rpc
    rpc.subscribe((message) => {
      this.#listeners.forEach((listener) => listener(message))
      const item = (message.params as { item?: { type?: string; error?: { message?: string } } } | undefined)?.item
      if (message.method === 'item/completed' && item?.type === 'mcpToolCall' && isRevokedConnectorToken(item.error?.message)) {
        // Agent-driven tools run inside Codex. Renew the session without replaying its turn.
        void this.#auth.refresh().catch(error => { this.#lastWarning = String(error) })
      }
    })
    const lines = readline.createInterface({ input: process.stdout })
    lines.on('line', (line) => rpc.acceptLine(line))
    process.stderr.on('data', (chunk) => {
      if (this.#process !== process) return
      const diagnostic = String(chunk).trim().slice(-1000)
      if (/"level":"(?:WARN|WARNING)"|\bWARN(?:ING)?\b/.test(diagnostic)) this.#lastWarning = diagnostic
      else if (diagnostic) this.#lastError = diagnostic
    })
    const handleFailure = (reason: Error) => {
      if (terminated) return
      terminated = true
      rpc.rejectAll(reason)
      if (this.#process !== process || this.#closed || this.#replacing) return
      this.#lastError = reason.message
      this.#listeners.forEach((listener) => listener({ method: 'dispatch/appServerDisconnected', params: { reason: reason.message } }))
      const delay = this.#restartDelayMs
      this.#restartDelayMs = Math.min(this.#restartDelayMs * 2, MAX_RESTART_DELAY_MS)
      this.#ready = this.#observed(new Promise<void>((resolve, reject) => {
        this.#restartTimer = setTimeout(() => {
          this.#restartTimer = undefined
          this.#launch().then(resolve, reject)
        }, delay)
      }))
    }
    process.on('error', (error) => handleFailure(new Error(`Could not start Codex App Server: ${error.message}`)))
    process.on('exit', (code, signal) => handleFailure(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`)))
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'dispatch', title: 'Dispatch', version: '0.1.7' },
        capabilities: { mcpServerOpenaiFormElicitation: true },
      })
    } catch (error) {
      handleFailure(error instanceof Error ? error : new Error(String(error)))
      if (!process.killed) process.kill('SIGTERM')
      this.#launching = false
      throw error
    }
    rpc.notify('initialized', {})
    this.#lastError = null
    this.#lastWarning = null
    this.#launching = false
    this.#restartDelayMs = INITIAL_RESTART_DELAY_MS
    const reconnected = this.#startedOnce
    this.#startedOnce = true
    if (reconnected) this.#listeners.forEach((listener) => listener({ method: 'dispatch/appServerReconnected', params: {} }))
  }

  async ready(): Promise<void> {
    await this.#ready
  }

  lastError(): string | null {
    return this.#lastError
  }

  lastWarning(): string | null {
    return this.#manager?.status.error ? `Codex runtime update: ${this.#manager.status.error}` : this.#lastWarning
  }

  runtimeStatus(): RuntimeUpdateStatus | undefined { return this.#manager ? { ...this.#manager.status } : undefined }

  setIdleGuard(guard: () => boolean): void { this.#idleGuard = guard }

  /** Downloads while busy, but claims the transport synchronously only once every owner is idle. */
  async checkForUpdates(): Promise<void> {
    if (!this.#manager || this.#closed || this.#updateRunning) return
    this.#updateRunning = true
    try {
      if (!this.#pendingUpdate && Date.now() >= this.#nextUpdateCheck) {
        this.#pendingUpdate = await this.#manager.check()
        this.#nextUpdateCheck = Date.now() + (this.#manager.status.error ? UPDATE_RETRY_MS : UPDATE_INTERVAL_MS)
      }
      if (!this.#pendingUpdate || this.#launching || this.#pendingRequests || !this.#idleGuard() || this.#closed) return
      const release = this.#pendingUpdate
      this.#pendingUpdate = undefined
      this.#ready = this.#observed(this.#replace(release))
      await this.#ready
    } catch (error) { this.#manager.fail(error) }
    finally { this.#updateRunning = false }
  }

  async #stopChild(): Promise<void> {
    const child = this.#process
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }

  async #replace(release: RuntimeRelease): Promise<void> {
    const previous = this.#command
    this.#replacing = true
    if (this.#restartTimer) { clearTimeout(this.#restartTimer); this.#restartTimer = undefined }
    this.#manager!.status.state = 'updating'
    this.#listeners.forEach(listener => listener({ method: 'dispatch/appServerDisconnected', params: { reason: 'Updating Codex runtime' } }))
    try {
      await this.#stopChild()
      if (this.#closed) return
      this.#command = release.command
      try {
        await this.#launch()
        await this.#manager!.activated(release)
      } catch (error) {
        await this.#stopChild()
        this.#command = previous
        await this.#manager!.reject(release, error)
        if (!this.#closed) await this.#launch()
      }
    } finally { this.#replacing = false }
  }

  subscribe(listener: (message: RpcMessage) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    this.#pendingRequests++
    try {
      await this.ready()
      if (!this.#rpc) throw new Error('Codex App Server transport is unavailable')
      return await this.#auth.call(method, params)
    } finally { this.#pendingRequests-- }
  }

  respond(id: number | string, result: unknown): void {
    if (!this.#rpc) throw new Error('Codex App Server transport is unavailable')
    this.#rpc.respond(id, result)
  }

  close(): void {
    this.#closed = true
    this.#manager?.close()
    if (this.#updateTimer) clearInterval(this.#updateTimer)
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    const child = this.#process
    child?.kill('SIGTERM')
    if (child) setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 2000).unref()
  }
}
