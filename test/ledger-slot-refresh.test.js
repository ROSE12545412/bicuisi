import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { observeFacts } from '../src/facts.js';
import { observeAdversary } from '../src/adversary.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
import { getChatData, saveChatData } from '../src/core/store.js';
for (const kind of ['facts','adversary']) {
 test(`${kind}: normalized plugin slot replacement during request is safe but changed ledger remains stale`, async()=>{
  const old=LlmClient.prototype.complete;
  try {
   for(const changed of [false,true]) {
    const ctx={name2:'a',chatId:'same',chatMetadata:{},chat:[{mes:'商人站在大厅。'}],saveMetadata:async()=>{}};
    const s=defaultSettings();s.realm='void';s.adversary.enabled=true;
    let resolve;LlmClient.prototype.complete=()=>new Promise(r=>resolve=r);
    const pending=kind==='facts'?observeFacts(ctx,s):observeAdversary(ctx,s);
    const oldSlot=ctx.chatMetadata['beatrice-guide'];
    await saveChatData(ctx,getChatData(ctx));
    assert.notEqual(ctx.chatMetadata['beatrice-guide'],oldSlot);
    if(changed) ctx.chatMetadata['beatrice-guide'][kind].lastTargetIndex=99;
    resolve({ok:true,text:JSON.stringify(kind==='facts'?{proposals:[]}:{guidance:'风很轻。',commentary:'你好啊。',emotion:'smile',proposals:[]})});
    const out=await pending;assert.equal(out.ok,!changed);
    if(changed) assert.match(out.error,/ledger changed/);
    else assert.equal(ctx.chatMetadata['beatrice-guide'][kind].lastTargetIndex,0);
   }
  } finally{LlmClient.prototype.complete=old;}
 });
}
test('facts stale reason identifies source change without exposing prose',async()=>{
 const old=LlmClient.prototype.complete;
 try{const ctx={chatId:'x',name2:'a',chatMetadata:{},chat:[{mes:'PRIVATE_SOURCE'}]};let resolve;
 LlmClient.prototype.complete=()=>new Promise(r=>resolve=r);
 const pending=observeFacts(ctx,defaultSettings());ctx.chat[0].mes='edited';resolve({ok:true,text:'{"proposals":[]}'});
 const out=await pending;assert.match(out.error,/prose\/swipe\/source changed/);assert.ok(!out.error.includes('PRIVATE_SOURCE'));
 }finally{LlmClient.prototype.complete=old;}
});
