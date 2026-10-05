interface Runtime {
  request(method: string, params?: unknown): Promise<unknown>
}

/** A missing rollout is conclusive; timeouts and unloaded sessions are not. */
export function isMissingStoredHistory(error: unknown, threadId: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message === `no rollout found for thread id ${threadId}`
    || message === `thread not found: ${threadId}`
    || message === `unknown thread: ${threadId}`
}

/** Empty opened chats can have a durable Dispatch binding without a saved Codex rollout. */
export async function readWorkThreadHistory(runtime: Runtime, threadId: string): Promise<any | null> {
  let metadata: any
  try { metadata = await runtime.request('thread/read', { threadId, includeTurns: false }) }
  catch (error) {
    if (isMissingStoredHistory(error, threadId)) return null
    if (!(error instanceof Error) || error.message !== `thread not loaded: ${threadId}`) throw error
    try {
      // Load the same identity only. Do not start a turn, replace a binding, or override permissions.
      await runtime.request('thread/resume', { threadId, excludeTurns: true })
    } catch (resumeError) {
      if (isMissingStoredHistory(resumeError, threadId)) return null
      throw resumeError
    }
    metadata = await runtime.request('thread/read', { threadId, includeTurns: false })
  }
  // Once stored metadata exists, an unsupported or incomplete history read is not absence.
  return readHistoryFromMetadata(runtime, threadId, metadata)
}

/** Use the persisted history contract; current Codex threads page turns explicitly. */
export async function readThreadHistory(runtime: Runtime, threadId: string): Promise<any> {
  const metadata = await runtime.request('thread/read', { threadId, includeTurns: false }) as any
  return readHistoryFromMetadata(runtime, threadId, metadata)
}

async function readHistoryFromMetadata(runtime: Runtime, threadId: string, metadata: any): Promise<any> {
  if (metadata.thread?.historyMode !== 'paginated') {
    return runtime.request('thread/read', { threadId, includeTurns: true })
  }
  const turns: any[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    let page: any
    try { page = await runtime.request('thread/turns/list', { threadId, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' }) }
    catch (error) {
      // Codex exposes metadata before an opened chat has its first user message.
      // Only this exact first-page response proves that there are no saved turns.
      if (pageNumber === 0 && error instanceof Error
        && error.message === `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`) {
        return { ...metadata, thread: { ...metadata.thread, turns: [] } }
      }
      throw error
    }
    if (!Array.isArray(page.data) || page.data.some((turn: any) => !Array.isArray(turn.items) || turn.itemsView === 'summary')) {
      throw new Error('Codex returned incomplete chat history. Try again shortly.')
    }
    turns.push(...page.data)
    if (!page.nextCursor) return { ...metadata, thread: { ...metadata.thread, turns } }
    if (typeof page.nextCursor !== 'string' || cursors.has(page.nextCursor)) throw new Error('Codex repeated a chat history cursor. Try again shortly.')
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new Error('This Codex chat exceeds the current history limit. Its earlier context has not been marked reviewed.')
}
