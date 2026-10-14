import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';

test('adversary delivers guidance in display, commentary bubble, plans privately and records request stages', async () => {
 const settings=defaultSettings(); settings.realm='void'; settings.adversary.enabled=true;
 const bubbles=[]; const ctx={name2:'actor',chatId:'channels',chatMetadata:{},chat:[{is_user:true,mes:'我观察大厅。'},{mes:'商人站在大厅。'}],saveMetadata:async()=>{},setExtensionPrompt:()=>{}};
 const app=new GuideController(ctx,settings); app.ui={say:v=>bubbles.push(v)};
 const old=LlmClient.prototype.complete; let calls=0;
 LlmClient.prototype.complete=async req=>{calls++;return {ok:true,text:JSON.stringify(req.system.startsWith('Observe neutral events')?{proposals:[]}:{guidance:'门边的风声很轻，你不妨再听一会。',commentary:'哈哈，你总是这么谨慎呢。',emotion:'smile',proposals:[{type:'plan',plotId:'private',stage:'planned',plan:{objective:'SECRET_CHAIN',traceObjective:'门边出现划痕',apprentice:{name:'商人',introduce:false,evidence:[{index:1,quote:'商人站在大厅',conditionId:''}]},conditions:[{id:'c',event:'门关闭',counter:'移除门'}]},evidence:[],results:[]}]}),meta:{mode:'custom'}};};
 try {
 const out=await app.runPostGeneration(); assert.equal(out.ok,true);assert.equal(calls,2);
 assert.equal(ctx.chat[1].mes,'商人站在大厅。');assert.match(ctx.chat[1].extra.display_text,/门边的风声/);assert.ok(!ctx.chat[1].extra.display_text.includes('SECRET_CHAIN'));
 assert.deepEqual(bubbles,['哈哈，你总是这么谨慎呢。']);assert.equal(app.adversaryState().plots[0].plan.objective,'SECRET_CHAIN');
 assert.equal(app.state().lastResult.guidance,'门边的风声很轻，你不妨再听一会。');assert.match(app.state().adversaryStage.stage,/完成/);
 assert.equal(app.memoryState().reminders[0].realm,'void');
 } finally {app._watchStop?.(); LlmClient.prototype.complete=old;}
});

test('adversary fact failure is visible instead of silently bypassing diagnosis',async()=>{
 const s=defaultSettings();s.realm='void';s.adversary.enabled=true;
 const ctx={name2:'a',chatId:'failure',chatMetadata:{},chat:[{mes:'大厅空无一人。'}],saveMetadata:async()=>{}};
 const app=new GuideController(ctx,s);const old=LlmClient.prototype.complete;
 LlmClient.prototype.complete=async()=>({ok:false,error:'MOCK_EMPTY_RESPONSE'});
 try{await app.onGenerationEnd();assert.match(app.lastError,/MOCK_EMPTY_RESPONSE/);assert.match(app.state().adversaryStage.stage,/停止/);assert.ok(app.state().log.some(s=>s.includes('MOCK_EMPTY_RESPONSE')));}finally{LlmClient.prototype.complete=old;}
});
