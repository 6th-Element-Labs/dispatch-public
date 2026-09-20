import { afterEach, describe, expect, it } from 'vitest'
import { CodexProcess } from '../src/codex-process.js'

const processes: CodexProcess[] = []

afterEach(() => {
  for (const process of processes.splice(0)) process.close()
})

describe('CodexProcess', () => {
  it('stays alive and reports the failure when the codex executable is missing', async () => {
    const codex = new CodexProcess('/nonexistent/dispatch-codex-binary')
    processes.push(codex)
    await expect(codex.ready()).rejects.toThrow(/Could not start Codex App Server: spawn .*ENOENT/)
    expect(codex.lastError()).toMatch(/ENOENT/)
    // A second readiness probe must also fail loudly rather than hang or crash the service.
    await expect(codex.ready()).rejects.toThrow(/Codex App Server/)
    expect(codex.nextRestartDelayMs()).toBeGreaterThan(500)
  })
})
