import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { actionSchema, extractionSchema, extractionVersion, settingsSchema, briefingOutputSchema, type Action, type Source, type WorkItem, type ScanState, type WorkSettings, type Account, type Coverage, type WorkJob, type Briefing } from './model.js';
const digest = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 32);
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
const key = (s: string) => normalize(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const fingerprint = (sources: Source[]) => digest(JSON.stringify({extractionVersion,sources}));
export class WorkStore {
    #db: DatabaseSync;
    constructor(path: string) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        this.#db = new DatabaseSync(path);
        this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(account_id,fingerprint));
      CREATE TABLE IF NOT EXISTS undo(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scans(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(key TEXT PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,context_id TEXT NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,available_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,available_at);
      CREATE TABLE IF NOT EXISTS transcripts(key TEXT PRIMARY KEY,account_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS item_history(item_id TEXT NOT NULL,revision INTEGER NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(item_id,revision));
      CREATE TABLE IF NOT EXISTS briefings(id TEXT PRIMARY KEY,date TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(date,revision));`);
        if(!this.#db.prepare('PRAGMA table_info(jobs)').all().some(r=>r.name==='priority'))this.#db.exec('ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
        if(!this.#db.prepare('PRAGMA table_info(briefings)').all().some(r=>r.name==='prepared_at')){
            this.#db.exec("ALTER TABLE briefings ADD COLUMN prepared_at TEXT; ALTER TABLE briefings ADD COLUMN cutoff TEXT; UPDATE briefings SET prepared_at=json_extract(payload,'$.preparedAt'),cutoff=json_extract(payload,'$.cutoff')");
        }
        this.#db.prepare("UPDATE jobs SET status='pending' WHERE status='running'").run();
        if(this.#state<string>('extractionVersion','')!==extractionVersion){this.#db.prepare("UPDATE jobs SET status='pending',error=NULL,attempts=0 WHERE status='done'").run();this.#save('extractionVersion',extractionVersion);}
    }
    close() { this.#db.close(); }
    state(): ScanState { const row = this.#db.prepare('SELECT payload FROM state WHERE key=?').get('scan'); return row ? JSON.parse(String(row.payload)) : { enabled: false, running: false, scanned: 0, total: 0, depth: 30, lastScan: null, error: null, failures: 0 }; }
    setState(patch: Partial<ScanState>) { const state = { ...this.state(), ...patch }; this.#db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run('scan', JSON.stringify(state)); return state; }
    #state<T>(name:string, fallback:T):T {const row=this.#db.prepare('SELECT payload FROM state WHERE key=?').get(name);return row?JSON.parse(String(row.payload)) as T:fallback;}
    #save(name:string,value:unknown){this.#db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(name,JSON.stringify(value));}
    settings():WorkSettings {return this.#state('settings',{enabled:true,hour:8,minute:0,days:90,accounts:[],importantContacts:[],importantTopics:[]});}
    configure(raw:unknown) {const previous=this.settings(), next=settingsSchema.parse(raw);this.#save('settings',next);this.setState({enabled:next.enabled});
        if(next.days!==previous.days || JSON.stringify(next.accounts)!==JSON.stringify(previous.accounts)){this.#save('mailCursor',0);this.#save('chatCursor',0);this.#save('caughtUp',false);}
        return next;}
    accounts():Account[]{return this.#state('accounts',[]);}
    briefingStatus():{running:boolean;error:string|null}{return this.#state('briefingStatus',{running:false,error:null});}
    setBriefingStatus(status:{running:boolean;error:string|null}){this.#save('briefingStatus',status);}
    ingestionFailed(){this.#save('caughtUp',false);}
    accountSelected(accountId:string){return !this.settings().accounts.length || this.settings().accounts.includes(accountId);}
    cursor(kind:'mail'|'chat'){return this.#state(`${kind}Cursor`,0);}
    enqueue(job:Pick<WorkJob,'key'|'accountId'|'kind'|'contextId'|'revision'|'priority'>){
        this.#db.prepare(`INSERT INTO jobs(key,account_id,kind,context_id,revision,status,available_at,priority) VALUES(?,?,?,?,?,'pending',?,?)
          ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,status='pending',error=NULL,attempts=0,available_at=excluded.available_at,priority=max(jobs.priority,excluded.priority) WHERE jobs.revision<>excluded.revision`)
          .run(job.key,job.accountId,job.kind,job.contextId,job.revision,new Date().toISOString(),job.priority??0);
    }
    ingest(kind:'mail'|'chat',events:Array<Pick<WorkJob,'key'|'accountId'|'kind'|'contextId'|'revision'|'priority'>>,cursor:number,metadata?:{accounts:Account[];caughtUp:boolean;mailState:string;mailSyncAt:string|null}){
        if(!Number.isSafeInteger(cursor)||cursor<this.cursor(kind))throw new Error('Invalid source cursor.');
        this.#db.exec('BEGIN IMMEDIATE');try {
            for(const job of events)if(this.accountSelected(job.accountId))this.enqueue(job);
            this.#save(`${kind}Cursor`,cursor);this.#save('ingestionAt',new Date().toISOString());
            if(metadata){const oldAccounts=this.accounts().map(a=>a.id).sort(),newAccounts=metadata.accounts.map(a=>a.id).sort();if(JSON.stringify(oldAccounts)!==JSON.stringify(newAccounts))this.#save('chatCursor',0);this.#save('accounts',metadata.accounts);this.#save('caughtUp',metadata.caughtUp);this.#save('mailState',metadata.mailState);this.#save('mailSyncAt',metadata.mailSyncAt);}
            this.#db.exec('COMMIT');
        }catch(error){this.#db.exec('ROLLBACK');throw error;}
    }
    claim():WorkJob|undefined {
        const selected=this.settings().accounts;
        const row=this.#db.prepare(`SELECT * FROM jobs WHERE status IN ('pending','failed') AND available_at<=? ${selected.length?`AND account_id IN (${selected.map(()=>'?').join(',')})`:''} ORDER BY priority DESC,attempts,available_at,key LIMIT 1`).get(new Date().toISOString(),...selected);if(!row)return undefined;
        this.#db.prepare("UPDATE jobs SET status='running' WHERE key=?").run(String(row.key));
        return {key:String(row.key),accountId:String(row.account_id),kind:String(row.kind) as WorkJob['kind'],contextId:String(row.context_id),revision:String(row.revision),attempts:Number(row.attempts),error:row.error?String(row.error):null};
    }
    finishJob(job:WorkJob,error?:unknown,aborted=false){
        const message=error instanceof Error?error.message:error?String(error):null;
        this.#db.prepare('UPDATE jobs SET status=?,attempts=?,error=?,available_at=? WHERE key=? AND revision=?')
            .run(aborted?'pending':message?'failed':'done',job.attempts+(message?1:0),message,new Date(Date.now()+(message?Math.min(1800000,60000*2**Math.min(job.attempts,5)):0)).toISOString(),job.key,job.revision);
    }
    deferJob(job:WorkJob){this.#db.prepare("UPDATE jobs SET status='pending',available_at=? WHERE key=? AND revision=?").run(new Date(Date.now()+30000).toISOString(),job.key,job.revision);}
    retryJobs(){this.#db.prepare("UPDATE jobs SET available_at=? WHERE status='failed'").run(new Date().toISOString());}
    markDiscussionUnavailable(accountId:string,chatId:string){
        for(const item of this.all(accountId)){
            if(!item.evidence.some(e=>e.source.kind==='codex'&&e.source.codexThreadId===chatId&&!e.source.unavailable))continue;
            this.#put({...item,revision:item.revision+1,updatedAt:new Date().toISOString(),evidence:item.evidence.map(e=>e.source.kind==='codex'&&e.source.codexThreadId===chatId?{...e,source:{...e.source,unavailable:true}}:e)},undefined,'Codex source has no stored history');
        }
    }
    markUnavailable(accountId:string,threadId:string){
        this.#db.prepare("UPDATE jobs SET status='done',error=NULL WHERE account_id=? AND kind='email' AND context_id=?").run(accountId,threadId);
        for(const item of this.all(accountId)){
            if(!item.evidence.some(e=>e.source.kind==='email'&&e.source.threadId===threadId&&!e.source.unavailable))continue;
            this.#put({...item,revision:item.revision+1,updatedAt:new Date().toISOString(),evidence:item.evidence.map(e=>e.source.kind==='email'&&e.source.threadId===threadId?{...e,source:{...e.source,unavailable:true}}:e)},undefined,'Email source is no longer available for review');
        }
    }
    sourceAvailability(accountId:string,threadId:string,sources:Source[]){
        const present=new Set(sources.filter(s=>s.kind==='email').map(s=>s.messageId));
        this.#db.exec('BEGIN IMMEDIATE');try {
            for(const item of this.all(accountId)){
                let changed=false;
                const evidence=item.evidence.map(e=>{if(e.source.kind!=='email'||e.source.threadId!==threadId)return e;const unavailable=!present.has(e.source.messageId);if(Boolean(e.source.unavailable)===unavailable)return e;changed=true;return {...e,source:{...e.source,unavailable}};});
                if(changed)this.#put({...item,evidence,revision:item.revision+1,updatedAt:new Date().toISOString()},undefined,'Email source availability changed');
            }
            this.#db.exec('COMMIT');
        }catch(error){this.#db.exec('ROLLBACK');throw error;}
    }
    coverage():Coverage {
        const rows=this.#db.prepare('SELECT account_id,status,count(*) AS count FROM jobs GROUP BY account_id,status').all().filter(r=>this.accountSelected(String(r.account_id)));
        const count=(statuses:string[])=>rows.filter(r=>statuses.includes(String(r.status))).reduce((sum,r)=>sum+Number(r.count),0);
        const pending=count(['pending','running']),failed=count(['failed']),caughtUp=this.#state('caughtUp',false),mailState=this.#state<string>('mailState','unknown');
        const from=new Date();from.setHours(0,0,0,0);from.setDate(from.getDate()-this.settings().days);
        return {scope:'indexed',from:from.toISOString(),discovered:count(['pending','running','failed','done']),reviewed:count(['done']),pending,failed,
            ingestionAt:this.#state('ingestionAt',null),mailSyncAt:this.#state('mailSyncAt',null),mailState,caughtUp,complete:caughtUp&&pending===0&&failed===0&&mailState==='ready'};
    }
    importTranscript(accountId:string,importId:string,value:unknown,revision:string){
        const key=JSON.stringify(['transcript',accountId,importId]);
        this.#db.exec('BEGIN IMMEDIATE');try{this.#db.prepare('INSERT OR REPLACE INTO transcripts VALUES(?,?,?)').run(key,accountId,JSON.stringify(value));this.enqueue({key,accountId,kind:'transcript',contextId:importId,revision,priority:2});this.#db.exec('COMMIT');}catch(error){this.#db.exec('ROLLBACK');throw error;}
        return key;
    }
    transcript(accountId:string,importId:string):{input:unknown;sources:Source[];revision:string}|undefined{
        const row=this.#db.prepare('SELECT payload FROM transcripts WHERE key=? AND account_id=?').get(JSON.stringify(['transcript',accountId,importId]),accountId);return row?JSON.parse(String(row.payload)):undefined;
    }
    transcripts(accountId?:string){return this.#db.prepare('SELECT account_id,payload FROM transcripts').all().filter(r=>(!accountId||r.account_id===accountId)&&this.accountSelected(String(r.account_id))).map(r=>{const p=JSON.parse(String(r.payload));return {...p.input,text:undefined,sources:p.sources.length,revision:p.revision};});}
    history(id:string){return this.#db.prepare('SELECT reason,payload FROM item_history WHERE item_id=? ORDER BY revision DESC LIMIT 40').all(id).map(r=>({reason:String(r.reason),item:JSON.parse(String(r.payload)) as WorkItem}));}
    saveBriefing(date:string,raw:unknown,items:WorkItem[],coverage:Coverage,cutoff:string,total=items.length):Briefing{
        const content=briefingOutputSchema.parse(raw),ids=new Set(items.map(i=>i.id));
        if(content.lead.some(l=>l.itemIds.some(id=>!ids.has(id)))||content.entries.some(e=>!ids.has(e.itemId)))throw new Error('The briefing cites work outside its source snapshot.');
        if(new Set(content.entries.map(e=>e.itemId)).size!==content.entries.length)throw new Error('The briefing duplicates an entry.');
        if(items.length&&!content.entries.length&&!content.lead.length)throw new Error('The briefing omitted all supplied work.');
        const revision=Number(this.#db.prepare('SELECT coalesce(max(revision),0) AS revision FROM briefings WHERE date=?').get(date)!.revision)+1,preparedAt=new Date().toISOString();
        const briefing:Briefing={id:digest(`${date}:${revision}`),date,revision,preparedAt,cutoff,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,content,items,coverage,selection:{total,included:items.length}};
        this.#db.prepare('INSERT INTO briefings(id,date,revision,payload,prepared_at,cutoff) VALUES(?,?,?,?,?,?)').run(briefing.id,date,revision,JSON.stringify(briefing),preparedAt,cutoff);return briefing;
    }
    #editionHeaders(date?:string):Array<Pick<Briefing,'id'|'date'|'revision'|'preparedAt'|'cutoff'>>{
        return this.#db.prepare(`SELECT id,date,revision,prepared_at,cutoff FROM briefings ${date?'WHERE date=?':''} ORDER BY date DESC,revision DESC ${date?'':'LIMIT 90'}`).all(...(date?[date]:[])).map(r=>({id:String(r.id),date:String(r.date),revision:Number(r.revision),preparedAt:String(r.prepared_at),cutoff:String(r.cutoff)}));
    }
    briefings(){return this.#editionHeaders();}
    briefingView(query:URLSearchParams){
        const date=query.get('date');if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))throw new Error('Choose a valid briefing date.');
        const all=this.briefings();
        const row=query.get('edition')?this.#db.prepare('SELECT payload FROM briefings WHERE id=?').get(query.get('edition')!):date?this.#db.prepare('SELECT payload FROM briefings WHERE date=? ORDER BY revision DESC LIMIT 1').get(date):this.#db.prepare('SELECT payload FROM briefings ORDER BY date DESC,revision DESC LIMIT 1').get();
        const selected=row?JSON.parse(String(row.payload)) as Briefing:null;
        if(selected)for(const header of this.#editionHeaders(selected.date))if(!all.some(b=>b.id===header.id))all.push(header);
        const eligible=(item:WorkItem)=>this.accountSelected(item.accountId)&&(!query.get('account')||item.accountId===query.get('account'))&&(!query.get('contact')||item.contacts.includes(query.get('contact')!.toLowerCase()))&&(!query.get('topic')||item.topicId===query.get('topic'));
        if(!selected)return {edition:null,editions:all.map(({id,date,revision,preparedAt})=>({id,date,revision,preparedAt})),since:[],coverage:this.coverage(),requestedDate:date};
        const items=selected.items.filter(eligible),ids=new Set(items.map(i=>i.id));
        const edition={...selected,items,content:{lead:selected.content.lead.filter(l=>l.itemIds.every(id=>ids.has(id))),entries:selected.content.entries.filter(e=>ids.has(e.itemId))}};
        return {edition,editions:all.map(({id,date,revision,preparedAt})=>({id,date,revision,preparedAt})),since:this.all(query.get('account')||undefined).filter(i=>eligible(i)&&i.updatedAt>selected.cutoff&&!['dismissed','snoozed'].includes(i.status)),coverage:this.coverage()};
    }
    seen(key: string, value: string) { return this.#db.prepare('SELECT fingerprint FROM scans WHERE key=?').get(key)?.fingerprint === value; }
    all(account?: string): WorkItem[] {
        const rows = account ? this.#db.prepare('SELECT payload FROM items WHERE account_id=?').all(account) : this.#db.prepare('SELECT payload FROM items').all();
        return rows.map(r => JSON.parse(String(r.payload)) as WorkItem).map(item => item.status === 'snoozed' && item.snoozedUntil && item.snoozedUntil <= new Date().toISOString() ? { ...item, status: 'open', snoozedUntil: null } : item);
    }
    get(id: string): WorkItem|undefined {
        const row=this.#db.prepare('SELECT payload FROM items WHERE id=?').get(id);if(!row)return undefined;
        const item=JSON.parse(String(row.payload)) as WorkItem;
        return item.status==='snoozed'&&item.snoozedUntil&&item.snoozedUntil<=new Date().toISOString()?{...item,status:'open',snoozedUntil:null}:item;
    }
    #put(item: WorkItem, fp?: string,reason='Evidence reviewed') {
        if (fp)
            this.#db.prepare('INSERT INTO items VALUES(?,?,?,?)').run(item.id, item.accountId, fp, JSON.stringify(item));
        else
            this.#db.prepare('UPDATE items SET payload=? WHERE id=?').run(JSON.stringify(item), item.id);
        this.#db.prepare('INSERT INTO item_history VALUES(?,?,?,?)').run(item.id,item.revision,reason,JSON.stringify(item));
    }
    action(id: string, raw: Action): WorkItem {
        const patch = actionSchema.parse(raw), item = this.get(id);
        if (!item)
            throw Object.assign(new Error('This to-do no longer exists.'), { status: 404 });
        if (item.revision !== patch.revision)
            throw Object.assign(new Error('This to-do changed. Review the latest version and try again.'), { status: 409 });
        if (patch.status === 'snoozed' && (!patch.snoozedUntil || Date.parse(patch.snoozedUntil) <= Date.now()))
            throw new Error('Choose a future snooze time.');
        if (patch.due && (Number.isNaN(Date.parse(patch.due)) || new Date(patch.due).toISOString().slice(0, 10) !== patch.due))
            throw new Error('Choose a valid due date.');
        const next = { ...item, ...patch, revision: item.revision + 1, userEdited: true, overrides: [...new Set([...(item.overrides ?? []), ...Object.keys(patch).filter(k=>k!=='revision'), ...(patch.status ? ['snoozedUntil'] : [])])], updatedAt: new Date().toISOString(), snoozedUntil: patch.status === 'snoozed' ? patch.snoozedUntil! : patch.status ? null : item.snoozedUntil };
        this.#db.exec('BEGIN IMMEDIATE');
        try {this.#db.prepare('INSERT OR REPLACE INTO undo VALUES(?,?,?)').run(id,next.revision,JSON.stringify(item));this.#put(next,undefined,'You updated this work');this.#db.exec('COMMIT')}
        catch(error){this.#db.exec('ROLLBACK');throw error}
        return next;
    }
    undo(id:string,revision:unknown):WorkItem {
        if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1)throw new Error('A valid revision is required.');
        const current=this.get(id),snapshot=this.#db.prepare('SELECT revision,payload FROM undo WHERE id=?').get(id);
        if(!current||current.revision!==revision||snapshot?.revision!==revision)throw Object.assign(new Error('This to-do changed. Undo is no longer available.'),{status:409});
        const restored={...JSON.parse(String(snapshot.payload)) as WorkItem,revision:revision+1,updatedAt:new Date().toISOString()};
        this.#db.exec('BEGIN IMMEDIATE');
        try{this.#put(restored,undefined,'You undid an update');this.#db.prepare('DELETE FROM undo WHERE id=?').run(id);this.#db.exec('COMMIT')}
        catch(error){this.#db.exec('ROLLBACK');throw error}
        return restored;
    }
    /** Validate the complete proposal before a transaction: no partial writes or invented evidence. */
    reconcile(accountId: string, scanKey: string, sources: Source[], raw: unknown): number {
        const { items } = extractionSchema.parse(raw);
        if (sources.some(s => s.accountId !== accountId))
            throw new Error('Source account mismatch');
        const bySource = new Map(sources.map(s => [s.id, s])), existing = this.all(accountId);
        const allowedContacts = new Set(sources.flatMap(s => s.participants));
        const self = sources.find(s => s.accountEmail)?.accountEmail;
        const proposals = items.map(c => {
            if (c.owner && !allowedContacts.has(c.owner))
                throw new Error('Owner is absent from the sources');
            if (c.contacts.some(email => !allowedContacts.has(email)))
                throw new Error('Contact is absent from the sources');
            if (c.due && (Number.isNaN(Date.parse(c.due)) || new Date(c.due).toISOString().slice(0, 10) !== c.due))
                throw new Error('Invalid due date');
            const evidence = c.evidence.map(e => { const source = bySource.get(e.sourceId); if (!source || !normalize(source.text).includes(normalize(e.quote)))
                throw new Error('The quoted evidence was not found in its source'); return { source: { ...source, text: '' }, quote: normalize(e.quote) }; });
            if(c.owner&&evidence.every(e=>e.source.kind==='transcript')&&!evidence.some(e=>e.source.author===c.owner||Object.values(e.source.verifiedSpeakers??{}).includes(c.owner!)||e.quote.toLowerCase().includes(c.owner!)))
                throw new Error('The transcript does not verify this owner. Map the speaker or leave the owner unknown.');
            const previous = c.existingId ? existing.find(i => i.id === c.existingId) : undefined;
            if (c.existingId && (!previous || previous.kind !== c.kind || !(previous.contacts.some(e => e !== self && allowedContacts.has(e)) || previous.evidence.some(e=>sources.some(s=>s.threadId===e.source.threadId || Boolean(s.codexThreadId&&s.codexThreadId===e.source.codexThreadId))))))
                throw new Error('The existing item does not belong to this context');
            return { c, evidence, previous };
        });
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            for (const { c, evidence, previous } of proposals) {
                const anchor=evidence[0]!;
                const fp = digest(`${c.kind}:${key(c.title)}:${[...c.contacts].sort().join(',')}:${anchor.source.id}:${anchor.quote}`);
                const row = this.#db.prepare('SELECT payload FROM items WHERE account_id=? AND fingerprint=?').get(accountId, fp);
                const sameEvidence=existing.find(i=>i.kind===c.kind&&key(i.title)===key(c.title)&&i.evidence.some(e=>evidence.some(next=>next.source.id===e.source.id&&next.quote===e.quote)));
                const old = (previous ? this.get(previous.id) : undefined) ?? (row ? this.get(String((JSON.parse(String(row.payload)) as WorkItem).id)) : undefined) ?? (sameEvidence?this.get(sameEvidence.id):undefined);
                const item: WorkItem = { id: old?.id ?? digest(`${accountId}:${fp}`), accountId, accountEmail: sources.find(s => s.accountEmail)?.accountEmail, kind: c.kind, title: c.title, summary: c.summary,
                    topic: old?.topic??c.topic, topicId: old?.topicId??digest(`${accountId}:${key(c.topic)}`), contacts: [...new Set([...(old?.contacts ?? []), ...c.contacts])], owner: c.owner, due: c.due,
                    status: c.kind === 'task' && c.status === 'open' && c.owner && self && c.owner !== self ? 'waiting' : c.status, certainty: c.certainty, snoozedUntil: null, userEdited: false, revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString(),extractionVersion,
                    evidence: [...new Map([...(old?.evidence ?? []), ...evidence].map(e => [`${e.source.id}:${e.quote}`, e])).values()].slice(-50) };
                const latest = (list: typeof evidence) => list.reduce((date, e) => e.source.at > date ? e.source.at : date, '');
                if (old && latest(evidence) < latest(old.evidence))
                    Object.assign(item, { title: old.title, summary: old.summary, topic: old.topic, topicId: old.topicId, owner: old.owner, due: old.due, status: old.status, certainty: old.certainty });
                // User decisions take precedence forever; AI can add evidence without undoing them.
                if (old?.userEdited) {
                    const fields=old.overrides ?? ['title','owner','due','status','certainty','snoozedUntil'];
                    for(const field of fields)if(['title','owner','due','status','certainty','snoozedUntil'].includes(field))Object.assign(item,{[field]:old[field as keyof WorkItem]});
                    item.userEdited=true;item.overrides=fields;
                }
                this.#put(item, old ? undefined : fp);
            }
            this.#db.prepare('INSERT OR REPLACE INTO scans VALUES(?,?)').run(scanKey, fingerprint(sources));
            this.#db.exec('COMMIT');
            return proposals.length;
        }
        catch (e) {
            this.#db.exec('ROLLBACK');
            throw e;
        }
    }
    context(query:URLSearchParams) {
        const items=this.all(query.get('account')||undefined).filter(i=>(!query.get('contact')||i.contacts.includes(query.get('contact')!.toLowerCase()))&&(!query.get('topic')||i.topicId===query.get('topic')))
            .sort((a,b)=>Number(['done','dismissed'].includes(a.status))-Number(['done','dismissed'].includes(b.status))||b.updatedAt.localeCompare(a.updatedAt));
        return {total:items.length,returned:Math.min(items.length,80),limited:items.length>80,items:items.slice(0,80).map(i=>({...i,summary:i.summary.slice(0,800),evidence:i.evidence.slice(-2).map(e=>({...e,quote:e.quote.slice(0,500)}))}))};
    }
    view(query: URLSearchParams, now = new Date()) {
        let items = this.all(query.get('account') || undefined).filter(i=>this.accountSelected(i.accountId));
        const contact = query.get('contact'), topic = query.get('topic'), thread = query.get('thread'), filter = query.get('filter') ?? 'all';
        if (contact)
            items = items.filter(i => i.contacts.includes(contact.toLowerCase()));
        if (topic)
            items = items.filter(i => i.topicId === topic);
        if (thread)
            items = items.filter(i => i.evidence.some(e => e.source.threadId === thread));
        const people = [...new Set(items.flatMap(i => i.contacts))].sort();
        const topics = [...new Map(items.map(i => [i.topicId, { id: i.topicId, name: i.topic, accountId: i.accountId }])).values()];
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const settings=this.settings(),important=(i:WorkItem)=>Number(i.contacts.some(c=>settings.importantContacts.includes(c))||settings.importantTopics.includes(i.topicId));
        const ranked = items.map(i => ({ ...i, reason: (important(i)?'Important contact or topic · ':'')+(i.status === 'snoozed' ? `Snoozed until ${new Date(i.snoozedUntil!).toLocaleString()}` : i.certainty === 'suggested' ? 'Suggested from the conversation' : i.due && i.due < today ? 'Past due' : i.due === today ? 'Due today' : i.status === 'waiting' ? `Waiting${i.owner ? ' for ' + i.owner : ''}` : i.kind === 'decision' ? 'Decision carried forward' : i.kind==='update'?'Topic development':'Open commitment') }));
        const decisions = ranked.filter(i => i.kind === 'decision' && i.status !== 'dismissed');
        const tasks = ranked.filter(i => i.kind === 'task' && (filter === 'done' ? i.status === 'done' : filter === 'snoozed' ? i.status === 'snoozed' : filter === 'dismissed' ? i.status === 'dismissed' : !['done', 'dismissed', 'snoozed'].includes(i.status)))
            .filter(i => filter === 'waiting' ? i.status === 'waiting' : filter === 'mine' ? Boolean(i.owner && i.owner === (i.accountEmail ?? query.get('self'))) : true)
            .sort((a, b) => Number(a.certainty === 'suggested') - Number(b.certainty === 'suggested') || important(b)-important(a) || (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.updatedAt.localeCompare(a.updatedAt));
        return { items: tasks, decisions, updates:ranked.filter(i=>i.kind==='update'&&i.status!=='dismissed'), people, topics, scan: this.state(), settings:this.settings(), coverage:this.coverage(), accounts:this.accounts(),transcripts:this.transcripts(query.get('account')||undefined) };
    }
}
