import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
for(const mode of ['empty','unknown','malformed'])test(`controller facts-only routing ${mode}`,async()=>{
 const s=defaultSettings();s.realm='void';s.adversary.enabled=true;
 const ctx={name2:'a',chatId:mode,chatMetadata:{},chat:[{mes:'大厅空无一人。'}],saveMetadata:async()=>{},setExtensionPrompt:()=>{},loadWorldInfo:async()=>({entries:{1:{uid:1,content:'REJECTED_SECRET'}}})};
 const app=new GuideController(ctx,s);app.ui={say:()=>{}};app.verifiedCurrentHookPool=async()=>({ok:true,hooks:[{book:'Canon',uid:1,brief:'INDEX_SECRET'}]});
 const old=LlmClient.prototype.complete;let composed=0;
 try{LlmClient.prototype.complete=async function(req){let body;
 if(this.label==='共享事实观察')body={proposals:[]};else if(this.label==='剧情定位')body={picks:mode==='empty'?[]:[1]};else if(this.label==='原文适用性核查')body=mode==='malformed'?{wrong:[]}:{sourceAssessment:[{book:'Canon',uid:1,status:'unknown',conditions:[],evidence:[],reason:'not ready'}]};else {composed++;assert.ok(!JSON.stringify(req).includes('REJECTED_SECRET'));assert.ok(!JSON.stringify(req).includes('INDEX_SECRET'));body={guidance:'先看眼前吧。',commentary:'别着急。',emotion:'calm',proposals:[]};}return {ok:true,text:JSON.stringify(body)};};
 const out=await app.askNow({force:true});assert.equal(out.ok,mode!=='malformed');assert.equal(composed,mode==='malformed'?0:1);
 }finally{app._watchStop?.();LlmClient.prototype.complete=old;}
});
