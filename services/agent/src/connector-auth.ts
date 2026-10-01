/** Only the first-party transport's rejected login triggers Codex token renewal. */
export function isRevokedConnectorToken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Transport send error/.test(message) && /HTTP 401\b/.test(message) && /token_revoked/.test(message)
}

export class ConnectorAuthRecovery {
  #refresh: Promise<void> | undefined
  #lastAttempt = -Infinity
  #renewed = false
  constructor(readonly request: (method: string, params: unknown) => Promise<unknown>, readonly now = Date.now) {}

  async refresh(): Promise<void> {
    if (this.#refresh) return this.#refresh
    if (this.now() - this.#lastAttempt < 30_000) {
      if (this.#renewed) return
      throw new Error('Codex connector login is still invalid after refresh. Reconnect your Codex account.')
    }
    this.#lastAttempt = this.now()
    this.#renewed = false
    this.#refresh = this.request('account/read', { refreshToken: true }).then(() => { this.#renewed = true }).finally(() => { this.#refresh = undefined })
    return this.#refresh
  }

  async call(method: string, params: unknown): Promise<unknown> {
    try { return await this.request(method, params) }
    catch (error) {
      if (method !== 'mcpServer/tool/call' || !isRevokedConnectorToken(error)) throw error
      await this.refresh()
      const tool = (params as { tool?: unknown })?.tool
      // Renew for writes too, but never replay a send or draft mutation.
      if (typeof tool !== 'string' || !/^gmail\.(?:search_|read_|get_|list_)/.test(tool)) throw error
      try { return await this.request(method, params) }
      catch (retryError) { if (isRevokedConnectorToken(retryError)) this.#renewed = false; throw retryError }
    }
  }
}
