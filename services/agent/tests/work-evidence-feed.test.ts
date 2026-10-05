import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkEvidenceFeed} from '../src/work-evidence-feed.js';
import {CodexBindingStore} from '../src/codex-bindings.js';
it('keeps completed discussion notices after restart and deduplicates replayed turns',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dispatch-discussions-')),path=join(dir,'changes.sqlite');let feed=new WorkEvidenceFeed(path);const binding={kind:'contact' as const,accountId:'gmail:account',contextId:'jacob@example.com',codexThreadId:'chat'};
 try{feed.publish(binding,'t1');feed.publish(binding,'t1');const first=feed.page(0);expect(first.events).toHaveLength(1);feed.close();feed=new WorkEvidenceFeed(path);feed.publish(binding,'t2');expect(feed.page(first.cursor).events).toMatchObject([{turnId:'t2',contextId:'jacob@example.com'}]);expect(()=>feed.page(999)).toThrow(/ahead/);}finally{feed.close();rmSync(dir,{recursive:true,force:true});}
});
it('exports account-scoped bindings without confusing colons in Gmail account IDs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dispatch-work-bind-'));try{const store=new CodexBindingStore(join(dir,'bindings.json'));await store.load();await store.put({kind:'conversation',accountId:'a:b',gmailThreadId:'thread'},'chat');expect(store.workBindings()).toMatchObject([{accountId:'a:b',contextId:'thread',kind:'conversation'}]);}finally{rmSync(dir,{recursive:true,force:true});}
});
