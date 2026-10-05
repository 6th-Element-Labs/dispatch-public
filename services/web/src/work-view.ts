import {briefingNavigation,briefingArticle} from './briefing-view.js';
import { workApi, type WorkItem, type WorkView, type WorkSource, type WorkContext, type BriefingView } from './work-api.js';
import './work.css';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const date = (value: string | null) => value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'No due date';
interface Hooks {
    account: () => {
        id?: string;
        email?: string;
    };
    context: (value: WorkContext) => void;
    source: (value: WorkSource) => Promise<void>;
    draft: (item: WorkItem) => Promise<void>;
    showDetail: () => void;
    scopesChanged: () => void;
}
/** Presentation only. Work service owns ranking, filters, evidence and mutations. */
export class WorkPage {
    mode: 'ea' | 'todos' = 'ea';
    active = false;
    context: WorkContext | undefined;
    #data: WorkView | undefined;
    #brief:BriefingView|undefined;
    #edition='';
    #editionDate='';
    #sourceView:WorkSource|undefined;
    #history:Array<{reason:string;item:WorkItem}>=[];
    #selected: WorkItem | undefined;
    #filter = 'all';
    #contact = '';
    #topic = '';
    #account = '';
    #error = '';
    #sequence = 0;
    #busy = false;
    #poll: number | undefined;
    #undo: {
        item: WorkItem;
        before: WorkItem;
    } | undefined;
    get scopes(): {email?:WorkSource; contact?:WorkContext; topic?:WorkContext} {
        const item=this.#selected;
        if(!item)return {};
        const email=[...item.evidence].reverse().find(e=>e.source.kind==='email')?.source;
        const contact=item.contacts.find(c=>c!==(item.accountEmail ?? this.hooks.account().email)) ?? item.contacts[0];
        return {email,contact:contact?{kind:'contact',accountId:item.accountId,contextId:contact}:undefined,topic:{kind:'topic',accountId:item.accountId,contextId:item.topicId}};
    }
    constructor(readonly list: HTMLElement, readonly detail: HTMLElement, readonly hooks: Hooks) {
        list.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-work]'); if (button)
            void this.#click(button).catch(e => this.#fail(e)); });
        detail.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-work]'); if (button)
            void this.#click(button).catch(e => this.#fail(e)); });
        list.addEventListener('change', event => {
            const target=event.target as HTMLSelectElement;if(target.dataset.workSelect==='edition'||target.dataset.workSelect==='edition-date'){this.#edition=target.dataset.workSelect==='edition'?target.value:'';this.#editionDate=target.dataset.workSelect==='edition-date'?target.value:'';this.#selected=undefined;this.#history=[];this.#sourceView=undefined;void this.refresh();return;}
            if(target instanceof HTMLInputElement&&target.name==='file'){const title=target.form?.elements.namedItem('title') as HTMLInputElement|null;if(title&&!title.value)title.value=target.files?.[0]?.name.replace(/\.(txt|vtt|srt)$/i,'')??'';}
         const select = event.target as HTMLSelectElement; if (select.dataset.workSelect === 'person') {
            this.#contact = select.value;
            this.#topic = '';
            void this.refresh();
        } if (select.dataset.workSelect === 'topic') {
            this.#topic = select.value;
            this.#contact = '';
            this.#account = this.#data?.topics.find(t => t.id === select.value)?.accountId ?? '';
            void this.refresh();
        } });
        list.addEventListener('submit',event=>{event.preventDefault();const form=event.target as HTMLFormElement;void this.#submit(form).catch(error=>this.#fail(error));});
        detail.addEventListener('submit', event => { event.preventDefault(); const form = event.target as HTMLFormElement; if (form.dataset.workEdit !== undefined)
            void this.#edit(form).catch(e => this.#fail(e)); });
    }
    async open(mode: 'ea' | 'todos', contact?: string, account?: string) { this.active = true; this.context = undefined; this.mode = mode; this.#contact = contact ?? ''; this.#account = account ?? ''; this.#topic = ''; this.#filter = 'all'; this.#selected = undefined; this.#data = undefined;this.#brief=undefined;this.#edition='';this.#editionDate='';this.#history=[];this.#sourceView=undefined; this.#undo = undefined; this.#error = ''; this.render(); await this.refresh(); clearInterval(this.#poll); this.#poll = window.setInterval(() => { if (this.active && !this.#busy)
        void this.refresh(false); }, 5000); }
    close() { this.active = false; this.context = undefined; this.#sequence++; clearInterval(this.#poll); }
    async refresh(select = true) { const sequence = ++this.#sequence; const a = this.hooks.account(); const params = new URLSearchParams({ filter: this.#filter, ...(this.#account || a.id ? { account: this.#account || a.id! } : {}), ...(a.email ? { self: a.email } : {}), ...(this.#contact ? { contact: this.#contact } : {}), ...(this.#topic ? { topic: this.#topic } : {}) }); try {
        const [data,brief]=await Promise.all([workApi.list(params),...(this.mode==='ea'?[workApi.briefing(new URLSearchParams([...params,...(this.#edition?[['edition',this.#edition] as [string,string]]:this.#editionDate?[['date',this.#editionDate] as [string,string]]:[])]))]:[])]);
        if (sequence !== this.#sequence || !this.active)
            return;
        if (!select && JSON.stringify([this.#data,this.#brief]) === JSON.stringify([data,brief]))
            return;
        if (!select && !this.#busy && (this.detail.querySelector('form')?.contains(document.activeElement)||[...this.list.querySelectorAll('form')].some(f=>f.contains(document.activeElement))))
            return;
        this.#data = data;this.#brief=brief;
        this.#error = '';
        const found=[...data.items, ...data.decisions,...(data.updates??[]),...(brief?.since??[]),...(brief?.edition?.items??[])].find(i=>i.id===this.#selected?.id);
        this.#selected=found&&this.#selected&&found.revision<this.#selected.revision?this.#selected:found??(select&&this.mode==='todos'?data.items[0]??data.decisions[0]:undefined);
        this.render();
        // A polling refresh updates records, but must not change a chosen chat scope.
        if (select || !this.context) this.#setContext();
    }
    catch (e) {
        if (sequence === this.#sequence && this.active)
            this.#fail(e);
    } }
    #setContext() { const item = this.#selected; const accountId = this.#account || item?.accountId || this.hooks.account().id; if (!accountId)
        return; const next: WorkContext | undefined = this.#contact ? { kind: 'contact', accountId, contextId: this.#contact } : this.#topic || item ? { kind: 'topic', accountId, contextId: this.#topic || item!.topicId } : undefined; if (next && JSON.stringify(next) !== JSON.stringify(this.context)) {
        this.context = next;
        this.hooks.context(next);
    } }
    #fail(error: unknown) { this.#error = error instanceof Error ? error.message : String(error);const notice=document.createElement('div');notice.className='work-notice';notice.setAttribute('role','alert');notice.textContent=this.#error+' ';const retry=document.createElement('button');retry.className='btn btn-sm';retry.dataset.work='retry';retry.textContent='Retry';notice.append(retry);this.detail.querySelector('[role=alert]')?.remove();(this.detail.querySelector('.work-detail-inner')??this.detail).prepend(notice); }
    render() {
        const data = this.#data, item = this.#selected, scan = data?.scan;
        if(this.mode==='ea'){this.list.innerHTML=briefingNavigation(this.#brief,this.#edition,this.#editionDate)+this.#controls();if(this.#sourceView)return;this.detail.innerHTML=`<div class="work-detail-inner">${this.#notices()}${item?'<button class="btn btn-sm btn-ghost-secondary" data-work="brief-home"><i class="ti ti-arrow-left" aria-hidden="true"></i>Back to briefing</button>'+this.#item(item):briefingArticle(this.#brief)}</div>`;this.hooks.scopesChanged();return;}
        this.list.innerHTML = `<header class="work-list-header"><span class="work-eyebrow">To-dos</span><h2>Work that stays with you</h2><p>One place for work across emails and calls.</p></header>
      <div class="work-filters" role="group" aria-label="To-do filters">${[['all', 'All'], ['mine', 'Mine'], ['waiting', 'Waiting'], ['done', 'Done'], ['snoozed', 'Snoozed']].map(([v, label]) => `<button class="btn btn-sm ${v === this.#filter ? 'btn-primary' : 'btn-ghost-secondary'}" data-work="filter" data-value="${v}" aria-pressed="${v === this.#filter}">${label}</button>`).join('')}</div>
      <div class="work-rows">${!data ? '<p class="work-empty">Connecting to your work…</p>' : !data.items.length ? `<p class="work-empty">${scan?.running ? 'Reviewing your conversations. Results appear here as they are found.' : scan?.enabled ? 'No to-dos in this view.' : 'Find commitments and unanswered questions in your recent mail and Codex discussions.'}</p>` : data.items.map((row, index) => `${row.certainty === 'suggested' && data.items[index - 1]?.certainty !== 'suggested' ? '<h3 class="work-section-label">Suggestions · review first</h3>' : ''}<button class="work-row ${item?.id === row.id ? 'active' : ''}" data-work="select" data-id="${row.id}" aria-pressed="${item?.id === row.id}"><span class="work-row-icon"><i class="ti ti-${row.status === 'done' ? 'circle-check' : row.status === 'waiting' ? 'clock-hour-4' : 'circle'}" aria-hidden="true"></i></span><span><strong>${escape(row.title)}</strong><small>${escape(row.topic)} · ${escape(row.owner ?? 'Owner not set')}</small><span class="work-row-reason">${escape(row.reason)}${row.due ? ' · ' + date(row.due) : ''}</span></span><i class="ti ti-chevron-right" aria-hidden="true"></i></button>`).join('')}</div>
      ${this.#controls()}`;
        if(this.#sourceView)return;
        this.detail.innerHTML = `<div class="work-detail-inner">${this.#error ? `<div class="work-notice" role="alert">${escape(this.#error)} <button class="btn btn-sm" data-work="retry">Retry</button></div>` : ''}${scan?.error ? `<details class="work-notice"><summary>Some work could not be reviewed</summary><p>${escape(scan.error)}</p><button class="btn btn-sm" data-work="scan">Try again</button></details>` : ''}${this.#undo ? '<div class="work-undo" role="status">To-do updated. <button class="btn btn-sm btn-ghost-primary" data-work="undo">Undo</button></div>' : ''}
      ${this.#contact || this.#topic ? `<header class="work-context-header"><span class="work-eyebrow">${this.#contact ? 'Contact' : 'Topic'} · across threads</span><h2>${escape(this.#contact || data?.topics.find(t => t.id === this.#topic)?.name)}</h2><button class="btn btn-sm btn-ghost-secondary" data-work="clear">All work</button></header>` : ''}
      ${item ? this.#item(item) : '<div class="work-welcome"><i class="ti ti-sparkles" aria-hidden="true"></i><h2>A clear view of what comes next.</h2><p>Select a to-do to see its history, sources and next step.</p></div>'}
      ${data?.decisions.length ? `<section class="work-decisions"><h3>Decisions carried forward</h3>${data.decisions.map(d => `<button data-work="select" data-id="${d.id}" class="work-decision"><i class="ti ti-bookmark" aria-hidden="true"></i><span><strong>${escape(d.title)}</strong><small>${escape(d.summary)}</small></span></button>`).join('')}</section>` : ''}</div>`;
        this.hooks.scopesChanged();
    }
    #item(item: WorkItem) {
        return `<article aria-label="Selected to-do"><div class="work-detail-kicker"><span class="work-status">${escape(item.certainty === 'suggested' ? 'Suggestion' : item.kind === 'decision' ? 'Decision' : item.kind==='update'?'Update':item.status)}</span><span>${escape(item.reason)}</span></div><h1>${escape(item.title)}</h1><p class="work-summary">${escape(item.summary)}</p><div class="work-properties"><span><small>Owner</small>${escape(item.owner ?? 'Not set')}</span><span><small>Due</small>${date(item.due)}</span><span><small>Topic</small><button data-work="topic" data-value="${item.topicId}" class="work-link">${escape(item.topic)}</button></span></div>
    <div class="work-actions">${item.kind === 'task' ? `<button class="btn btn-primary btn-sm" data-work="draft"><i class="ti ti-pencil" aria-hidden="true"></i>Draft follow-up</button><button class="btn btn-sm" data-work="status" data-value="${item.status === 'done' ? 'open' : 'done'}"><i class="ti ti-check" aria-hidden="true"></i>${item.status === 'done' ? 'Reopen' : 'Done'}</button><button class="btn btn-sm" data-work="snooze"><i class="ti ti-clock" aria-hidden="true"></i>Snooze</button>` : ''}${item.certainty === 'suggested' ? '<button class="btn btn-sm" data-work="keep">Keep as to-do</button>' : ''}<button class="btn btn-sm btn-ghost-secondary" data-work="status" data-value="dismissed">Dismiss</button></div>
    <div class="work-contacts">${item.contacts.map(c => `<button class="btn btn-sm btn-ghost-secondary" data-work="contact" data-value="${escape(c)}"><i class="ti ti-user" aria-hidden="true"></i>${escape(c)}</button>`).join('')}</div>
    <details class="work-edit"><summary>Edit details</summary><form data-work-edit><label>To-do<input name="title" class="form-control" value="${escape(item.title)}" required maxlength="180"></label><label>Owner email<input name="owner" type="email" class="form-control" value="${escape(item.owner)}"></label><label>Due date<input name="due" type="date" class="form-control" value="${escape(item.due)}"></label><button class="btn btn-sm" type="submit">Save changes</button></form></details>
    <section class="work-evidence"><h3>Source trail <span>${item.evidence.length}</span></h3>${item.evidence.map((e, index) => `<div class="work-source"><div><i class="ti ti-${e.source.kind === 'email' ? 'mail' : e.source.kind==='transcript'?'microphone':'sparkles'}" aria-hidden="true"></i><button class="work-link" data-work="source" data-index="${index}">${escape(e.source.title)}</button><time>${e.source.at ? date(e.source.at) : 'Codex discussion'}</time></div><blockquote>${escape(e.quote)}</blockquote><small>${escape(e.source.author)}${e.source.startSeconds!==undefined?' · '+this.#timestamp(e.source.startSeconds):''}${e.source.unavailable?' · Source unavailable':''}</small></div>`).join('')}</section>${this.#history.length?`<details class="work-edit"><summary>Change history</summary>${this.#history.map(h=>`<p>${date(h.item.updatedAt)} · ${escape(h.reason)} · ${escape(h.item.status)}</p>`).join('')}</details>`:''}</article>`;
    }
    #timestamp(seconds:number){return `${Math.floor(seconds/3600)?Math.floor(seconds/3600)+':':''}${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(Math.floor(seconds)%60).padStart(2,'0')}`;}
    #notices(){return `${this.#undo?'<div class="work-undo" role="status">Work updated. <button class="btn btn-sm btn-ghost-primary" data-work="undo">Undo</button></div>':''}${this.#error?`<div class="work-notice" role="alert">${escape(this.#error)} <button class="btn btn-sm" data-work="retry">Retry</button></div>`:''}${this.#brief?.status.error?`<div class="work-notice" role="status">${escape(this.#brief.status.error)} <button class="btn btn-sm" data-work="prepare">Retry briefing</button></div>`:''}${this.#data?.scan.error?`<details class="work-notice"><summary>Review needs attention</summary><p>${escape(this.#data.scan.error)}</p><button class="btn btn-sm" data-work="scan">Retry review</button></details>`:''}`;}
    #controls(){
        const data=this.#data,settings=data?.settings,coverage=data?.coverage,scan=data?.scan;
        const known=data?.accounts??[],account=this.hooks.account();
        const accounts=known.length?known:account.id?[{id:account.id,email:account.email??account.id}]:[];
        return `<footer class="work-list-footer"><details><summary>People &amp; topics</summary><label>Contact<select class="form-select form-select-sm" data-work-select="person" aria-label="Work by contact"><option value="">All contacts</option>${(data?.people??[]).map(p=>`<option value="${escape(p)}" ${p===this.#contact?'selected':''}>${escape(p)}</option>`).join('')}</select></label><label>Topic<select class="form-select form-select-sm" data-work-select="topic" aria-label="Work by topic"><option value="">All topics</option>${(data?.topics??[]).map(t=>`<option value="${t.id}" ${t.id===this.#topic?'selected':''}>${escape(t.name)}</option>`).join('')}</select></label></details>
        <p role="status">${coverage?`${coverage.reviewed} reviewed · ${coverage.pending} waiting${coverage.failed?' · '+coverage.failed+' need retry':''} · ${settings?.days} days of indexed mail`:scan?.running?`Reviewed ${scan.scanned} of ${scan.total} conversations`:scan?.lastScan?'Last reviewed '+date(scan.lastScan):'Email stays available during review.'}</p>
        <button class="btn btn-sm btn-ghost-primary" data-work="scan" ${scan?.running?'disabled':''}>${scan?.running?'Reviewing…':settings?.enabled??scan?.enabled?'Review new mail':'Find open work'}</button>${settings?.enabled??scan?.enabled?'<button class="btn btn-sm btn-ghost-secondary" data-work="pause">Pause automatic review</button>':''}<button class="btn btn-sm btn-ghost-secondary" data-work="more">Include older mail</button>
        <details class="work-import"><summary><i class="ti ti-microphone" aria-hidden="true"></i>Import call transcript</summary><form data-work-import><label>Mail account<select name="accountId" class="form-select form-select-sm" required>${accounts.map(a=>`<option value="${escape(a.id)}" ${a.id===account.id?'selected':''}>${escape(a.email)}</option>`).join('')}</select></label><label>Transcript file<input name="file" type="file" accept=".txt,.vtt,.srt" class="form-control form-control-sm" required></label><label>Meeting title<input name="title" class="form-control form-control-sm" maxlength="1000" required></label><label>Meeting time<input name="at" type="datetime-local" class="form-control form-control-sm" required></label><label>Participant emails<input name="participants" class="form-control form-control-sm" placeholder="name@example.com, …"></label><label>Speaker mapping (optional)<textarea name="speakers" class="form-control form-control-sm" placeholder="Speaker name=email@example.com"></textarea></label><small>Use the same filename and meeting time when importing a corrected transcript. Unmapped speakers retain unknown owners.</small><button class="btn btn-primary btn-sm" type="submit">Import transcript</button></form></details>
        ${settings?`<details class="work-preferences"><summary><i class="ti ti-settings" aria-hidden="true"></i>Briefing &amp; review settings</summary><form data-work-settings><label>Morning briefing<input name="time" type="time" class="form-control form-control-sm" value="${String(settings.hour).padStart(2,'0')}:${String(settings.minute).padStart(2,'0')}" required></label><small>Local timezone. Prepares after wake if your Mac was asleep.</small><label>Email history (days)<input name="days" type="number" min="1" max="3650" class="form-control form-control-sm" value="${settings.days}" required></label><fieldset><legend>Accounts</legend>${accounts.map(a=>`<label><input type="checkbox" name="accounts" value="${escape(a.id)}" ${!settings.accounts.length||settings.accounts.includes(a.id)?'checked':''}> ${escape(a.email)}</label>`).join('')}</fieldset><label>Important contacts<input name="importantContacts" class="form-control form-control-sm" value="${escape(settings.importantContacts.join(', '))}" placeholder="email@example.com"></label><label>Important topics<select name="importantTopics" class="form-select form-select-sm" multiple>${(data?.topics??[]).map(t=>`<option value="${t.id}" ${settings.importantTopics.includes(t.id)?'selected':''}>${escape(t.name)}</option>`).join('')}</select></label><label><input name="enabled" type="checkbox" ${settings.enabled?'checked':''}> Automatic review</label><button class="btn btn-sm" type="submit">Save settings</button></form></details>`:''}</footer>`;
    }
    async #submit(form:HTMLFormElement){
        if(!this.#data||this.#busy)return;
        const data=new FormData(form);this.#busy=true;
        const submit=form.querySelector<HTMLButtonElement>('button[type=submit]');if(submit)submit.disabled=true;
        try{
            if(form.dataset.workSettings!==undefined){const [hour,minute]=String(data.get('time')).split(':').map(Number),selected=data.getAll('accounts').map(String);if(!selected.length)throw new Error('Choose at least one mail account.');await workApi.settings({...this.#data.settings,hour:hour!,minute:minute!,days:Number(data.get('days')),accounts:selected.length===this.#data.accounts.length?[]:selected,importantTopics:data.getAll('importantTopics').map(String),importantContacts:String(data.get('importantContacts')??'').split(/[;,\s]+/).filter(Boolean),enabled:data.get('enabled')==='on'});}
            else if(form.dataset.workImport!==undefined){const file=data.get('file') as File;if(!file?.size||file.size>1000000)throw new Error('Choose a TXT, VTT or SRT transcript smaller than 1 MB.');const format=file.name.split('.').at(-1)?.toLowerCase();if(!['txt','vtt','srt'].includes(format??''))throw new Error('Choose a TXT, VTT or SRT file.');const at=new Date(String(data.get('at'))).toISOString(),speakers=Object.fromEntries(String(data.get('speakers')??'').split('\n').filter(line=>line.trim()).map(line=>{const separator=line.indexOf('=');if(separator<1)throw new Error('Use Speaker name=email@example.com for each mapping.');return [line.slice(0,separator).trim(),line.slice(separator+1).trim()];}));await workApi.importTranscript({accountId:String(data.get('accountId')),importId:`${file.name}:${at}`,title:String(data.get('title')),at,format,text:await file.text(),participants:String(data.get('participants')??'').split(/[;,\s]+/).filter(Boolean),speakers});form.reset();}
            this.#error='';await this.refresh(false);
        }finally{this.#busy=false;if(submit)submit.disabled=false;}
    }
    async #transcript(source:WorkSource){
        const sequence=this.#sequence,data=await workApi.transcript(source.accountId,source.importId!);if(sequence!==this.#sequence||!this.active)return;
        this.#sourceView=source;this.detail.innerHTML=`<div class="work-detail-inner"><button class="btn btn-sm btn-ghost-secondary" data-work="return-work">Return to work</button><article><span class="work-eyebrow">Call transcript</span><h1>${escape(data.input.title)}</h1><p>${escape(new Date(data.input.at).toLocaleString())}</p>${data.sources.map(s=>`<section class="transcript-segment" ${s.id===source.id?'data-selected-transcript':''}><small>${s.startSeconds!==undefined?this.#timestamp(s.startSeconds)+' · ':''}${escape(s.author)}</small><pre>${escape(s.text)}</pre></section>`).join('')}</article></div>`;
        this.detail.querySelector('[data-selected-transcript]')?.scrollIntoView({block:'center'});
    }
    async #change(patch: Record<string, unknown>) { const before = this.#selected; if (!before || this.#busy)
        return; this.#busy = true; try {
        const current=await workApi.item(before.id);
        const { item } = await workApi.action(current.item, patch);
        this.#undo = { item, before };
        this.#selected = item;
        await this.refresh(false);
    }
    finally {
        this.#busy = false;
    } }
    async #edit(form: HTMLFormElement) { const data = new FormData(form); await this.#change({ title: data.get('title'), owner: data.get('owner') || null, due: data.get('due') || null }); }
    async #click(button: HTMLElement) {
        const action = button.dataset.work, value = button.dataset.value, item = this.#selected;
        if(['return-work','select','brief-home','filter','contact','topic','clear'].includes(action??''))this.#sourceView=undefined;
        if (action === 'select') {
            this.#selected = [...(this.#data?.items ?? []), ...(this.#data?.decisions ?? []),...(this.#data?.updates??[]),...(this.#brief?.edition?.items??[]),...(this.#brief?.since??[])].find(i => i.id === button.dataset.id);
            this.render();
            this.#setContext();
            this.hooks.showDetail();
            const selectedId=this.#selected?.id;if(selectedId){const current=await workApi.item(selectedId);if(this.#selected?.id===selectedId&&this.active&&!this.detail.querySelector('form')?.contains(document.activeElement)){this.#selected=current.item;this.#history=current.history;this.render();}}
        }
        else if(action==='brief-home'){this.#selected=undefined;this.#history=[];this.render();}
        else if(action==='brief-section'){this.#selected=undefined;this.render();this.detail.querySelector(`#brief-${value}`)?.scrollIntoView({block:'start',behavior:'smooth'});}
        else if(action==='prepare'){await workApi.prepare();this.#edition='';this.#editionDate='';await this.refresh(false);}
        else if(action==='return-work'){this.render();}
        else if (action === 'filter') {
            this.#filter = value!;
            this.#selected = undefined;
            await this.refresh();
        }
        else if (action === 'scan' || action === 'more') {
            await workApi.scan(action === 'more');
            await this.refresh(false);
        }
        else if (action === 'pause') {
            await workApi.pause();
            await this.refresh(false);
        }
        else if (action === 'retry')
            await this.refresh();
        else if (action === 'clear') {
            this.#contact = '';
            this.#topic = '';
            this.#account = '';
            await this.refresh();
        }
        else if (action === 'contact' && item) {
            this.#contact = value!;
            this.#topic = '';
            this.#account = item.accountId;
            await this.refresh();
        }
        else if (action === 'topic' && item) {
            this.#topic = value!;
            this.#contact = '';
            this.#account = item.accountId;
            await this.refresh();
        }
        else if (action === 'source' && item) {
            const source = item.evidence[Number(button.dataset.index)]?.source;
            if(source?.kind==='transcript'&&source.importId)await this.#transcript(source);
            else if (source)await this.hooks.source(source);
        }
        else if (action === 'draft' && item)
            await this.hooks.draft(item);
        else if (action === 'status')
            await this.#change({ status: value });
        else if (action === 'keep')
            await this.#change({ certainty: 'explicit' });
        else if (action === 'snooze') {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            await this.#change({ status: 'snoozed', snoozedUntil: tomorrow.toISOString() });
        }
        else if (action === 'undo' && this.#undo) {
            const { item, before } = this.#undo;
            await workApi.undo(item);
            this.#undo = undefined;
            await this.refresh();
        }
    }
}
