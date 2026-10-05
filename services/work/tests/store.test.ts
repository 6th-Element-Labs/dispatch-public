import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore, fingerprint } from '../src/store.js';
import type { Source, Candidate } from '../src/model.js';
const source = (threadId = 'week1', at = '2026-09-01T12:00:00Z'): Source => ({ id: threadId, kind: 'email', accountId: 'account', accountEmail: 'boss@example.com', threadId, messageId: threadId, title: 'Weekly meeting', author: 'jacob@example.com', participants: ['jacob@example.com', 'boss@example.com'], at, text: 'I will send the revised proposal by September 5. We agreed to use the approved budget.' });
const proposal = (patch: Partial<Candidate> = {}): Candidate => ({ existingId: null, kind: 'task', title: 'Send revised proposal', summary: 'Jacob will send the revised proposal.', topic: 'Proposal', owner: 'jacob@example.com', status: 'waiting', due: '2026-09-05', certainty: 'explicit', contacts: ['jacob@example.com'], evidence: [{ sourceId: 'week1', quote: 'I will send the revised proposal by September 5.' }], ...patch });
describe('work continuity', () => {
    it('reconciles new weekly threads and Codex evidence into one durable item after restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dispatch-work-')), path = join(dir, 'work.sqlite');
        let store = new WorkStore(path);
        try {
            store.reconcile('account', 'week1', [source()], { items: [proposal()] });
            const old = store.all()[0]!;
            const next = source('week2', '2026-09-08T12:00:00Z');
            next.text = 'The revised proposal is still with me.';
            const chat: Source = { ...next, id: 'chat', kind: 'codex', codexThreadId: 'codex-1', turnId: 'turn-1', author: 'You', text: 'Keep the approved budget for this proposal.' };
            store.reconcile('account', 'week2', [next, chat], { items: [proposal({ existingId: old.id, evidence: [{ sourceId: 'week2', quote: next.text }, { sourceId: 'chat', quote: chat.text }] })] });
            expect(store.all()).toHaveLength(1);
            expect(store.all()[0]?.evidence).toHaveLength(3);
            store.close();
            store = new WorkStore(path);
            expect(store.all()[0]?.id).toBe(old.id);
            expect(store.view(new URLSearchParams({ contact: 'jacob@example.com' })).items[0]?.evidence.map(e => e.source.threadId)).toEqual(['week1', 'week2', 'week2']);
        }
        finally {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('never revives Done, dismissed, snoozed or edited items during later scans', () => {
        for (const status of ['done', 'dismissed', 'snoozed'] as const) {
            const store = new WorkStore(':memory:');
            store.reconcile('account', 'a', [source()], { items: [proposal()] });
            const item = store.all()[0]!;
            const snoozedUntil = new Date(Date.now() + 86400000).toISOString();
            store.action(item.id, { revision: item.revision, status, title: 'My title', snoozedUntil: status === 'snoozed' ? snoozedUntil : null });
            store.reconcile('account', 'b', [source()], { items: [proposal({ existingId: item.id, status: 'open' })] });
            expect(store.all()[0]).toMatchObject({ status, title: 'My title', userEdited: true });
            store.close();
        }
    });
    it('rejects invented evidence atomically and does not advance the checkpoint', () => { const store = new WorkStore(':memory:'); expect(() => store.reconcile('account', 'week1', [source()], { items: [proposal(), proposal({ title: 'Bad', evidence: [{ sourceId: 'week1', quote: 'Invented' }] })] })).toThrow(/quoted evidence/); expect(store.all()).toEqual([]); expect(store.seen('week1', fingerprint([source()]))).toBe(false); store.close(); });
    it('rejects cross-account reconciliation and stale user writes', () => { const store = new WorkStore(':memory:'); store.reconcile('account', 'a', [source()], { items: [proposal()] }); const item = store.all()[0]!; expect(() => store.reconcile('other', 'a', [{ ...source(), accountId: 'other' }], { items: [proposal({ existingId: item.id })] })).toThrow(/existing item/); store.action(item.id, { revision: item.revision, status: 'done' }); expect(() => store.action(item.id, { revision: item.revision, status: 'open' })).toThrow(/changed/); store.close(); });
    it('does not roll newer completion back when older mail is scanned later', () => { const store = new WorkStore(':memory:'); store.reconcile('account', 'week2', [source('week2', '2026-09-08T12:00:00Z')], { items: [proposal({ status: 'done', evidence: [{ sourceId: 'week2', quote: 'I will send the revised proposal by September 5.' }] })] }); const item = store.all()[0]!; store.reconcile('account', 'week1', [source()], { items: [proposal({ existingId: item.id })] }); expect(store.all()[0]?.status).toBe('done'); store.close(); });
    it('groups identical titles by account and participants without merging unrelated owners', () => { const store = new WorkStore(':memory:'); store.reconcile('account', 'a', [source()], { items: [proposal()] }); store.reconcile('other', 'b', [{ ...source(), accountId: 'other' }], { items: [proposal()] }); expect(store.all()).toHaveLength(2); store.close(); });
    it('ranks due commitments before suggestions and returns durable decisions separately', () => { const store = new WorkStore(':memory:'); store.reconcile('account', 'a', [source()], { items: [proposal(), proposal({ title: 'Ask about proposal', due: null, certainty: 'suggested' }), proposal({ kind: 'decision', title: 'Approved budget', due: null })] }); const view = store.view(new URLSearchParams(), new Date('2026-09-06')); expect(view.items[0]?.reason).toBe('Past due'); expect(view.items[1]?.certainty).toBe('suggested'); expect(view.decisions).toHaveLength(1); store.close(); });
});

