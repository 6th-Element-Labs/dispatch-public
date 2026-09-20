import type { ConversationSummary } from './contracts.js'

/** One synthesized bell in the new-mail chime: a bright fundamental plus two fast-decaying inharmonic partials. */
export interface ToneNote {
  readonly frequency: number
  readonly startOffset: number
  readonly duration: number
  readonly gain: number
}

const C6 = 1046.5
const E6 = 1318.5
const G6 = 1568

/** Ascending C-E-G triad, 90ms apart, each note ringing for a quarter second. */
export function triadNotes(): readonly ToneNote[] {
  return [C6, E6, G6].map((frequency, index) => ({ frequency, startOffset: index * 0.09, duration: 0.45, gain: 0.35 }))
}

/** What a confirmed live list showed: its thread ids and the timestamp of the oldest thread on the page. */
export interface LiveListBaseline {
  readonly ids: ReadonlySet<string>
  /** Epoch ms of the oldest thread shown, or undefined when the confirmed list was empty. */
  readonly oldestReceivedAt: number | undefined
}

export function liveListBaseline(conversations: readonly ConversationSummary[]): LiveListBaseline {
  const times = conversations.map((conversation) => Date.parse(conversation.receivedAt)).filter((time) => !Number.isNaN(time))
  return { ids: new Set(conversations.map((conversation) => conversation.id)), oldestReceivedAt: times.length > 0 ? Math.min(...times) : undefined }
}

/**
 * Ids of unread conversations that are new mail relative to the previous confirmed live list:
 * absent from it and newer than the oldest thread it showed.
 *
 * The previous list must come from a confirmed live load; a cached or empty baseline
 * would chime for every message that arrived while the app was closed.
 * The age check keeps archive, trash, and mark-read silent: each of those refreshes the
 * page, and the next older thread that scrolls onto it is not new mail even when unread.
 */
export function arrivedUnreadIds(previous: LiveListBaseline | undefined, next: readonly ConversationSummary[]): string[] {
  if (!previous) return []
  return next
    .filter((conversation) => {
      if (!conversation.unread || previous.ids.has(conversation.id)) return false
      const receivedAt = Date.parse(conversation.receivedAt)
      if (Number.isNaN(receivedAt)) return false
      return previous.oldestReceivedAt === undefined || receivedAt > previous.oldestReceivedAt
    })
    .map((conversation) => conversation.id)
}

interface AudioLike {
  readonly currentTime: number
  readonly destination: AudioNode
  readonly state: AudioContextState
  resume(): Promise<void>
  createOscillator(): OscillatorNode
  createGain(): GainNode
}

function scheduleBell(context: AudioLike, note: ToneNote, partial: number, level: number, decay: number): void {
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const start = context.currentTime + note.startOffset
  oscillator.type = 'sine'
  oscillator.frequency.value = note.frequency * partial
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(note.gain * level, start + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.0005, start + decay)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(start)
  oscillator.stop(start + note.duration)
}

/** Plays the triad on the given context. Resolves false when the browser keeps audio suspended (no user gesture yet). */
export async function playNewMailTone(context: AudioLike, notes: readonly ToneNote[] = triadNotes()): Promise<boolean> {
  if (context.state === 'suspended') await context.resume()
  if (context.state !== 'running') return false
  for (const note of notes) {
    scheduleBell(context, note, 1, 1, note.duration)
    scheduleBell(context, note, 2.76, 0.35, 0.08)
    scheduleBell(context, note, 5.4, 0.15, 0.04)
  }
  return true
}
