import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { saveApiPreset } from '../src/api-presets.js';
import { locateHooks, assessRetrievedSources } from '../src/llm/guide.js';
import { LlmClient } from '../src/llm/client.js';

test('locate and assess respect independent preset budgets on actual transport', async () => {
 const old=globalThis.fetch; const seen=[];
 try {
  globalThis.fetch=async (_url,req)=>{const body=JSON.parse(req.body);seen.push(body.max_tokens);return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify(seen.length===1?{phase:'now',picks:[1],why:'yes'}:{sourceAssessment:[]})},finish_reason:'stop'}]})};};
  const s=defaultSettings();s.llm.mode='custom';s.llm.custom.url='https://example.test/v1';s.llm.custom.model='model';s.llm.maxTokens=16384;s.llm.structuredMaxTokens=8192;
  const a=saveApiPreset(s,'locate').preset.id;s.apiRoutes.locate=a;
  s.llm.maxTokens=4096;s.llm.structuredMaxTokens=24576;const b=saveApiPreset(s,'assess').preset.id;s.apiRoutes.assess=b;
  const ctx={chat:[],chatMetadata:{}};
  assert.equal((await locateHooks(ctx,s,{hooks:[{book:'Book',uid:1,brief:'index'}]})).ok,true);
  await assessRetrievedSources(ctx,s,[{book:'Book',uid:1,content:'original'}]);
  assert.deepEqual(seen,[16384,24576]);
 } finally {globalThis.fetch=old;}
});
test('nonempty truncated response fails with stage and actual budget without retry or reasoning leakage',async()=>{
 const old=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{"picks":[1]',reasoning_content:'PRIVATE_REASONING'},finish_reason:'length'}]})};};
  const s=defaultSettings();s.llm.mode='custom';s.llm.custom.url='https://example.test/v1';s.llm.custom.model='model';s.llm.maxTokens=16384;
  const out=await new LlmClient({},s.llm,'剧情定位').complete({user:'test'});
  assert.equal(out.ok,false);assert.match(out.error,/剧情定位.*16384.*length/);assert.ok(!out.error.includes('PRIVATE_REASONING'));assert.equal(calls,1);
 }finally{globalThis.fetch=old;}
});
