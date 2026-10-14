import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { characterSourceStamp } from '../src/card-source.js';
import { observeFacts } from '../src/facts.js';
import { observeAdversary } from '../src/adversary.js';
import { LlmClient } from '../src/llm/client.js';
import { defaultSettings } from '../src/config.js';
const fixture=()=>({characterId:0,chatId:'a',name2:'card',chatMetadata:{},chat:[{mes:'完整正文。'}],characters:[{avatar:'card.png',description:'original',date_last_chat:1,data:{extensions:{world:'book',depth_prompt:{prompt:'depth',depth:4}}}}]});
test('card setting stamp excludes host save statistics and presentation metadata',()=>{
 const ctx=fixture(), before=characterSourceStamp(ctx);Object.assign(ctx.characters[0],{date_last_chat:2,chat_size:999,fav:true,chat:'saved-chat'});
 ctx.characters[0].data.extensions.fav=true;assert.equal(characterSourceStamp(ctx),before);
 ctx.characters[0].data.extensions.world='different';assert.notEqual(characterSourceStamp(ctx),before);
});
for(const kind of ['facts','adversary']) test(`${kind}: host save timestamp cannot cancel valid response; actual settings still reject`,async()=>{
 const old=LlmClient.prototype.complete;
 try{for(const mutate of [c=>c.date_last_chat++,c=>c.description='edited',c=>c.data.extensions.depth_prompt.prompt='edited']){
 const ctx=fixture();const s=defaultSettings();s.realm='void';s.adversary.enabled=true;let resolve;
 LlmClient.prototype.complete=()=>new Promise(r=>resolve=r);
 const pending=kind==='facts'?observeFacts(ctx,s):observeAdversary(ctx,s);const before=characterSourceStamp(ctx);mutate(ctx.characters[0]);
 const unchanged=characterSourceStamp(ctx)===before;
 resolve({ok:true,text:JSON.stringify(kind==='facts'?{proposals:[]}:{guidance:'你好。',commentary:'好呀。',emotion:'calm',proposals:[]})});
 const out=await pending;assert.equal(out.ok,unchanged);if(!unchanged)assert.match(out.error,/data changed/);
 }}finally{LlmClient.prototype.complete=old;}
});
