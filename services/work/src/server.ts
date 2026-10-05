import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkStore } from './store.js';
import { WorkScanner } from './worker.js';
import { watchParent } from './parent-watch.js';
import { getJson } from './worker.js';
import { transcriptSources } from './sources.js';
export function createWorkServer(store: WorkStore, scanner: WorkScanner) {
    let draining = false;
    const server = createServer(async (req, res) => {
        const origin = process.env.DISPATCH_ALLOWED_ORIGIN ?? 'http://127.0.0.1:8410';
        const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); res.end(JSON.stringify(body)); };
        if (req.method === 'OPTIONS')
            return reply(204, {});
        if (req.headers.origin && req.headers.origin !== origin)
            return reply(403, { error: 'origin_not_allowed' });
        const url = new URL(req.url ?? '/', 'http://localhost');
        try {
            if (url.pathname === '/health' || url.pathname === '/ready')
                return reply(200, { service: 'dispatch-work', status: 'ready', runtimeId: process.env.DISPATCH_RUNTIME_ID ?? null });
            if (url.pathname === '/v1/runtime')
                return reply(200, { service: 'dispatch-work', runtimeId: process.env.DISPATCH_RUNTIME_ID ?? null, activeOperations: scanner.active ? 1 : 0, draining });
            if (req.method === 'POST' && ['/v1/runtime/drain', '/v1/runtime/resume'].includes(url.pathname)) {
                if (!process.env.DISPATCH_RUNTIME_ID || req.headers['x-dispatch-runtime'] !== process.env.DISPATCH_RUNTIME_ID)
                    return reply(403, { error: 'runtime_identity_required' });
                if (url.pathname.endsWith('resume')) {
                    draining = false;
                    scanner.start();
                    return reply(200, { service: 'dispatch-work', draining });
                }
                draining = true;
                await scanner.pause();
                return reply(200, { service: 'dispatch-work', draining, activeOperations: 0 });
            }
            if (req.method === 'GET' && url.pathname === '/v1/work/context')return reply(200,store.context(url.searchParams));
            if (req.method === 'GET' && url.pathname === '/v1/work/briefing')return reply(200,{...store.briefingView(url.searchParams),status:store.briefingStatus()});
            if (req.method === 'GET' && url.pathname === '/v1/work/settings')return reply(200,{settings:store.settings(),accounts:store.accounts()});
            if (req.method === 'GET' && url.pathname === '/v1/work/transcript'){
                const value=store.transcript(url.searchParams.get('account')??'',url.searchParams.get('import')??'');return reply(value?200:404,value??{error:'transcript_not_found'});
            }
            if (req.method === 'GET' && url.pathname === '/v1/work')
                return reply(200, store.view(url.searchParams));
            const match = /^\/v1\/work\/items\/([a-z0-9]+)(\/undo)?$/.exec(url.pathname);
            if (req.method === 'GET' && match && !match[2]) {
                const item = store.get(match[1]!);
                return reply(item ? 200 : 404, item ? { item,history:store.history(item.id) } : { error: 'not_found' });
            }
            if (req.method !== 'POST')
                return reply(404, { error: 'not_found' });
            if (draining)
                return reply(503, { error: 'restarting' });
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > (url.pathname==='/v1/work/transcripts'?2100000:64000))
                    return reply(413, { error: 'request_too_large' });
                chunks.push(Buffer.from(chunk));
            }
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            if (!body || typeof body !== 'object' || Array.isArray(body))
                return reply(400, { error: 'invalid_body' });
            if (match)
                return reply(200, { item: match[2] ? store.undo(match[1]!,body.revision) : store.action(match[1]!, body) });
            if (url.pathname === '/v1/work/pause') {
                store.configure({...store.settings(),enabled:false});
                store.setState({ enabled: false });
                await scanner.pause();
                return reply(200, { scan: store.state() });
            }
            if(url.pathname==='/v1/work/settings'){
                if(Array.isArray(body.accounts)&&body.accounts.some((id:string)=>!store.accounts().some(a=>a.id===id)))return reply(400,{error:'unknown_review_account',detail:'Choose a connected mail account.'});
                const settings=store.configure(body);if(settings.enabled)scanner.start();else await scanner.pause();return reply(200,{settings});
            }
            if(url.pathname==='/v1/work/briefing'){
                void scanner.prepareBriefing(true).catch(()=>undefined);return reply(202,{status:store.briefingStatus()});
            }
            if(url.pathname==='/v1/work/transcripts'){
                const {accounts}=await getJson(scanner.mailBase,'/v1/accounts');
                const account=accounts.find((a:any)=>a.id===body.accountId);if(!account)return reply(400,{error:'unknown_account'});
                if(!store.accountSelected(account.id))return reply(400,{error:'account_not_selected',detail:'Enable this account in review settings before importing its transcript.'});
                const transcript=transcriptSources(body,account.email.toLowerCase());
                store.importTranscript(account.id,transcript.input.importId,transcript,transcript.revision);
                store.configure({...store.settings(),enabled:true});scanner.start(false);void scanner.scan().catch(()=>undefined);
                return reply(202,{importId:transcript.input.importId,segments:transcript.sources.length,revision:transcript.revision});
            }
            if (url.pathname === '/v1/work/scan') {
                store.retryJobs();
                scanner.start(false);
                void scanner.scan(body.more === true).catch(() => undefined);
                return reply(202, { scan: store.state() });
            }
            if (url.pathname === '/v1/work/analyze') {
                if (typeof body.accountId !== 'string' || !body.accountId || typeof body.threadId !== 'string' || !body.threadId)
                    return reply(400, { error: 'account_and_thread_required' });
                if(!store.accountSelected(body.accountId))return reply(400,{error:'account_not_selected',detail:'Enable this account in review settings before reviewing its thread.'});
                store.enqueue({key:JSON.stringify(['email',body.accountId,body.threadId]),accountId:body.accountId,kind:'email',contextId:body.threadId,revision:`manual:${Date.now()}`,priority:3});
                scanner.start(false);
                void scanner.scan().catch(()=>undefined);
                return reply(202, store.view(new URLSearchParams({ account: body.accountId, thread: body.threadId })));
            }
            return reply(404, { error: 'not_found' });
        }
        catch (e) {
            const error = e as {
                status?: number;
            };
            return reply(error.status ?? 400, { error: 'work_request_failed', detail: e instanceof Error ? e.message : String(e) });
        }
    });
    server.on('close', () => scanner.stop());
    return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const store = new WorkStore(process.env.DISPATCH_WORK_DB ?? join(homedir(), 'Library', 'Application Support', 'Dispatch', 'work.sqlite'));
    const scanner = new WorkScanner(store, process.env.DISPATCH_MAIL_BASE ?? 'http://127.0.0.1:8411', process.env.DISPATCH_AGENT_BASE ?? 'http://127.0.0.1:8412');
    const server = createWorkServer(store, scanner);
    server.listen(Number(process.env.DISPATCH_WORK_PORT ?? 8413), '127.0.0.1', () => scanner.start());
    const stop = () => { const stopping=scanner.pause(); server.close(()=>{void stopping.finally(()=>{store.close();process.exit(0)})}); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    watchParent(process.env.DISPATCH_PARENT_PID, stop);
}
