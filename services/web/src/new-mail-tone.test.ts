import { describe, expect, it, vi } from 'vitest'
import { arrivedUnreadIds, liveListBaseline, playNewMailTone, triadNotes } from './new-mail-tone.js'
import type { ConversationSummary } from './contracts.js'

function conversation(id: string, unread: boolean, receivedAt = '2026-09-04T09:42:00+12:00'): ConversationSummary {
  return {
    id, threadId: id, latestMessageId: `${id}-m`, sender: { name: 'Ana', address: 'ana@example.com', initials: 'A' },
    subject: 'Berth', receivedAt, receivedLabel: 'Sep 4', receivedFullLabel: 'September 4', preview: '', unread, messageCount: 1,
  }
}

const T = (minute: number) => `2026-09-04T09:${String(minute).padStart(2, '0')}:00+12:00`

describe('new mail tone', () => {
  it('is an ascending C-E-G triad spaced 90ms apart', () => {
    const notes = triadNotes()
    expect(notes.map((note) => Math.round(note.frequency))).toEqual([1047, 1319, 1568])
    expect(notes.map((note) => note.startOffset)).toEqual([0, 0.09, 0.18])
    expect(Math.max(...notes.map((note) => note.startOffset + note.duration))).toBeLessThan(0.7)
  })

  it('reports only unread conversations missing from the previous live list', () => {
    const previous = liveListBaseline([conversation('a', true, T(30)), conversation('b', false, T(20))])
    expect(arrivedUnreadIds(previous, [conversation('c', true, T(40)), conversation('a', true, T(30)), conversation('d', false, T(35))])).toEqual(['c'])
  })

  it('never chimes without a confirmed live baseline', () => {
    expect(arrivedUnreadIds(undefined, [conversation('c', true)])).toEqual([])
  })

  it('ignores older unread threads that scroll onto the page after an archive or delete', () => {
    // Page of two: archiving `a` makes the next refresh return `b` plus the older `c`. That is not new mail.
    const previous = liveListBaseline([conversation('a', false, T(30)), conversation('b', false, T(20))])
    expect(arrivedUnreadIds(previous, [conversation('b', false, T(20)), conversation('c', true, T(10))])).toEqual([])
    expect(arrivedUnreadIds(previous, [conversation('b', false, T(20)), conversation('c', true, T(20))])).toEqual([])
  })

  it('still chimes for mail newer than the oldest thread already shown', () => {
    const previous = liveListBaseline([conversation('a', false, T(30)), conversation('b', false, T(20))])
    expect(arrivedUnreadIds(previous, [conversation('a', false, T(30)), conversation('c', true, T(25)), conversation('b', false, T(20))])).toEqual(['c'])
  })

  it('chimes for any unread arrival when the confirmed inbox was empty', () => {
    expect(arrivedUnreadIds(liveListBaseline([]), [conversation('c', true, T(5))])).toEqual(['c'])
  })

  it('never chimes for a thread whose timestamp cannot be parsed', () => {
    const previous = liveListBaseline([conversation('a', false, T(30))])
    expect(arrivedUnreadIds(previous, [conversation('a', false, T(30)), conversation('c', true, 'not a date')])).toEqual([])
  })

  it('schedules three bells per note and reports when audio is blocked', async () => {
    const started: number[] = []
    const oscillator = () => ({
      type: 'sine', frequency: { value: 0 }, connect: vi.fn(), start: (at: number) => started.push(at), stop: vi.fn(),
    })
    const gain = () => ({ gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() })
    const running = {
      currentTime: 10, destination: {} as AudioNode, state: 'running' as AudioContextState, resume: vi.fn(async () => {}),
      createOscillator: oscillator as unknown as () => OscillatorNode, createGain: gain as unknown as () => GainNode,
    }
    await expect(playNewMailTone(running)).resolves.toBe(true)
    expect(started).toHaveLength(9)
    expect(started.slice(0, 3)).toEqual([10, 10, 10])

    const suspended = { ...running, state: 'suspended' as AudioContextState, resume: vi.fn(async () => {}) }
    await expect(playNewMailTone(suspended)).resolves.toBe(false)
    expect(suspended.resume).toHaveBeenCalledOnce()
  })
})
