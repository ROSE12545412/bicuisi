import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { defaultSettings, normalizeSettings } from '../src/config.js';
import { saveApiPreset, loadApiPreset, deleteApiPreset, resolveStageLlm } from '../src/api-presets.js';
import { observeFacts } from '../src/facts.js';
import { observeAdversary } from '../src/adversary.js';
import { LlmClient } from '../src/llm/client.js';
import { GuideController } from '../src/app.js';
import { locateHooks, assessRetrievedSources } from '../src/llm/guide.js';
test('API presets store independent whitelisted snapshots, explicit update/load/delete and stage reset',()=>{
 const s=defaultSettings();s.llm.mode='custom';s.llm.custom.key='KEY';s.llm.custom.model='a';s.llm.extra='discard';const saved=saveApiPreset(s,'one');assert.equal(saved.ok,true);const id=saved.preset.id;
 s.llm.custom.model='b';assert.equal(resolveStageLlm(s,'facts').custom.model,'b');s.apiRoutes.facts=id;assert.equal(resolveStageLlm(s,'facts').custom.model,'a');assert.equal(resolveStageLlm(s,'facts').extra,undefined);
 const config=resolveStageLlm(s,'facts');config.custom.key='changed';assert.equal(s.apiPresets[0].llm.custom.key,'KEY');
 assert.equal(saveApiPreset(s,'one').ok,false);assert.equal(loadApiPreset(s,id).ok,true);assert.equal(s.llm.custom.model,'a');assert.equal(deleteApiPreset(s,id).ok,true);assert.equal(s.apiRoutes.facts,'');
});
test('malformed presets normalized, missing route fails explicitly, settings survive JSON reload',()=>{
 const s=defaultSettings();saveApiPreset(s,'a');s.apiRoutes.assess=s.apiPresets[0].id;const copy=JSON.parse(JSON.stringify(s));normalizeSettings(copy);assert.equal(copy.apiPresets.length,1);assert.equal(resolveStageLlm(copy,'assess').mode,s.llm.mode);
 copy.apiRoutes.facts='missing';assert.throws(()=>resolveStageLlm(copy,'facts'),/不存在/);copy.apiPresets.push(null,{id:'bad',name:'x',llm:[]});normalizeSettings(copy);assert.equal(copy.apiPresets.length,1);
});
test('facts and adversary compose actually use separate assigned preset configs',async()=>{
 const old=LlmClient.prototype.complete;const seen=[];
 try{LlmClient.prototype.complete=async function(){seen.push(this.config.custom.model);return {ok:true,text:JSON.stringify(this.label==='共享事实观察'?{proposals:[]}:{guidance:'好。',commentary:'嗯。',emotion:'calm',proposals:[]})};};
 const s=defaultSettings();s.realm='void';s.adversary.enabled=true;s.llm.custom.model='facts-model';const a=saveApiPreset(s,'fact').preset;s.llm.custom.model='compose-model';const b=saveApiPreset(s,'compose').preset;s.apiRoutes.facts=a.id;s.apiRoutes.compose=b.id;
 const ctx={chatId:'a',name2:'a',chatMetadata:{},chat:[{mes:'正文。'}]};assert.equal((await observeFacts(ctx,s)).ok,true);assert.equal((await observeAdversary(ctx,s)).ok,true);assert.deepEqual(seen,['facts-model','compose-model']);
 }finally{LlmClient.prototype.complete=old;}
});
test('locate and original assessment each dispatch their own selected preset',async()=>{
 const old=LlmClient.prototype.complete;const seen=[];
 try{LlmClient.prototype.complete=async function(){seen.push(this.config.custom.model);return {ok:true,text:JSON.stringify(this.label==='剧情定位'?{phase:'now',picks:[1],why:'relevant'}:{sourceAssessment:[]})};};
 const s=defaultSettings();s.llm.custom.model='locate-model';const locateId=saveApiPreset(s,'locate').preset.id;s.apiRoutes.locate=locateId;s.llm.custom.model='assess-model';const assessId=saveApiPreset(s,'assess').preset.id;s.apiRoutes.assess=assessId;
 const ctx={chat:[],chatMetadata:{}};await locateHooks(ctx,s,{hooks:[{book:'Book',uid:1,label:'x',brief:'x'}]});await assessRetrievedSources(ctx,s,[{book:'Book',uid:1,content:'original'}]);assert.deepEqual(seen,['locate-model','assess-model']);
 }finally{LlmClient.prototype.complete=old;}
});
test('inflight lifecycle rejects API route or preset config changes',()=>{
 const s=defaultSettings();const app=new GuideController({chatId:'a',chat:[],chatMetadata:{}},s);const token=app.captureLifecycle();s.apiRoutes.locate='missing';assert.equal(app.lifecycleValid(token),false);
});
