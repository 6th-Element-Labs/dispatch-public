import { z } from 'zod';
export const extractionVersion='2';
export const email = z.string().email().max(254).transform(v => v.trim().toLowerCase());
const id = z.string().min(1).max(300);
export const sourceSchema = z.object({
    accountEmail: email.optional(), id, kind: z.enum(['email', 'codex', 'transcript']), accountId: id, threadId: id, messageId: z.string(),
    codexThreadId: z.string().optional(), turnId: z.string().optional(), title: z.string().max(1000),
    importId: id.optional(), segment: z.number().int().nonnegative().optional(), startSeconds: z.number().nonnegative().optional(),
    unavailable:z.boolean().optional(),verifiedSpeakers:z.record(email).optional(),
    at: z.string().refine(v=>!v||Number.isFinite(Date.parse(v)),'Invalid source timestamp').transform(v=>v?new Date(v).toISOString():''), author: z.string().max(500), participants: z.array(email).max(100), text: z.string().max(24000),
}).strict();
export type Source = z.infer<typeof sourceSchema>;
export const candidateSchema = z.object({
    existingId: z.string().nullable(), kind: z.enum(['task', 'decision', 'update']), title: z.string().min(1).max(180),
    summary: z.string().max(1500), topic: z.string().min(1).max(100), owner: email.nullable(),
    status: z.enum(['open', 'waiting', 'done']), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    certainty: z.enum(['explicit', 'suggested']), contacts: z.array(email).max(30),
    evidence: z.array(z.object({ sourceId: id, quote: z.string().min(1).max(1000) }).strict()).min(1).max(12),
}).strict();
export const extractionSchema = z.object({ items: z.array(candidateSchema).max(500) }).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export type Status = 'open' | 'waiting' | 'done' | 'snoozed' | 'dismissed';
export interface Evidence {
    source: Source;
    quote: string;
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
    status: Status;
    certainty: 'explicit' | 'suggested';
    snoozedUntil: string | null;
    userEdited: boolean;
    overrides?: string[];
    revision: number;
    updatedAt: string;
    extractionVersion?: string;
    evidence: Evidence[];
    reason?: string;
}
export const actionSchema = z.object({ revision: z.number().int().positive(),
    status: z.enum(['open', 'waiting', 'done', 'snoozed', 'dismissed']).optional(),
    snoozedUntil: z.string().datetime().nullable().optional(), title: z.string().trim().min(1).max(180).optional(),
    owner: email.nullable().optional(), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    certainty: z.enum(['explicit', 'suggested']).optional(),
}).strict();
export type Action = z.infer<typeof actionSchema>;
export interface ScanState {
    enabled: boolean;
    running: boolean;
    scanned: number;
    total: number;
    depth: number;
    lastScan: string | null;
    error: string | null;
    failures: number;
}

export const settingsSchema = z.object({
    enabled: z.boolean(), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59),
    days: z.number().int().min(1).max(3650), accounts: z.array(id).max(100),
    importantContacts: z.array(email).max(100), importantTopics: z.array(id).max(100),
}).strict();
export type WorkSettings = z.infer<typeof settingsSchema>;
export interface Account { id: string; email: string; name?: string }
export interface Coverage {
    scope:'indexed'; from:string; discovered:number; reviewed:number; pending:number; failed:number;
    ingestionAt:string|null; mailSyncAt:string|null; mailState:string; caughtUp:boolean; complete:boolean;
}
export interface WorkJob { key: string; accountId: string; kind: 'email' | 'transcript' | 'codex'; contextId: string; revision: string; attempts: number; error: string | null; priority?:number }
export const transcriptSchema = z.object({
    accountId: id, importId: id, title: z.string().trim().min(1).max(1000), at: z.string().datetime({offset:true}),
    text: z.string().min(1).max(1000000), format: z.enum(['txt','vtt','srt']),
    participants: z.array(email).max(100), speakers: z.record(email).default({}),
}).strict();
export type TranscriptInput = z.infer<typeof transcriptSchema>;
export const briefingOutputSchema = z.object({
    lead: z.array(z.object({ text:z.string().min(1).max(1200), itemIds:z.array(id).min(1).max(30) }).strict()).max(5),
    entries: z.array(z.object({ itemId:id, section:z.enum(['attention','updates','waiting','upcoming']), text:z.string().min(1).max(800) }).strict()).max(80),
}).strict();
export type BriefingContent = z.infer<typeof briefingOutputSchema>;
export interface Briefing {
    id:string; date:string; revision:number; preparedAt:string; cutoff:string; timezone:string;
    content:BriefingContent; items:WorkItem[]; coverage:Coverage;
    selection:{total:number;included:number};
}
