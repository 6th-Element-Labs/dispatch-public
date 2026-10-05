import { createHash } from 'node:crypto';
import { sourceSchema, transcriptSchema, type Source, type TranscriptInput } from './model.js';

/** Preserve original positions; every model quote is checked against this exact segment. */
export function segmentSources(sources: Source[]): Source[] {
    return sources.flatMap(source => {
        if (source.text.length <= 24000) return [sourceSchema.parse(source)];
        const parts: Source[] = [];
        for (let offset=0; offset<source.text.length; offset+=22000) {
            parts.push(sourceSchema.parse({...source,id:`${source.id}:part:${offset}`,segment:offset,text:source.text.slice(offset,offset+24000)}));
        }
        return parts;
    });
}

export function sourceBatches(sources: Source[]): Source[][] {
    const batches: Source[][]=[];
    let current:Source[]=[], bytes=0;
    for (const source of sources) {
        const size=JSON.stringify(source).length;
        if (current.length && (bytes+size>30000 || current.length>=6)) {batches.push(current);current=[];bytes=0;}
        current.push(source);bytes+=size;
    }
    if(current.length)batches.push(current);
    return batches;
}

function seconds(value:string) {
    const parts=value.replace(',', '.').split(':').map(Number);
    return parts.reduce((total,part)=>total*60+part,0);
}

export function transcriptSources(raw:unknown, accountEmail:string): {input:TranscriptInput;sources:Source[];revision:string} {
    const input=transcriptSchema.parse(raw), participants=[...new Set([accountEmail,...input.participants,...Object.values(input.speakers)])];
    const prefix=createHash('sha256').update(JSON.stringify([input.accountId,input.importId])).digest('hex').slice(0,32);
    const base={accountId:input.accountId,accountEmail,kind:'transcript' as const,threadId:`meeting:${prefix}`,messageId:'',
        importId:input.importId,title:input.title,at:input.at,author:'Meeting transcript',participants,verifiedSpeakers:input.speakers};
    const cues=input.format==='txt'?[]:input.text.replace(/\r\n?/g,'\n').split(/\n\s*\n/).flatMap(block=>{
        const lines=block.split('\n'), timing=lines.findIndex(line=>line.includes('-->'));
        if(timing<0)return [];
        const match=/^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->/.exec(lines[timing]!.trim());
        if(!match)throw new Error('Invalid transcript timestamp.');
        const text=lines.slice(timing+1).join('\n').trim();
        if(!text)return [];
        const label=/^<v\s+([^>]+)>/.exec(text)?.[1];
        return [{startSeconds:seconds(lines[timing]!.trim().split(/\s+/)[0]!),text:text.replace(/<[^>]+>/g,''),author:label?(input.speakers[label]??label):base.author}];
    });
    if(input.format!=='txt' && !cues.length)throw new Error('This subtitle file contains no readable transcript cues.');
    const sources=segmentSources(cues.length?cues.map((cue,index)=>({...base,...cue,id:`meeting:${prefix}:${index}`,segment:index})):
        [{...base,id:`meeting:${prefix}`,text:input.text}]);
    return {input,sources,revision:createHash('sha256').update(JSON.stringify(input)).digest('hex')};
}
