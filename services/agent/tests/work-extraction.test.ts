import { it, expect, vi } from 'vitest';
import { extractWork, discussionSources } from '../src/work-extraction.js';
import type { RpcMessage } from '../src/json-line-rpc.js';
const payload = { sources: [{ id: 'm', kind: 'email', accountId: 'a', threadId: 't', messageId: 'm', title: 'Weekly', at: '2026-10-01', author: 'jacob@example.com', participants: ['jacob@example.com'], text: 'Send the proposal.' }], existing: [] };
function runtime(status = 'completed') {
    const listeners = new Set<(m: RpcMessage) => void>();
    const request = vi.fn(async (method: string, params?: any): Promise<any> => {
        if (method === 'config/read')
            return { config: { mcp_servers: { gmail: {} } } };
        if (method === 'thread/start')
            return { thread: { id: 'extract' } };
        if (method === 'turn/start') {
            for (const l of listeners)
                l({ method: 'turn/completed', params: { threadId: 'extract', turn: { id: 'turn', status, items: [{ type: 'agentMessage', text: '{"items":[]}' }] } } });
            return { turn: { id: 'turn' } };
        }
        return {};
    });
    return { request, subscribe: (l: (m: RpcMessage) => void) => { listeners.add(l); return () => listeners.delete(l); }, respond: vi.fn(), listeners };
}
it('uses the real App Server structured output and catches completion before the start response', async () => { const r = runtime(); expect(await extractWork(r, payload)).toEqual({ items: [] }); expect(r.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ ephemeral: true, config: expect.objectContaining({ 'mcp_servers.gmail.enabled': false, 'features.apps': false, 'features.shell_tool': false }) })); expect(r.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ outputSchema: expect.any(Object) })); expect(r.listeners.size).toBe(0); });
it('does not accept failed turns as a successful scan', async () => { await expect(extractWork(runtime('failed'), payload)).rejects.toThrow(/did not complete/); });
it('exports only completed user and assistant discussion items', () => { const value = { thread: { turns: [{ id: 't', status: 'completed', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Keep the approved budget.' }] }, { id: 'cmd', type: 'commandExecution', text: 'secret log' }] }, { id: 'pending', status: 'inProgress', items: [{ id: 'x', type: 'agentMessage', text: 'Partial' }] }] } }; const sources = discussionSources(value, 'a', 'mail', 'chat'); expect(sources).toHaveLength(1); expect(sources[0]).toMatchObject({ text: 'Keep the approved budget.', codexThreadId: 'chat', turnId: 't' }); });
it('uses the lowest supported background effort without changing the configured model',async()=>{
 const r=runtime();const original=r.request.getMockImplementation()!;r.request.mockImplementation(async(method:string,params?:unknown)=>method==='config/read'?{config:{model:'gpt-6-astra'}}:method==='model/list'?{data:[{id:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'xhigh'}]}]}:original(method,params));await extractWork(r,payload);expect(r.request).toHaveBeenCalledWith('thread/start',expect.objectContaining({config:expect.objectContaining({model_reasoning_effort:'medium'})}));
});
