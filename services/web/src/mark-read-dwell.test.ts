import { describe, expect, it, vi } from 'vitest'
import { MARK_READ_DWELL_MS, createMarkReadDwell } from './mark-read-dwell.js'

describe('mark-read dwell', () => {
  it('exports a 5 second dwell', () => {
    expect(MARK_READ_DWELL_MS).toBe(5_000)
  })

  it('does not run before the delay', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const dwell = createMarkReadDwell()
    dwell.schedule('gmail:t1', run)
    vi.advanceTimersByTime(4_999)
    expect(run).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('runs once after the delay', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const dwell = createMarkReadDwell()
    dwell.schedule('gmail:t1', run)
    vi.advanceTimersByTime(5_000)
    expect(run).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('replaces a pending dwell when a new conversation is scheduled', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()
    const dwell = createMarkReadDwell()
    dwell.schedule('gmail:t1', first)
    vi.advanceTimersByTime(2_000)
    dwell.schedule('gmail:t2', second)
    vi.advanceTimersByTime(5_000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('cancel stops a pending dwell', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const dwell = createMarkReadDwell()
    dwell.schedule('gmail:t1', run)
    dwell.cancel()
    vi.advanceTimersByTime(5_000)
    expect(run).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
