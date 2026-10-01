import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexProcess } from '../src/codex-process.js'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeUpdater } from '../src/codex-runtime.js'

const processes: CodexProcess[] = []
const roots: string[] = []

afterEach(async () => {
  for (const process of processes.splice(0)) process.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function executable(label: string, broken = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-codex-process-')); roots.push(root)
  const command = join(root, 'codex')
  await writeFile(command, `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line', line=>{const m=JSON.parse(line); if(m.id===undefined)return;
if(m.method==='initialize' && ${broken}) process.stdout.write(JSON.stringify({id:m.id,error:{message:'incompatible runtime'}})+'\\n');
else if(m.method==='hold')setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,result:'${label}'})+'\\n'),150);
else process.stdout.write(JSON.stringify({id:m.id,result:'${label}'})+'\\n');});\n`)
  await chmod(command, 0o755)
  return command
}

async function managed(broken = false) {
  const previous = await executable('previous'), updated = await executable('updated', broken)
  const release = { command: updated, version: '0.160.0' }
  const manager: RuntimeUpdater = {
    status: { automatic: true, command: previous, version: '0.159.0', checkedAt: null, availableVersion: null, state: 'idle', error: null },
    initial: vi.fn(async () => previous), check: vi.fn(async () => release),
    activated: vi.fn(async () => undefined), reject: vi.fn(async (_release, error) => { manager.status.error = String(error) }),
    fail: vi.fn(), close: vi.fn(),
  }
  const codex = new CodexProcess(previous, { manager }); processes.push(codex)
  let idle = false
  codex.setIdleGuard(() => idle)
  await codex.ready()
  await vi.waitFor(() => expect(manager.check).toHaveBeenCalled())
  return { codex, manager, allow: () => { idle = true } }
}

describe('CodexProcess', () => {
  it('keeps background work and pending RPC intact, then switches the idle transport and announces reconnect', async () => {
    const { codex, manager, allow } = await managed()
    const events: string[] = []
    codex.subscribe(message => { if (message.method) events.push(message.method) })
    await codex.checkForUpdates()
    expect(await codex.request('model/list')).toBe('previous')
    expect(manager.activated).not.toHaveBeenCalled()
    allow()
    const pending = codex.request('hold')
    await codex.checkForUpdates()
    expect(manager.activated).not.toHaveBeenCalled()
    expect(await pending).toBe('previous')
    await codex.checkForUpdates()
    expect(await codex.request('model/list')).toBe('updated')
    expect(manager.activated).toHaveBeenCalledOnce()
    expect(events).toContain('dispatch/appServerDisconnected')
    expect(events).toContain('dispatch/appServerReconnected')
  })

  it('restores the previous working App Server when the candidate fails initialization', async () => {
    const { codex, manager, allow } = await managed(true)
    allow(); await codex.checkForUpdates()
    expect(await codex.request('model/list')).toBe('previous')
    expect(manager.activated).not.toHaveBeenCalled()
    expect(manager.reject).toHaveBeenCalledOnce()
    expect(codex.lastWarning()).toContain('incompatible runtime')
  })

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
