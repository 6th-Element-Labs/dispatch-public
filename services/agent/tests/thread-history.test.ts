import { expect, it, vi } from 'vitest'
import { readThreadHistory, readWorkThreadHistory } from '../src/thread-history.js'

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

it('confirms an unloaded bound chat has no stored history without replacing it', async () => {
  const runtime = { request: vi.fn(async (method: string) => {
    throw new Error(method === 'thread/resume' ? 'no rollout found for thread id empty' : 'thread not loaded: empty')
  }) }
  expect(await readWorkThreadHistory(runtime, 'empty')).toBeNull()
  expect(runtime.request.mock.calls.map(([method])=>method)).toEqual(['thread/read','thread/resume'])
  expect(runtime.request).toHaveBeenLastCalledWith('thread/resume',{threadId:'empty',excludeTurns:true})
})

it('loads the same saved chat only after an exact unloaded error', async () => {
  let loaded=false
  const runtime={request:vi.fn(async(method:string,params:any):Promise<any>=>{
    if(method==='thread/resume'){loaded=true;return {thread:{id:'saved'}}}
    if(!loaded)throw new Error('thread not loaded: saved')
    return {thread:{id:'saved',historyMode:'legacy',turns:params.includeTurns?[{id:'turn',items:[]}]:[]}}
  })}
  expect((await readWorkThreadHistory(runtime,'saved')).thread.turns).toHaveLength(1)
  expect(runtime.request).not.toHaveBeenCalledWith('thread/start',expect.anything())
})

it('retains transient, permission and busy errors as review failures', async () => {
  for(const message of ['request timed out','thread not loaded: other','permission denied','already has an active writer']){
    const runtime={request:vi.fn(async()=>{throw new Error(message)})}
    await expect(readWorkThreadHistory(runtime,'saved')).rejects.toThrow(message)
    expect(runtime.request).toHaveBeenCalledTimes(1)
  }
  const runtime={request:vi.fn(async(method:string)=>{throw new Error(method==='thread/read'?'thread not loaded: saved':'request timed out')})}
  await expect(readWorkThreadHistory(runtime,'saved')).rejects.toThrow('request timed out')
})

it('does not call existing paginated metadata missing when full history is unavailable',async()=>{
 const runtime={request:vi.fn(async(method:string):Promise<any>=>{
   if(method==='thread/read')return {thread:{id:'saved',historyMode:'paginated'}}
   throw new Error('thread not loaded: saved')
 })}
 await expect(readWorkThreadHistory(runtime,'saved')).rejects.toThrow('thread not loaded: saved')
 expect(runtime.request).not.toHaveBeenCalledWith('thread/resume',expect.anything())
});

it('does not report a partial or repeated page as complete history', async () => {
  const runtime = { request: vi.fn(async (method: string): Promise<any> => method === 'thread/read' ? { thread: { historyMode: 'paginated' } } : { data: [{ items: [], itemsView: 'full' }], nextCursor: 'same' }) }
  await expect(readThreadHistory(runtime, 'chat')).rejects.toThrow(/repeated/)
  runtime.request.mockImplementation(async (method: string): Promise<any> => method === 'thread/read' ? { thread: { historyMode: 'paginated' } } : { data: [{ items: [], itemsView: 'summary' }], nextCursor: null })
  await expect(readThreadHistory(runtime, 'chat')).rejects.toThrow(/incomplete/)
})
