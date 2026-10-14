import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
test('empty public output reports incomplete then manual repair delivers without a second private step',async()=>{
 const s=defaultSettings();s.realm='void';s.adversary.enabled=true;const bubbles=[];
 const ctx={chatId:'empty',name2:'a',chat:[{mes:'大厅空无一人。'}],chatMetadata:{},saveMetadata:async()=>{},setExtensionPrompt:()=>{}};
 const app=new GuideController(ctx,s);app.ui={say:t=>bubbles.push(t)};
 const old=LlmClient.prototype.complete;let calls=0;
 try{LlmClient.prototype.complete=async function(){calls++;return {ok:true,text:JSON.stringify(this.label==='共享事实观察'?{proposals:[]}:calls===2?{guidance:'',commentary:'',emotion:'calm',proposals:[]}:{guidance:'眼前的路，你自己选吧。',commentary:'你可真沉得住气。',emotion:'smile'})};};
 const out=await app.askNow({force:true});assert.equal(out.ok,false);assert.equal(app.adversaryState().lastTargetIndex,0);assert.match(app.lastError,/公开台词/);assert.ok(!app.state().log.some(l=>l.includes('已出声（calm）：「」')));assert.ok(!bubbles.includes(''));
 const plots=JSON.stringify(app.adversaryState().plots);const fixed=await app.askNow({force:true});assert.equal(fixed.ok,true);assert.equal(calls,3);assert.equal(JSON.stringify(app.adversaryState().plots),plots);assert.match(ctx.chat[0].extra.display_text,/眼前的路/);assert.equal(bubbles.at(-1),'你可真沉得住气。');
 }finally{app._watchStop?.();LlmClient.prototype.complete=old;}
});
