export const MARK_READ_DWELL_MS = 5_000

export type MarkReadScheduler = {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

export type MarkReadDwell = {
  schedule(conversationId: string, run: () => void): void
  cancel(): void
}

export function createMarkReadDwell(
  delayMs = MARK_READ_DWELL_MS,
  scheduler: MarkReadScheduler = globalThis,
): MarkReadDwell {
  let token: ReturnType<typeof setTimeout> | undefined
  return {
    schedule(_conversationId, run) {
      if (token !== undefined) scheduler.clearTimeout(token)
      token = scheduler.setTimeout(() => {
        token = undefined
        run()
      }, delayMs)
    },
    cancel() {
      if (token !== undefined) scheduler.clearTimeout(token)
      token = undefined
    },
  }
}
