import { afterEach, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WorkStore } from '../src/store.js';
import { WorkScanner } from '../src/worker.js';
import { createWorkServer } from '../src/server.js';
const resources: {
    server: ReturnType<typeof createWorkServer>;
    store: WorkStore;
    scanner:WorkScanner;
}[] = [];
afterEach(async () => { for (const { server, store,scanner } of resources.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await scanner.pause();store.close();
} vi.unstubAllEnvs(); });
async function start() { const store = new WorkStore(':memory:'); const scanner = new WorkScanner(store, 'http://mail.invalid', 'http://agent.invalid'); const server = createWorkServer(store, scanner); resources.push({ server, store,scanner }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, scanner }; }
it('keeps work available when mail and Codex are offline, rejects foreign origins and malformed writes', async () => { const { base } = await start(); expect((await fetch(base + '/ready')).status).toBe(200); expect(await (await fetch(base + '/v1/work')).json()).toMatchObject({ items: [], decisions: [] }); expect((await fetch(base + '/v1/work/scan', { method: 'POST', headers: { origin: 'https://example.com' }, body: '{}' })).status).toBe(403); expect((await fetch(base + '/v1/work/scan', { method: 'POST', body: 'null' })).status).toBe(400); });
it('requires exact runtime identity to drain and resumes without losing state', async () => { vi.stubEnv('DISPATCH_RUNTIME_ID', 'runtime'); const { base, store } = await start(); expect((await fetch(base + '/v1/runtime/drain', { method: 'POST' })).status).toBe(403); const response = await fetch(base + '/v1/runtime/drain', { method: 'POST', headers: { 'x-dispatch-runtime': 'runtime' } }); expect(await response.json()).toEqual({ service: 'dispatch-work', draining: true, activeOperations: 0 }); expect((await fetch(base + '/v1/work/scan', { method: 'POST' })).status).toBe(503); expect(store.state().enabled).toBe(false); expect((await fetch(base + '/v1/runtime/resume', { method: 'POST', headers: { 'x-dispatch-runtime': 'runtime' } })).status).toBe(200); });
it('queues an explicit thread review immediately without waiting for inference',async()=>{
 const {base,store,scanner}=await start();vi.spyOn(scanner,'scan').mockResolvedValue();const analyze=vi.spyOn(scanner,'analyze');const response=await fetch(base+'/v1/work/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:'a',threadId:'weekly'})});expect(response.status).toBe(202);expect(analyze).not.toHaveBeenCalled();expect(store.coverage().pending).toBe(1);expect(store.claim()).toMatchObject({accountId:'a',contextId:'weekly'});
});
