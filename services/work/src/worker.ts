import { candidateSchema, extractionSchema, type Candidate, type Source, type WorkJob } from './model.js';
import { sourceBatches, segmentSources } from './sources.js';
import { fingerprint, WorkStore } from './store.js';
export async function getJson(base:string,path:string,init:RequestInit={},signal?:AbortSignal):Promise<any>{
    const response=await fetch(`${base}${path}`,{...init,headers:{'content-type':'application/json',...init.headers},signal:AbortSignal.any([AbortSignal.timeout(/extract|briefing/.test(path)?180000:60000),...(signal?[signal]:[])])});
    const body=await response.json() as any;if(!response.ok)throw Object.assign(new Error(body.detail??body.error??`Service returned ${response.status}`),{status:response.status});return body;
}
const localDate=(now:Date)=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
export class WorkScanner {
    #flight:Promise<void>|undefined;
    #briefing:Promise<void>|undefined;
    #discovery:Promise<void>|undefined;
    #controller:AbortController|undefined;
    #queue:Promise<void>=Promise.resolve();
    #controllers=new Set<AbortController>();
    #analyses=new Map<string,Promise<void>>();
    #timer:ReturnType<typeof setInterval>|undefined;
    get active(){return Boolean(this.#flight||this.#briefing||this.#analyses.size);}
    constructor(readonly store:WorkStore,readonly mailBase:string,readonly agentBase:string){store.setState({running:false});store.setBriefingStatus({running:false,error:null});}
    start(run=true){if(!this.#controller||this.#controller.signal.aborted)this.#controller=new AbortController();clearInterval(this.#timer);this.#timer=setInterval(()=>{if(this.store.settings().enabled){if(this.#flight&&this.#controller)void this.#discover(this.#controller.signal).catch(error=>{if(!this.#controller?.signal.aborted){this.store.ingestionFailed();this.store.setState({error:String(error)});}});else void this.scan().catch(()=>undefined);}},30000);this.#timer.unref();if(run&&this.store.settings().enabled)void this.scan().catch(()=>undefined);}
    stop(){clearInterval(this.#timer);this.#controller?.abort();for(const controller of this.#controllers)controller.abort();}
    async pause(){this.stop();await Promise.allSettled([...(this.#flight?[this.#flight]:[]),...(this.#discovery?[this.#discovery]:[]),...(this.#briefing?[this.#briefing]:[]),...this.#analyses.values()]);}
    scan(more=false):Promise<void>{
        if(this.#flight)return this.#flight;
        const settings=this.store.settings();this.store.configure({...settings,enabled:true,days:more?Math.min(3650,settings.days+90):settings.days});
        this.store.setState({enabled:true,running:true,scanned:0,total:0,failures:0,error:null});
        const controller=this.#controller=new AbortController();
        this.#flight=this.#run(controller.signal).catch(error=>{if(!controller.signal.aborted){this.store.setState({error:error instanceof Error?error.message:String(error)});throw error;}}).finally(()=>{this.store.setState({running:false,...(!controller.signal.aborted?{lastScan:new Date().toISOString()}:{})});this.#flight=undefined;});
        return this.#flight;
    }
    #discover(signal:AbortSignal):Promise<void>{if(this.#discovery)return this.#discovery;this.#discovery=this.#collect(signal).finally(()=>{this.#discovery=undefined;});return this.#discovery;}
    async #collect(signal:AbortSignal){
        const since=this.store.coverage().from;
        for(let page=0;page<10;page++){
            const data=await getJson(this.mailBase,`/v1/work/changes?cursor=${this.store.cursor('mail')}&since=${encodeURIComponent(since)}&limit=200`,{},signal);
            if(signal.aborted)return;
            const known=new Set(data.accounts.map((a:any)=>a.id));
            const events=data.events.filter((e:any)=>known.has(e.accountId));
            for(const e of events)if(!e.available)this.store.markUnavailable(e.accountId,e.threadId);
            this.store.ingest('mail',events.filter((e:any)=>e.available).map((e:any)=>({key:JSON.stringify(['email',e.accountId,e.threadId]),accountId:e.accountId,kind:'email',contextId:e.threadId,revision:String(e.seq),priority:e.baseline?0:2})),data.cursor,
                {accounts:data.accounts,caughtUp:!data.more,mailState:data.sync.state,mailSyncAt:data.sync.completedAt});
            if(!data.more)break;
        }
        for(let page=0;page<10;page++){
            const data=await getJson(this.agentBase,`/v1/work/changes?cursor=${this.store.cursor('chat')}`,{},signal);
            if(signal.aborted)return;
            this.store.ingest('chat',data.events.filter((e:any)=>this.store.accounts().some(a=>a.id===e.accountId)).map((e:any)=>({
                key:JSON.stringify([e.kind==='conversation'?'email':'codex',e.accountId,e.kind==='conversation'?e.contextId:e.codexThreadId]),accountId:e.accountId,
                kind:e.kind==='conversation'?'email':'codex',contextId:e.kind==='conversation'?e.contextId:e.codexThreadId,revision:`chat:${e.seq}`,priority:e.turnId?.startsWith('baseline:')?0:2})),data.cursor);
            if(!data.more)break;
        }
    }
    async #run(signal:AbortSignal){
        try{await this.#discover(signal);}catch(error){if(signal.aborted)return;this.store.ingestionFailed();this.store.setState({failures:1,error:error instanceof Error?error.message:String(error)});}
        this.store.setState({total:this.store.coverage().pending});
        for(let n=0;n<4&&!signal.aborted;n++){
            const job=this.store.claim();if(!job)break;
            try {
                if(job.kind==='email')await this.analyze(job.accountId,job.contextId,signal);
                else if(job.kind==='transcript'){const transcript=this.store.transcript(job.accountId,job.contextId);if(!transcript)throw new Error('The imported transcript is unavailable.');await this.#analyzeSources(job.accountId,job.key,transcript.sources,signal);}
                else {
                    const data=await getJson(this.agentBase,`/v1/work/discussions?${new URLSearchParams({account:job.accountId,chat:job.contextId})}`,{},signal);
                    const account=this.store.accounts().find(a=>a.id===job.accountId);if(!account)throw new Error('This discussion account is unavailable.');
                    const related=this.store.all(job.accountId).filter(i=>data.binding.kind==='topic'?i.topicId===data.binding.contextId:i.contacts.includes(data.binding.contextId));
                    const participants=[...new Set([account.email,...related.flatMap(i=>i.contacts),...(data.binding.kind==='contact'?[data.binding.contextId]:[])])];
                    await this.#analyzeSources(job.accountId,job.key,data.sources.map((s:Source)=>({...s,accountEmail:account.email,participants})),signal);
                }
                if(signal.aborted){this.store.finishJob(job,undefined,true);break;}
                this.store.finishJob(job);this.store.setState({scanned:this.store.state().scanned+1});
            }catch(error){
                if(signal.aborted){this.store.finishJob(job,undefined,true);break;}
                if(job.kind==='codex'&&(error as {status?:number}).status===410){this.store.markDiscussionUnavailable(job.accountId,job.contextId);this.store.finishJob(job);this.store.setState({scanned:this.store.state().scanned+1});continue;}
                if((error as {status?:number}).status===429){this.store.deferJob(job);break;}
                this.store.finishJob(job,error);this.store.setState({failures:this.store.state().failures+1,error:error instanceof Error?error.message:String(error)});
                if([401,403,502,503].includes((error as {status?:number}).status??0))break;
            }
        }
        const coverage=this.store.coverage();
        if(!signal.aborted && coverage.caughtUp&&(this.store.all().length||(!coverage.pending&&!coverage.failed)))await this.prepareBriefing(false,signal);
    }
    analyze(accountId:string,threadId:string,signal?:AbortSignal):Promise<void>{
        const key=JSON.stringify([accountId,threadId]),pending=this.#analyses.get(key);if(pending)return pending;
        if(!this.#controller||this.#controller.signal.aborted)this.#controller=new AbortController();
        const controller=new AbortController();this.#controllers.add(controller);
        const combined=AbortSignal.any([controller.signal,signal??this.#controller.signal]);
        const task=this.#queue.catch(()=>undefined).then(()=>this.#analyze(accountId,threadId,combined)).finally(()=>{this.#analyses.delete(key);this.#controllers.delete(controller);});
        this.#queue=task;this.#analyses.set(key,task);return task;
    }
    async #analyze(accountId:string,threadId:string,signal:AbortSignal){
        const params=new URLSearchParams({account:accountId,thread:threadId}),mail=await getJson(this.mailBase,`/v1/work/sources?${params}`,{},signal);
        this.store.sourceAvailability(accountId,threadId,mail.sources);
        const addresses=new Set<string>(mail.sources.flatMap((s:Source)=>s.participants).filter((e:string)=>e!==mail.accountEmail));
        const related=this.store.all(accountId).filter(i=>i.contacts.some(c=>addresses.has(c)));
        params.set('contacts',JSON.stringify([...addresses].slice(0,30)));params.set('topics',JSON.stringify([...new Set(related.map(i=>i.topicId))].slice(0,30)));
        const chat=await getJson(this.agentBase,`/v1/work/sources?${params}`,{},signal);
        for(const id of chat.unavailableChats??[])this.store.markDiscussionUnavailable(accountId,id);
        await this.#analyzeSources(accountId,JSON.stringify([accountId,threadId]),[...mail.sources,...chat.sources.map((s:Source)=>({...s,accountEmail:mail.accountEmail,participants:[...new Set(mail.sources.flatMap((m:Source)=>m.participants))]}))],signal);
    }
    async #analyzeSources(accountId:string,scanKey:string,raw:Source[],signal:AbortSignal){
        if(signal.aborted)throw new Error('Review interrupted.');
        const sources=segmentSources(raw).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
        if(!sources.length||this.store.seen(scanKey,fingerprint(sources)))return;
        const addresses=new Set(sources.flatMap(s=>s.participants)),related=this.store.all(accountId).filter(i=>i.contacts.some(c=>addresses.has(c)&&c!==i.accountEmail)||i.evidence.some(e=>sources.some(s=>s.threadId===e.source.threadId)));
        const merged=new Map<string,Candidate>();let index=0;
        for(const batch of sourceBatches(sources)){
            const overlay=new Map(related.map(({evidence,...item})=>[item.id,item as Record<string,unknown>]));
            for(const [id,c] of merged)overlay.set(id,{...c,id,accountId,evidence:undefined});
            const existing:Record<string,unknown>[]=[];let contextBytes=0;
            for(const item of [...overlay.values()].sort((a,b)=>Number(['done','dismissed'].includes(String(a.status)))-Number(['done','dismissed'].includes(String(b.status))))){
                const bounded={...item,summary:String(item.summary??'').slice(0,600)},size=JSON.stringify(bounded).length;
                if(contextBytes+size>65000||existing.length>=100)break;existing.push(bounded);contextBytes+=size;
            }
            const result=extractionSchema.parse(await getJson(this.agentBase,'/v1/work/extract',{method:'POST',body:JSON.stringify({sources:batch,existing})},signal));
            if(signal.aborted)throw new Error('Review interrupted.');
            for(const proposal of result.items){
                const id=proposal.existingId??`proposal:${index++}`,old=merged.get(id);
                if(proposal.existingId?.startsWith('proposal:')&&!old)throw new Error('Unknown proposed obligation.');
                merged.set(id,candidateSchema.parse({...proposal,existingId:old?.existingId??(id.startsWith('proposal:')?null:id),evidence:[...new Map([...(old?.evidence??[]),...proposal.evidence].map(e=>[`${e.sourceId}:${e.quote}`,e])).values()].slice(-12)}));
            }
        }
        this.store.reconcile(accountId,scanKey,sources,{items:[...merged.values()]});
    }
    prepareBriefing(force=false,signal?:AbortSignal):Promise<void>{
        if(this.#briefing)return this.#briefing;
        const settings=this.store.settings(),now=new Date(),day=localDate(now);
        if(!force&&(now.getHours()*60+now.getMinutes()<settings.hour*60+settings.minute||this.store.briefings().some(b=>b.date===day)))return Promise.resolve();
        const controller=new AbortController();this.#controllers.add(controller);
        const combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
        this.store.setBriefingStatus({running:true,error:null});
        this.#briefing=(async()=>{
            const cutoff=new Date().toISOString(),view=this.store.view(new URLSearchParams()),last=this.store.briefings()[0];
            const since=last?.cutoff??new Date(Date.now()-7*86400000).toISOString();
            const important=(item:any)=>Number(item.contacts.some((c:string)=>settings.importantContacts.includes(c))||settings.importantTopics.includes(item.topicId));
            const candidates=[...view.items,...view.decisions.filter(i=>i.evidence.some(e=>e.source.at>=since)),...view.updates.filter(i=>i.evidence.some(e=>e.source.at>=since))].filter(i=>!['dismissed','snoozed'].includes(i.status)&&(i.kind!=='task'||i.status!=='done')).sort((a,b)=>important(b)-important(a));
            const items:typeof candidates=[],input:Record<string,unknown>[]=[];let inputBytes=0;
            for(const item of candidates){const bounded={...item,summary:item.summary.slice(0,600),evidence:item.evidence.slice(-2).map(e=>({quote:e.quote.slice(0,500),source:{id:e.source.id,kind:e.source.kind,author:e.source.author,title:e.source.title,at:e.source.at}}))},size=JSON.stringify(bounded).length;if(inputBytes+size>150000||input.length>=120)break;items.push(item);input.push(bounded);inputBytes+=size;}
            const content=items.length?await getJson(this.agentBase,'/v1/work/briefing',{method:'POST',body:JSON.stringify({date:day,items:input})},combined):{lead:[],entries:[]};
            if(combined.aborted)throw new Error('Briefing preparation interrupted.');
            this.store.saveBriefing(day,content,items,this.store.coverage(),cutoff,candidates.length);
        })().catch(error=>{if(!combined.aborted)this.store.setBriefingStatus({running:false,error:error instanceof Error?error.message:String(error)});throw error;}).finally(()=>{this.store.setBriefingStatus({...this.store.briefingStatus(),running:false});this.#controllers.delete(controller);this.#briefing=undefined;});
        return this.#briefing;
    }
}
