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
