declare const __DISPATCH_LOCAL_PROXY__: boolean;
const base = typeof __DISPATCH_LOCAL_PROXY__ !== 'undefined' && __DISPATCH_LOCAL_PROXY__ ? `${location.origin}/work` : 'http://127.0.0.1:8413';
export interface WorkSource {
    id: string;
    kind: 'email' | 'codex' | 'transcript';
    accountId: string;
    threadId: string;
    messageId: string;
    codexThreadId?: string;
    turnId?: string;
    importId?:string;
    segment?:number;
    startSeconds?:number;
    unavailable?:boolean;
    title: string;
    at: string;
    author: string;
    text: string;
    participants: string[];
}
export interface WorkItem {
    id: string;
    accountId: string;
    accountEmail?: string;
    kind: 'task' | 'decision' | 'update';
    title: string;
    summary: string;
    topic: string;
    topicId: string;
    contacts: string[];
    owner: string | null;
    due: string | null;
    status: string;
    certainty: 'explicit' | 'suggested';
    snoozedUntil: string | null;
    revision: number;
    updatedAt:string;
    reason?: string;
    evidence: {
        source: WorkSource;
        quote: string;
    }[];
}
export interface WorkView {
    items: WorkItem[];
    decisions: WorkItem[];
    updates: WorkItem[];
    settings:WorkSettings;
    accounts:Array<{id:string;email:string;name?:string}>;
    coverage:WorkCoverage;
    transcripts:Array<{accountId:string;importId:string;title:string;at:string;sources:number}>;
    people: string[];
    topics: {
        id: string;
        name: string;
        accountId: string;
    }[];
    scan: {
        enabled: boolean;
        running: boolean;
        scanned: number;
        total: number;
        depth: number;
        lastScan: string | null;
        error: string | null;
        failures: number;
    };
}
export interface WorkSettings {enabled:boolean;hour:number;minute:number;days:number;accounts:string[];importantContacts:string[];importantTopics:string[]}
export interface WorkCoverage {scope:'indexed';from:string;discovered:number;reviewed:number;pending:number;failed:number;ingestionAt:string|null;mailSyncAt:string|null;mailState:string;caughtUp:boolean;complete:boolean}
export interface BriefingEdition {
    selection:{total:number;included:number};
    id:string;date:string;revision:number;preparedAt:string;cutoff:string;timezone:string;coverage:WorkCoverage;items:WorkItem[];
    content:{lead:Array<{text:string;itemIds:string[]}>;entries:Array<{itemId:string;section:'attention'|'updates'|'waiting'|'upcoming';text:string}>};
}
export interface BriefingView {edition:BriefingEdition|null;requestedDate?:string|null;editions:Array<{id:string;date:string;revision:number;preparedAt:string}>;since:WorkItem[];coverage:WorkCoverage;status:{running:boolean;error:string|null}}
export type WorkContext = {
    kind: 'contact' | 'topic';
    accountId: string;
    contextId: string;
};
async function request<T>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path==='/v1/work/transcripts'?65000:8000) }); const value = await response.json(); if (!response.ok)
    throw new Error(value.detail ?? value.error ?? 'Work is unavailable'); return value as T; }
export const workApi = { item:(id:string)=>request<{item:WorkItem;history:Array<{reason:string;item:WorkItem}>}>(`/v1/work/items/${id}`),briefing:(params:URLSearchParams)=>request<BriefingView>(`/v1/work/briefing?${params}`),prepare:()=>request('/v1/work/briefing',{}),settings:(settings:WorkSettings)=>request('/v1/work/settings',settings),importTranscript:(value:unknown)=>request('/v1/work/transcripts',value),transcript:(account:string,importId:string)=>request<{input:{title:string;at:string};sources:WorkSource[]}>(`/v1/work/transcript?${new URLSearchParams({account,import:importId})}`),undo:(item:WorkItem)=>request<{item:WorkItem}>(`/v1/work/items/${item.id}/undo`,{revision:item.revision}), list: (params: URLSearchParams) => request<WorkView>(`/v1/work?${params}`), action: (item: WorkItem, patch: Record<string, unknown>) => request<{
        item: WorkItem;
    }>(`/v1/work/items/${item.id}`, { revision: item.revision, ...patch }), pause: () => request('/v1/work/pause', {}), scan: (more = false) => request('/v1/work/scan', { more }), analyze: (accountId: string, threadId: string) => request<WorkView>('/v1/work/analyze', { accountId, threadId }) };
