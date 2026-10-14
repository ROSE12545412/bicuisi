import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
function setup(){ const ctx={name2:'card',chatId:'a',chat:[{mes:'draft'}],chatMetadata:{}};const app=new GuideController(ctx,defaultSettings());app.log=()=>{};app.syncAdversaryDirector=()=>{};app.ensureHookPool=async()=>({ok:true});return {app,ctx};}
test('ENDED then same-stack STOPPED never launches observation',async()=>{
 const {app}=setup();app.onGenerationStart();let calls=0;app.runPostGeneration=async()=>{calls++;return {ok:true};};
 const end=app.onGenerationEnd();app.onGenerationStopped();await end;assert.equal(calls,0);
 assert.match(app._lastCancellationReason,/GENERATION_STOPPED/);
});
test('successful ENDED starts post-generation once after microtask',async()=>{
 const {app}=setup();let calls=0;app.runPostGeneration=async()=>{calls++;return {ok:true};};await app.onGenerationEnd();assert.equal(calls,1);
});
test('settling reads final full text and resets quiet interval on late prose change',async()=>{
 const {app,ctx}=setup();const token=app.captureLifecycle();
 const timer=setTimeout(()=>{ctx.chat[0].mes='final completed text';},12);
 try{assert.equal(await app.waitForSettledProse(0,token,{quietMs:30,stepMs:5,timeoutMs:200}),true);assert.equal(app.captureTarget(0).mes,'final completed text');}finally{clearTimeout(timer);}
});
test('settling never sends a request for stopped or replaced latest floor',async()=>{
 const {app,ctx}=setup();let token=app.captureLifecycle();const timer=setTimeout(()=>app.onGenerationStopped(),5);
 try{assert.equal(await app.waitForSettledProse(0,token,{quietMs:30,stepMs:5,timeoutMs:100}),false);}finally{clearTimeout(timer);}
 token=app.captureLifecycle();ctx.chat.push({mes:'new floor'});assert.equal(await app.waitForSettledProse(0,token,{quietMs:0}),false);
});
test('unfinished streaming defers settling and bounded timeout fails closed',async()=>{
 const {app,ctx}=setup();ctx.streamingProcessor={isFinished:false};const token=app.captureLifecycle();
 assert.equal(await app.waitForSettledProse(0,token,{quietMs:0,stepMs:2,timeoutMs:10}),false);
 ctx.streamingProcessor.isFinished=true;assert.equal(await app.waitForSettledProse(0,token,{quietMs:0,timeoutMs:30}),true);
});
test('a real next generation still cancels pending observation with explicit reason',async()=>{
 const {app}=setup();const token=app.captureLifecycle();app.abort=token.abort;app.onGenerationStart();assert.equal(token.abort.signal.aborted,true);assert.match(token.abort.signal.reason.message,/新的正文生成/);
});
