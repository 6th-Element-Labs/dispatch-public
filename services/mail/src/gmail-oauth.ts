import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { setTimeout as wait } from 'node:timers/promises'
import type { IndexedGmailAccount } from './gmail-index.js'
import { GmailApiError, object, type GmailHistoryTransport } from './gmail-history-sync.js'

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/'
export interface GmailOAuthConfig { clientId: string; clientSecret?: string }
export interface GmailCredential {
  email: string; clientId: string; accessToken: string; refreshToken: string; expiresAt: number; scope: string
}
export interface GmailCredentialStore {
  read(accountId: string): Promise<GmailCredential | undefined>
  write(accountId: string, credential: GmailCredential): Promise<void>
}

export function loadGmailOAuthConfig(): GmailOAuthConfig | undefined {
  if (process.env.DISPATCH_GMAIL_OAUTH_CLIENT_ID) return config({ client_id: process.env.DISPATCH_GMAIL_OAUTH_CLIENT_ID, client_secret: process.env.DISPATCH_GMAIL_OAUTH_CLIENT_SECRET })
  const path = process.env.DISPATCH_GMAIL_OAUTH_CONFIG ?? join(homedir(), 'Library', 'Application Support', 'Dispatch', 'gmail-sync.json')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Dispatch Gmail OAuth configuration could not be read') }
  const root = object(value)
  return config(root.installed === undefined ? root : object(root.installed))
}
function config(value: Record<string, unknown>): GmailOAuthConfig {
  if (typeof value.client_id !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(value.client_id)) throw new Error('Dispatch needs a Google Desktop OAuth client ID')
  if (value.client_secret !== undefined && typeof value.client_secret !== 'string') throw new Error('Invalid Google OAuth client configuration')
  return { clientId: value.client_id, clientSecret: value.client_secret as string | undefined }
}

async function security(args: string[], input?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Dispatch could not access the macOS Keychain in time')) }, 10_000)
    child.stdout.on('data', chunk => { output += String(chunk) })
    // Never forward keychain output or credentials into service logs.
    child.stderr.resume()
    child.once('error', () => { clearTimeout(timer); reject(new Error('Dispatch could not access the macOS Keychain')) })
    child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, output }) })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
