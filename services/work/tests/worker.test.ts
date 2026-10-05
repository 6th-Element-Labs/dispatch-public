import { afterEach, it, expect, vi } from 'vitest';
import { WorkStore } from '../src/store.js';
import { WorkScanner } from '../src/worker.js';
afterEach(() => vi.unstubAllGlobals());
const source = { id: 'm', kind: 'email', accountId: 'a', accountEmail: 'boss@example.com', threadId: 't', messageId: 'm', title: 'Weekly', at: '2026-10-01', author: 'jacob@example.com', participants: ['boss@example.com', 'jacob@example.com'], text: 'I will send the proposal.' };
function setup(fail = false) { const store = new WorkStore(':memory:'); let extracts = 0; const fetch = vi.fn(async (input: unknown) => { const url = String(input); if(url.startsWith('http://mail/')&&url.includes('changes'))return Response.json({events:[{seq:1,accountId:'a',threadId:'t',available:true}],cursor:1,more:false,accounts:[{id:'a',email:'boss@example.com'}],sync:{state:'partial',completedAt:null}});if(url.includes('changes'))return Response.json({events:[],cursor:0,more:false}); if (url.startsWith('http://mail/') && url.includes('sources'))
    return Response.json({ sources: [source], accountEmail: 'boss@example.com' }); if (url.includes('sources'))
    return Response.json({ sources: [] }); extracts++; return fail ? Response.json({ error: 'Codex temporarily unavailable' }, { status: 503 }) : Response.json({ items: [{ existingId: null, kind: 'task', title: 'Send proposal', summary: 'Jacob will send it.', topic: 'Proposal', owner: 'jacob@example.com', status: 'waiting', due: null, certainty: 'explicit', contacts: ['jacob@example.com'], evidence: [{ sourceId: 'm', quote: source.text }] }] }); }); vi.stubGlobal('fetch', fetch); const scanner = new WorkScanner(store, 'http://mail', 'http://agent'); return { store, scanner, extracts: () => extracts }; }
it('persists scan failures and retries without replacing existing work', async () => { const { store, scanner } = setup(true); await scanner.scan(); expect(store.state()).toMatchObject({ running: false, enabled: true, scanned: 0, failures: 1 }); expect(store.state().error).toMatch(/unavailable/); expect(store.all()).toEqual([]); scanner.stop(); store.close(); });
it('coalesces repeated review of one thread and skips unchanged evidence', async () => { const { store, scanner, extracts } = setup(); await Promise.all([scanner.analyze('a', 't'), scanner.analyze('a', 't')]); expect(extracts()).toBe(1); await scanner.analyze('a', 't'); expect(extracts()).toBe(1); expect(store.all()).toHaveLength(1); scanner.stop(); store.close(); });

it('pause still cancels an in-flight mailbox read after the review timer is restarted', async () => {
 const store = new WorkStore(':memory:');
 let signal: AbortSignal | undefined, release!: (response: Response) => void;
 vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => { signal=init.signal as AbortSignal; return new Promise<Response>(resolve=>{release=resolve}); }));
 const scanner = new WorkScanner(store, 'http://mail', 'http://agent');
 const scan = scanner.scan();
 scanner.start(false);
 const pause = scanner.pause();
 try { expect(signal?.aborted).toBe(true); }
 finally { release(Response.json({candidates:[]})); await scan; await pause; store.close(); }
});

it('an intentional pause is not an error or a completed review', async () => {
 const store = new WorkStore(':memory:');
 vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new DOMException('This operation was aborted','AbortError')),{once:true}))));
 const scanner = new WorkScanner(store, 'http://mail', 'http://agent');
 const scan = scanner.scan();
 await scanner.pause();await scan;
 expect(store.state()).toMatchObject({running:false,error:null,failures:0,lastScan:null});
 store.close();
});
