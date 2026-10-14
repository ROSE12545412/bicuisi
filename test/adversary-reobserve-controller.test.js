import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
for (const mode of ['append','message']) test(`manual adversary retry commits once and restores ${mode} channels without new calls`,async()=>{
 const s=defaultSettings();s.realm='void';s.adversary.enabled=true;s.injection.mode=mode;
 const ctx={name2:'a',chatId:'retry',chatMetadata:{},chat:[{mes:'大厅空无一人。'}],saveMetadata:async()=>{},setExtensionPrompt:()=>{}};
 const app=new GuideController(ctx,s);const bubbles=[];app.ui={say:t=>bubbles.push(t)};
 const old=LlmClient.prototype.complete;let facts=0,compose=0;
 LlmClient.prototype.complete=async req=>{if(req.system.startsWith('Observe neutral events')){facts++;return {ok:true,text:'{"proposals":[]}'};}compose++;return compose===1?{ok:false,error:'temporary failure'}:{ok:true,text:'{"guidance":"再看看门边吧。","commentary":"别急嘛。","emotion":"calm","proposals":[]}'};};
 try{
  assert.equal((await app.askNow({force:true})).ok,false);assert.equal(app.adversaryState().lastTargetIndex,-1);
  assert.equal((await app.askNow({force:true})).ok,true);assert.equal(app.adversaryState().lastTargetIndex,0);assert.equal(facts,1);assert.equal(compose,2);
  const ledger=JSON.stringify(app.adversaryState());const repeats=await app.askNow({force:true});assert.equal(repeats.ok,true);assert.equal(compose,2);assert.equal(facts,1);assert.equal(JSON.stringify(app.adversaryState()),ledger);assert.equal(bubbles.at(-1),'别急嘛。');if(mode==='append') assert.match(ctx.chat[0].extra.display_text,/再看看门边/); else {assert.equal(ctx.chat.length,2);assert.match(ctx.chat[1].mes,/再看看门边/);}
 }finally{app._watchStop?.();LlmClient.prototype.complete=old;}
});