export class MacGmailCredentialStore implements GmailCredentialStore {
  #key(accountId: string): string { return createHash('sha256').update(accountId).digest('hex') }
  async read(accountId: string): Promise<GmailCredential | undefined> {
    if (process.platform !== 'darwin') throw new Error('Direct Gmail authorization requires the macOS Keychain')
    const result = await security(['find-generic-password', '-a', this.#key(accountId), '-s', 'com.taikun.dispatch.gmail-sync', '-w'])
    if (result.code === 44) return undefined
    if (result.code !== 0) throw new Error('Dispatch could not read its Gmail authorization from the macOS Keychain')
    try {
      const value = object(JSON.parse(Buffer.from(result.output.trim(), 'base64').toString('utf8')))
      if (typeof value.email !== 'string' || typeof value.clientId !== 'string' || typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string' || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || typeof value.scope !== 'string') throw new Error()
      return value as unknown as GmailCredential
    } catch { throw new Error('Stored Gmail authorization is invalid. Connect this account again.') }
  }
  async write(accountId: string, credential: GmailCredential): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('Direct Gmail authorization requires the macOS Keychain')
    const encoded = Buffer.from(JSON.stringify(credential)).toString('base64')
    // Interactive stdin keeps tokens out of command-line arguments and process listings.
    await security(['-i'], `add-generic-password -U -a ${this.#key(accountId)} -s com.taikun.dispatch.gmail-sync -w ${encoded}\n`)
    const saved = await this.read(accountId)
    if (!saved || JSON.stringify(saved) !== JSON.stringify(credential)) throw new Error('Dispatch could not save Gmail authorization in the macOS Keychain')
  }
}

export interface GmailDirectSyncStatus {
  configured: boolean
  error?: string
  accounts: Array<{ accountId: string; email: string; state: 'connector' | 'connecting' | 'connected' | 'reconnect'; error?: string }>
}

export class GmailOAuth implements GmailHistoryTransport {
  readonly #credentials = new Map<string, GmailCredential | undefined>()
  readonly #refreshes = new Map<string, Promise<GmailCredential>>()
  readonly #errors = new Map<string, string>()
  readonly #pending = new Map<string, { server: Server; controller: AbortController; timer: ReturnType<typeof setTimeout> }>()
  readonly #nextRead = new Map<string, number>()
  #closed = false
  get activeOperations(): number { return this.#pending.size + this.#refreshes.size }
  constructor(
    readonly configuration: GmailOAuthConfig | undefined,
    readonly store: GmailCredentialStore = new MacGmailCredentialStore(),
    readonly options: {
      fetch?: typeof fetch; onConnected?: (accountId: string) => void; configurationError?: string
      retryAfter?: (accountId: string) => number; pauseUntil?: (accountId: string, timestamp: number) => void
      now?: () => number; wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
    } = {},
  ) {}
  #fetch(url: string, init?: RequestInit): Promise<Response> { return (this.options.fetch ?? fetch)(url, { ...init, redirect: 'error' }) }
  async #credential(account: IndexedGmailAccount): Promise<GmailCredential | undefined> {
    if (!this.configuration) return undefined
    if (!this.#credentials.has(account.id)) this.#credentials.set(account.id, await this.store.read(account.id))
    const value = this.#credentials.get(account.id)
    if (!value) return undefined
    if (value.clientId !== this.configuration.clientId || value.email.toLowerCase() !== account.email.toLowerCase()) throw new Error('Gmail authorization belongs to another account or OAuth client. Connect this account again.')
    return value
  }
  async connected(account: IndexedGmailAccount): Promise<boolean> {
    const credential = await this.#credential(account)
    if (credential && this.#errors.has(account.id)) throw new Error(this.#errors.get(account.id))
    return !!credential
  }
  async status(accounts: readonly IndexedGmailAccount[]): Promise<GmailDirectSyncStatus> {
    return { configured: !!this.configuration, error: this.options.configurationError, accounts: await Promise.all(accounts.map(async account => {
      let state: GmailDirectSyncStatus['accounts'][number]['state'] = 'connector'
      let error = this.#errors.get(account.id)
      try { if (await this.#credential(account)) state = error ? 'reconnect' : 'connected' }
      catch (failure) { error = String(failure); state = 'reconnect' }
      if (this.#pending.has(account.id)) state = 'connecting'
      return { accountId: account.id, email: account.email, state, error }
    })) }
  }
  async #token(fields: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.configuration) throw new Error('Dispatch Gmail OAuth client is not configured')
    const response = await this.#fetch(TOKEN_URL, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, client_id: this.configuration.clientId, ...(this.configuration.clientSecret ? { client_secret: this.configuration.clientSecret } : {}) }),
    })
    const value = object(await response.json())
    if (!response.ok) {
      if (value.error === 'invalid_grant') throw new GmailApiError(response.status, 'oauth_reconnect_required')
      throw new GmailApiError(response.status, 'oauth_exchange_failed')
    }
    if (typeof value.access_token !== 'string' || !value.access_token || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error('Google did not return a valid access token')
    return value
  }
  #converted(value: Record<string, unknown>, account: IndexedGmailAccount, previous?: GmailCredential): GmailCredential {
    const refreshToken = typeof value.refresh_token === 'string' && value.refresh_token ? value.refresh_token : previous?.refreshToken
    const scope = typeof value.scope === 'string' ? value.scope : previous?.scope
    if (!refreshToken || !scope?.split(' ').includes(SCOPE)) throw new Error('Google did not grant offline Gmail read access. Connect this account again.')
    return { email: account.email.toLowerCase(), clientId: this.configuration!.clientId, accessToken: String(value.access_token), refreshToken, expiresAt: Date.now() + Number(value.expires_in) * 1_000, scope }
  }
  async #refresh(account: IndexedGmailAccount, credential: GmailCredential, signal: AbortSignal): Promise<GmailCredential> {
    const renewed = this.#credentials.get(account.id)
    if (renewed && renewed.accessToken !== credential.accessToken && renewed.expiresAt > Date.now() + 60_000) return renewed
    const current = this.#refreshes.get(account.id)
    if (current) return current
    // Renewal is shared, but one cancelled scan must not cancel a second reader's renewal.
    signal.throwIfAborted()
    const flight = this.#token({ grant_type: 'refresh_token', refresh_token: credential.refreshToken }, AbortSignal.timeout(30_000)).then(async value => {
      const updated = this.#converted(value, account, credential)
      await this.store.write(account.id, updated)
      this.#credentials.set(account.id, updated)
      return updated
    }).catch(error => {
      if (error instanceof GmailApiError && error.code === 'oauth_reconnect_required') this.#errors.set(account.id, 'Google revoked this authorization. Connect this account again.')
      throw error
    }).finally(() => { this.#refreshes.delete(account.id) })
    this.#refreshes.set(account.id, flight)
    return flight
  }
  async get(account: IndexedGmailAccount, path: string, signal: AbortSignal): Promise<unknown> {
    if (!/^(?:profile|messages\?[^#]*|messages\/[a-zA-Z0-9_-]+\?format=(?:full|metadata)|history\?[^#]*)$/.test(path)) throw new Error('Unsupported Gmail sync endpoint')
    const retryAt = this.options.retryAfter?.(account.id) ?? 0
    if (retryAt > Date.now()) throw new GmailApiError(429, 'gmail_backoff')
    let credential = await this.#credential(account)
    if (!credential || this.#errors.has(account.id)) throw new Error(this.#errors.get(account.id) ?? 'Connect Gmail direct sync for this account')
    if (credential.expiresAt <= Date.now() + 60_000) credential = await this.#refresh(account, credential, signal)
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted()
      await this.#pace(account.id, path, signal)
      // Another reader can receive Retry-After while this request waits for its slot.
      if ((this.options.retryAfter?.(account.id) ?? 0) > Date.now()) throw new GmailApiError(429, 'gmail_backoff')
      const response = await this.#fetch(`${API_URL}${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { authorization: `Bearer ${credential.accessToken}` } })
      if (response.ok) return response.json()
      if (response.status === 401 && attempt === 0) { credential = await this.#refresh(account, credential, signal); continue }
      if (response.status === 401) { this.#errors.set(account.id, 'Google rejected this authorization. Connect this account again.'); throw new GmailApiError(401, 'oauth_reconnect_required') }
      if (response.status === 404) throw new GmailApiError(404, path.startsWith('history?') ? 'history_expired' : 'message_not_found')
      if (response.status === 429) {
        this.#pause(account.id, response.headers.get('retry-after'))
        throw new GmailApiError(429, 'gmail_backoff')
      }
      const value = object(await response.json())
      const error = value.error && typeof value.error === 'object' ? object(value.error) : {}
      const reasons = Array.isArray(error.errors) ? error.errors.map(item => object(item).reason) : []
      if (response.status === 429 || reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(String(reason)))) {
        this.#pause(account.id, response.headers.get('retry-after'))
        throw new GmailApiError(429, 'gmail_backoff')
      }
      throw new GmailApiError(response.status, 'gmail_read_failed')
    }
    throw new GmailApiError(401, 'oauth_reconnect_required')
  }
  async #pace(accountId: string, path: string, signal: AbortSignal): Promise<void> {
    // Reserve slots across concurrent readers, using 80% of the 6,000-unit budget.
    // Full MIME reads use a conservative 3x reservation after live quota exhaustion.
    const cost = path.startsWith('messages/') ? path.endsWith('format=full') ? 60 : 20 : path.startsWith('messages?') ? 5 : path.startsWith('history?') ? 2 : 1
    const now = (this.options.now ?? Date.now)()
    const slot = Math.max(now, this.#nextRead.get(accountId) ?? 0)
    this.#nextRead.set(accountId, slot + cost * 60_000 / 4_800)
    if (slot > now) await (this.options.wait ?? ((ms, abort) => wait(ms, undefined, { signal: abort })))(slot - now, signal)
    signal.throwIfAborted()
    if (this.#closed) throw new Error('Dispatch is stopping')
  }
  #pause(accountId: string, retry: string | null): void {
    const date = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1_000 : Date.parse(retry ?? '')
    this.options.pauseUntil?.(accountId, Math.max(Date.now() + 60_000, Number.isFinite(date) ? date : 0))
  }

  async beginConnect(account: IndexedGmailAccount): Promise<{ authUrl: string } | { connected: true }> {
    if (this.#closed) throw new Error('Dispatch is stopping')
    if (!this.configuration) throw new Error(this.options.configurationError ?? 'Dispatch needs a Google Desktop OAuth client before direct sync can connect')
    this.#cancel(account.id)
    const saved = await this.#credential(account).catch(() => undefined)
    if (saved && !this.#errors.has(account.id)) {
      try {
        const profile = object(await this.get(account, 'profile', AbortSignal.timeout(30_000)))
        if (typeof profile.emailAddress !== 'string' || profile.emailAddress.toLowerCase() !== account.email.toLowerCase()) throw new Error('Stored Gmail authorization does not match the selected account')
        this.options.onConnected?.(account.id)
        return { connected: true }
      } catch (error) {
        // A temporary failure keeps the grant. Only rejected authorization needs new consent.
        if (!(error instanceof GmailApiError) || error.code !== 'oauth_reconnect_required') throw error
      }
    }
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const controller = new AbortController()
    let consumed = false
    let redirect = ''
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      const url = new URL(request.url ?? '/', redirect)
      const supplied = Buffer.from(url.searchParams.get('state') ?? '')
      const expected = Buffer.from(state)
      if (request.method !== 'GET' || url.pathname !== '/oauth2/callback' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.statusCode = 400; response.end('Invalid authorization response.'); return }
      if (consumed) { response.statusCode = 409; response.end('Authorization is already being handled.'); return }
      consumed = true
      try {
        const code = url.searchParams.get('code')
        if (url.searchParams.has('error') || !code) throw new Error('Google sign-in was not completed. Connect this account again.')
        const value = await this.#token({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }, controller.signal)
        const credential = this.#converted(value, account)
        const profileResponse = await this.#fetch(`${API_URL}profile`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), headers: { authorization: `Bearer ${credential.accessToken}` } })
        if (!profileResponse.ok) throw new Error('Google could not verify this Gmail account')
        const profile = object(await profileResponse.json())
        if (typeof profile.emailAddress !== 'string' || profile.emailAddress.toLowerCase() !== account.email.toLowerCase()) throw new Error('You signed in to a different Gmail account. Connect the selected account again.')
        controller.signal.throwIfAborted()
        await this.store.write(account.id, credential)
        this.#credentials.set(account.id, credential); this.#errors.delete(account.id)
        response.end('Gmail sync is connected. You can close this page and return to Dispatch.')
        this.options.onConnected?.(account.id)
      } catch (error) {
        this.#errors.set(account.id, error instanceof GmailApiError ? 'Google authorization failed. Connect this account again.' : error instanceof Error ? error.message : 'Google authorization failed.')
        response.statusCode = 400; response.end(this.#errors.get(account.id))
      } finally { this.#cancel(account.id) }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/callback`
    const timer = setTimeout(() => { this.#errors.set(account.id, 'Google sign-in expired. Connect this account again.'); this.#cancel(account.id) }, 5 * 60_000)
    timer.unref()
    this.#pending.set(account.id, { server, controller, timer })
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({ client_id: this.configuration.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', login_hint: account.email }).toString()
    return { authUrl: url.href }
  }
  #cancel(accountId: string): void {
    const pending = this.#pending.get(accountId)
    if (!pending) return
    clearTimeout(pending.timer); pending.controller.abort(); pending.server.close(); this.#pending.delete(accountId)
  }
  stop(): void { this.#closed = true; for (const accountId of this.#pending.keys()) this.#cancel(accountId) }
}
