import { expect, it, vi } from 'vitest'
import { readThreadHistory } from '../src/thread-history.js'

it('reads all pages of a current Codex chat without legacy hydration', async () => {
  const runtime = { request: vi.fn(async (method: string, params: any): Promise<any> => {
    if (method === 'thread/read') {
      if (params.includeTurns) throw new Error('list_turns is not supported yet')
      return { thread: { id: 'chat', historyMode: 'paginated' } }
    }
    expect(params).toMatchObject({ threadId: 'chat', itemsView: 'full', sortDirection: 'asc' })
    return params.cursor ? { data: [{ id: 'two', items: [{ type: 'agentMessage', text: 'Done' }], status: 'completed', itemsView: 'full' }], nextCursor: null } : { data: [{ id: 'one', items: [{ type: 'userMessage', content: 'Keep the budget' }], status: 'completed', itemsView: 'full' }], nextCursor: 'next' }
  }) }
  const history = await readThreadHistory(runtime, 'chat')
  expect(history.thread.turns.map((turn: any) => turn.id)).toEqual(['one', 'two'])
  expect(runtime.request).toHaveBeenCalledTimes(3)
})

it('preserves the supported legacy contract for older saved chats', async () => {
  const runtime = { request: vi.fn(async (_method: string, params: any) => ({ thread: { historyMode: 'legacy', turns: params.includeTurns ? [{ id: 'old', items: [] }] : [] } })) }
  expect((await readThreadHistory(runtime, 'old')).thread.turns).toHaveLength(1)
})

it('does not report a partial or repeated page as complete history', async () => {
  const runtime = { request: vi.fn(async (method: string): Promise<any> => method === 'thread/read' ? { thread: { historyMode: 'paginated' } } : { data: [{ items: [], itemsView: 'full' }], nextCursor: 'same' }) }
  await expect(readThreadHistory(runtime, 'chat')).rejects.toThrow(/repeated/)
  runtime.request.mockImplementation(async (method: string): Promise<any> => method === 'thread/read' ? { thread: { historyMode: 'paginated' } } : { data: [{ items: [], itemsView: 'summary' }], nextCursor: null })
  await expect(readThreadHistory(runtime, 'chat')).rejects.toThrow(/incomplete/)
})
