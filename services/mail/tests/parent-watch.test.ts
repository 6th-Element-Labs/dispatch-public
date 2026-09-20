import { afterEach, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { watchParent } from '../src/parent-watch.js'
afterEach(() => vi.useRealTimers())
it('stops once when the native owner disappears and leaves unrelated owners alone', () => {
  vi.useFakeTimers(); const input = new PassThrough(); const close = vi.fn(); let alive = true
  const cleanup = watchParent('1234', close, input, () => alive)
  vi.advanceTimersByTime(1000); expect(close).not.toHaveBeenCalled()
  alive = false; vi.advanceTimersByTime(500); expect(close).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(2000); input.end(); expect(close).toHaveBeenCalledTimes(1); cleanup()
})
it('stops on a closed parent pipe even if the old PID has been reused', async () => {
  const input = new PassThrough(); const close = vi.fn(); const cleanup = watchParent('1234', close, input, () => true)
  input.end(); await new Promise(resolve => setImmediate(resolve)); expect(close).toHaveBeenCalledTimes(1); cleanup()
})
it('does not attach a watchdog to standalone services', () => {
  const input = new PassThrough(); const close = vi.fn(); const probe = vi.fn(() => false)
  for (const owner of [undefined, '', '1', 'not-a-pid']) watchParent(owner, close, input, probe)()
  expect(close).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled(); expect(input.readableFlowing).toBe(null)
})

it('releases a real service process when its owning stdin pipe closes', async () => {
  const { spawn } = await import('node:child_process')
  const moduleUrl = new URL('../src/parent-watch.ts', import.meta.url).href
  const script = `import { createServer } from 'node:http'; import { watchParent } from ${JSON.stringify(moduleUrl)}; const server=createServer((q,s)=>s.end('ok')); server.listen(0,'127.0.0.1',()=>process.stdout.write('ready\\n')); watchParent(String(process.ppid),()=>server.close(()=>process.exit(0)));`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject) })
    child.stdin.end()
    expect(await exited).toBe(0)
  } finally { if (child.exitCode === null) child.kill('SIGKILL') }
}, 5000)
