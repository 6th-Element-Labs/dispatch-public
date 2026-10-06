import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CodexBindingStore } from './codex-bindings.js';
type Binding=ReturnType<CodexBindingStore['workBindings']>[number];
/** Agent-owned delivery journal. Work reads only the HTTP projection. */
export class WorkEvidenceFeed {
    readonly db:DatabaseSync;
    constructor(path:string){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,source_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);`);}
    publish(binding:Binding,turnId:string){this.db.prepare('INSERT OR IGNORE INTO changes(source_key,payload) VALUES(?,?)').run(JSON.stringify([binding,turnId]),JSON.stringify({...binding,turnId}));}
    publishedBinding(accountId:string,codexThreadId:string):Binding|undefined {
      const row=this.db.prepare("SELECT payload FROM changes WHERE json_extract(payload,'$.accountId')=? AND json_extract(payload,'$.codexThreadId')=? ORDER BY seq DESC LIMIT 1").get(accountId,codexThreadId);
      if(!row)return undefined;
      const {kind,contextId}=JSON.parse(String(row.payload)) as Binding;
      return {kind,accountId,contextId,codexThreadId};
    }
    page(cursor:number,limit=200){const head=Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM changes').get()!.seq);if(cursor>head)throw new Error('Discussion cursor is ahead of its owner.');const rows=this.db.prepare('SELECT seq,payload FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit+1),page=rows.slice(0,limit);return {events:page.map(r=>({...JSON.parse(String(r.payload)),seq:Number(r.seq)})),cursor:rows.length>limit?Number(page.at(-1)!.seq):head,more:rows.length>limit};}
    close(){this.db.close();}
}
