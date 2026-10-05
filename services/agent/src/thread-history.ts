interface Runtime {
  request(method: string, params?: unknown): Promise<unknown>
}

/** Use the persisted history contract; current Codex threads page turns explicitly. */
export async function readThreadHistory(runtime: Runtime, threadId: string): Promise<any> {
  const metadata = await runtime.request('thread/read', { threadId, includeTurns: false }) as any
  if (metadata.thread?.historyMode !== 'paginated') {
    return runtime.request('thread/read', { threadId, includeTurns: true })
  }
  const turns: any[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await runtime.request('thread/turns/list', { threadId, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' }) as any
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
