import {afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkStore,fingerprint} from '../src/store.js';
import {WorkScanner} from '../src/worker.js';
import {transcriptSources,segmentSources,sourceBatches} from '../src/sources.js';
import type {Source,Candidate} from '../src/model.js';
const source:Source={id:'m1',kind:'email',accountId:'a',accountEmail:'boss@example.com',threadId:'weekly1',messageId:'m1',title:'Scope',at:'2026-10-01T09:00:00Z',author:'jacob@example.com',participants:['boss@example.com','jacob@example.com'],text:'I will send the scope by October 9.'};
const task:Candidate={existingId:null,kind:'task',title:'Send scope',summary:'Jacob owes the revised scope.',topic:'Proposal',owner:'jacob@example.com',status:'waiting',due:'2026-10-09',certainty:'explicit',contacts:['jacob@example.com'],evidence:[{sourceId:source.id,quote:source.text}]};
const stores:WorkStore[]=[];afterEach(()=>{for(const store of stores.splice(0))store.close();vi.unstubAllGlobals();});
const store=()=>{const value=new WorkStore(':memory:');stores.push(value);return value;};
const feed={accounts:[{id:'a',email:'boss@example.com'}],caughtUp:true,mailState:'ready',mailSyncAt:'2026-10-05T09:00:00Z'};
it('persists delivery checkpoints and uncompleted jobs across restart; an old claim cannot consume a new arrival',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dispatch-jobs-')),path=join(dir,'work.sqlite');let s=new WorkStore(path);
 try{const job={key:'mail:a:t',kind:'email' as const,accountId:'a',contextId:'t',revision:'1'};s.ingest('mail',[job],1,feed);const old=s.claim()!;s.close();s=new WorkStore(path);expect(s.cursor('mail')).toBe(1);expect(s.claim()?.revision).toBe('1');s.ingest('mail',[{...job,revision:'2'}],2,feed);s.finishJob(old);expect(s.coverage().pending).toBe(1);expect(s.claim()?.revision).toBe('2');}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
it('keeps different obligations separate even when their titles and contacts are identical',()=>{
 const s=store();s.reconcile('a','week1',[source],{items:[task]});const next={...source,id:'m2',threadId:'week2',text:'I will send a separate scope for the second vessel.'};s.reconcile('a','week2',[next],{items:[{...task,evidence:[{sourceId:next.id,quote:next.text}]}]});expect(s.all()).toHaveLength(2);
});
it('continues one email commitment through two meetings and protects Done and edits',()=>{
 const s=store();s.reconcile('a','week1',[source],{items:[task]});const original=s.all()[0]!;
 for(let week=1;week<=2;week++){const imported=transcriptSources({accountId:'a',importId:`meeting-${week}`,title:'Weekly proposal',at:`2026-10-0${week+1}T09:00:00Z`,format:'vtt',participants:['jacob@example.com'],speakers:{Jacob:'jacob@example.com'},text:'WEBVTT\n\n00:01:30.000 --> 00:01:35.000\n<v Jacob>I am still working on the scope.</v>'},'boss@example.com');const cue=imported.sources[0]!;s.reconcile('a',`meeting-${week}`,imported.sources,{items:[{...task,existingId:original.id,evidence:[{sourceId:cue.id,quote:cue.text}]}]});}
 expect(s.all()).toHaveLength(1);expect(s.all()[0]?.evidence).toHaveLength(3);const current=s.get(original.id)!;s.action(current.id,{revision:current.revision,status:'done',title:'My scope task'});s.reconcile('a','later',[source],{items:[{...task,existingId:current.id}]});expect(s.get(current.id)).toMatchObject({status:'done',title:'My scope task'});expect(s.history(current.id)).toHaveLength(5);
});
it('imports corrected transcripts with stable source identities and no invented speaker emails',()=>{
 const raw={accountId:'a',importId:'weekly',title:'Weekly',at:'2026-10-05T09:00:00Z',format:'srt',participants:[],text:'1\n00:00:10,500 --> 00:00:12,500\nI will check the budget.'};const first=transcriptSources(raw,'boss@example.com'),next=transcriptSources({...raw,text:raw.text.replace('budget','scope')},'boss@example.com');expect(first.sources[0]?.id).toBe(next.sources[0]?.id);expect(first.sources[0]).toMatchObject({startSeconds:10.5,author:'Meeting transcript',participants:['boss@example.com']});expect(first.revision).not.toBe(next.revision);const s=store();s.importTranscript('a','weekly',first,first.revision);s.importTranscript('a','weekly',next,next.revision);expect(s.transcripts()).toHaveLength(1);expect(s.claim()?.revision).toBe(next.revision);
});
it('rejects malformed subtitle cues and segments every byte of a long conversation',()=>{
 expect(()=>transcriptSources({accountId:'a',importId:'bad',title:'Bad',at:'2026-10-05T09:00:00Z',format:'vtt',participants:[],text:'not a subtitle'},'boss@example.com')).toThrow(/no readable/);
 const long={...source,text:'a'.repeat(140000)};const segments=segmentSources([long]);expect(segments.every(s=>s.text.length<=24000)).toBe(true);expect(segments.at(-1)?.text).toBe(long.text.slice(132000));expect(sourceBatches(segments)).toHaveLength(7);
});
it('freezes a morning edition; later completion appears separately and revisions retain the original',()=>{
 const s=store();s.ingest('mail',[],0,feed);s.reconcile('a','week1',[source],{items:[task]});const item=s.all()[0]!,cutoff=new Date(Date.now()-1000).toISOString();
 const first=s.saveBriefing('2026-10-05',{lead:[{text:'Jacob owes the scope.',itemIds:[item.id]}],entries:[{itemId:item.id,section:'waiting',text:'Follow up on the scope.'}]},[item],s.coverage(),cutoff);
 s.action(item.id,{revision:item.revision,status:'done'});const view=s.briefingView(new URLSearchParams());expect(view.edition?.items[0]?.status).toBe('waiting');expect(view.since[0]?.status).toBe('done');
 const second=s.saveBriefing('2026-10-05',{lead:[],entries:[]},[],s.coverage(),new Date().toISOString());expect(second.revision).toBe(2);expect(s.briefings()).toHaveLength(2);expect(s.briefingView(new URLSearchParams({edition:first.id})).edition?.items[0]?.status).toBe('waiting');
 expect(()=>s.saveBriefing('2026-10-06',{lead:[{text:'Invented',itemIds:['missing']}],entries:[]},[],s.coverage(),cutoff)).toThrow(/outside/);
});
it('filters saved editions and later changes by account and contact',()=>{
 const s=store();s.reconcile('a','week1',[source],{items:[task]});const a=s.all()[0]!;const bSource={...source,accountId:'b',id:'b1'},bTask={...task,evidence:[{sourceId:'b1',quote:source.text}]};s.reconcile('b','week1',[bSource],{items:[bTask]});const b=s.all('b')[0]!;
 s.saveBriefing('2026-10-05',{lead:[{text:'A',itemIds:[a.id]},{text:'B',itemIds:[b.id]}],entries:[{itemId:a.id,section:'waiting',text:'A'},{itemId:b.id,section:'waiting',text:'B'}]},[a,b],s.coverage(),new Date().toISOString());const view=s.briefingView(new URLSearchParams({account:'a'}));expect(view.edition?.items.map(i=>i.accountId)).toEqual(['a']);expect(view.edition?.content.lead).toEqual([{text:'A',itemIds:[a.id]}]);
});
it('a failed later chunk commits neither earlier proposals nor a reviewed fingerprint',async()=>{
 const s=store(),long={...source,text:source.text+'x'.repeat(150000)};let calls=0;
 vi.stubGlobal('fetch',vi.fn(async(input:unknown,init:RequestInit)=>{const url=String(input);if(url.startsWith('http://mail'))return Response.json({sources:[long],accountEmail:'boss@example.com'});if(url.includes('/sources'))return Response.json({sources:[]});calls++;const batch=JSON.parse(String(init.body));if(calls===2)return Response.json({error:'model unavailable'},{status:503});return Response.json({items:[{...task,evidence:[{sourceId:batch.sources[0].id,quote:source.text}]}]});}));
 const scanner=new WorkScanner(s,'http://mail','http://agent');await expect(scanner.analyze('a','weekly1')).rejects.toThrow(/unavailable/);expect(calls).toBe(2);expect(s.all()).toEqual([]);expect(s.seen(JSON.stringify(['a','weekly1']),fingerprint(segmentSources([long])))).toBe(false);await scanner.pause();
});
it('reviews new evidence before historical backfill and never guesses an unmapped call owner',()=>{
 const s=store();s.enqueue({key:'old',accountId:'a',kind:'email',contextId:'old',revision:'1',priority:0});s.enqueue({key:'new',accountId:'a',kind:'email',contextId:'new',revision:'2',priority:2});expect(s.claim()?.contextId).toBe('new');
 const unknown={...source,kind:'transcript' as const,author:'Jacob',verifiedSpeakers:{},text:'I will send the scope by October 9.'};expect(()=>s.reconcile('a','unknown',[unknown],{items:[task]})).toThrow(/does not verify/);expect(s.all()).toEqual([]);s.reconcile('a','unknown',[unknown],{items:[{...task,owner:null}]});expect(s.all()[0]?.owner).toBeNull();
});
it('retains removed evidence without implying completion, and can open editions beyond the recent list',()=>{
 const s=store();s.reconcile('a','week1',[source],{items:[task]});const item=s.all()[0]!;s.sourceAvailability('a',source.threadId,[]);expect(s.get(item.id)).toMatchObject({status:'waiting',evidence:[{source:{unavailable:true}}]});s.sourceAvailability('a',source.threadId,[source]);expect(s.get(item.id)?.evidence[0]?.source.unavailable).toBe(false);
 const first=s.saveBriefing('2025-01-01',{lead:[],entries:[{itemId:item.id,section:'waiting',text:'Scope'}]},[item],s.coverage(),new Date().toISOString());for(let n=0;n<95;n++)s.saveBriefing('2026-10-05',{lead:[],entries:[]},[],s.coverage(),new Date().toISOString());expect(s.briefings()).toHaveLength(90);expect(s.briefingView(new URLSearchParams({edition:first.id})).edition?.id).toBe(first.id);expect(s.briefingView(new URLSearchParams({date:'2025-01-01'})).edition?.id).toBe(first.id);expect(s.saveBriefing('2025-01-01',{lead:[],entries:[]},[],s.coverage(),new Date().toISOString()).revision).toBe(2);
});
it('includes a completed informative development in the newspaper without reopening its finished task',async()=>{
 const s=store(),current={...source,at:new Date().toISOString(),text:'The revised proposal was approved.'};s.reconcile('a','news',[current],{items:[{...task,kind:'update',status:'done',title:'Proposal approved',due:null,evidence:[{sourceId:current.id,quote:current.text}]}]});const item=s.all()[0]!;let input:any;
 vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:RequestInit)=>{input=JSON.parse(String(init.body));return Response.json({lead:[{text:'The proposal was approved.',itemIds:[item.id]}],entries:[{itemId:item.id,section:'updates',text:'The revised proposal is approved.'}]});}));const scanner=new WorkScanner(s,'http://mail','http://agent');await scanner.prepareBriefing(true);expect(input.items).toHaveLength(1);expect(s.briefingView(new URLSearchParams()).edition?.content.entries[0]?.section).toBe('updates');expect(s.get(item.id)?.status).toBe('done');await scanner.pause();
});