it('preserves an edited title while still accepting later completion evidence',()=>{
 const store=new WorkStore(':memory:');store.reconcile('account','a',[source()],{items:[proposal()]});const item=store.all()[0]!;store.action(item.id,{revision:item.revision,title:'My title'});store.reconcile('account','b',[source()],{items:[proposal({existingId:item.id,status:'done'})]});expect(store.all()[0]).toMatchObject({title:'My title',status:'done'});store.close()
})

it('undo restores the prior user override state instead of freezing untouched fields',()=>{
 const store=new WorkStore(':memory:');store.reconcile('account','a',[source()],{items:[proposal()]});const item=store.all()[0]!;const changed=store.action(item.id,{revision:item.revision,status:'done'});const restored=store.undo(item.id,changed.revision);expect(restored).toMatchObject({status:'waiting',userEdited:false});store.reconcile('account','b',[source()],{items:[proposal({existingId:item.id,status:'done'})]});expect(store.get(item.id)?.status).toBe('done');expect(()=>store.undo(item.id,restored.revision)).toThrow(/Undo/);store.close()
})

it('carries completed work and decisions into contact context without leaking other accounts',()=>{
 const store=new WorkStore(':memory:');
 store.reconcile('account','a',[source()],{items:[proposal(),proposal({kind:'decision',title:'Use approved budget'})]});
 store.reconcile('other','b',[{...source(),accountId:'other'}],{items:[proposal({title:'Other account proposal'})]});
 const item=store.all('account').find(i=>i.kind==='task')!;
 store.action(item.id,{revision:item.revision,status:'done'});
 const context=store.context(new URLSearchParams({account:'account',contact:'jacob@example.com'}));
 expect(context).toMatchObject({total:2,returned:2,limited:false});
 expect(context.items.some(i=>i.status==='done')).toBe(true);
 expect(context.items.some(i=>i.kind==='decision')).toBe(true);
 expect(context.items.every(i=>i.accountId==='account')).toBe(true);
 expect(store.context(new URLSearchParams({account:'account',contact:'unrelated@example.com'})).items).toEqual([]);
 store.close();
})
