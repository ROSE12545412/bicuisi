import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { LlmClient } from '../src/llm/client.js';
import { defaultSettings, normalizeSettings } from '../src/config.js';
import { buildErrorReport } from '../src/error-report.js';
test('structured output budget defaults and bounds; zero opt-out retained',()=>{
 assert.equal(defaultSettings().llm.structuredMaxTokens,8192);
 const s=defaultSettings();s.llm.structuredMaxTokens=0;normalizeSettings(s);assert.equal(s.llm.structuredMaxTokens,0);
 s.llm.structuredMaxTokens=999999;normalizeSettings(s);assert.equal(s.llm.structuredMaxTokens,32768);
});
test('schema requests use configured reasoning allowance once; normal request keeps own budget',async()=>{
 const old=globalThis.fetch;const bodies=[];try{globalThis.fetch=async(u,o)=>{bodies.push(JSON.parse(o.body));return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{}'}}]})};};
 const config={mode:'custom',structuredMaxTokens:16384,custom:{url:'https://a/v1',model:'a'}};
 const client=new LlmClient({},config);await client.complete({user:'test',maxTokens:3000,jsonSchema:{name:'test',value:{type:'object'}}});
 await client.complete({user:'test',maxTokens:3000});config.structuredMaxTokens=0;await client.complete({user:'test',maxTokens:3000,jsonSchema:{name:'test',value:{type:'object'}}});
 assert.deepEqual(bodies.map(b=>b.max_tokens),[16384,3000,3000]);
 }finally{globalThis.fetch=old;}
});
test('reasoning-only truncated response gives actionable error and never returns reasoning/retries',async()=>{
 const old=globalThis.fetch;let calls=0;try{globalThis.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({choices:[{message:{content:'',reasoning_content:'PRIVATE_THOUGHT'},finish_reason:'length'}],usage:{completion_tokens_details:{reasoning_tokens:8192}}})};};
 const out=await new LlmClient({}, {mode:'custom',structuredMaxTokens:8192,custom:{url:'https://a/v1',model:'a'}}).complete({user:'test',maxTokens:3000,jsonSchema:{name:'test',value:{type:'object'}}});
 assert.equal(out.ok,false);assert.match(out.error,/推理耗尽输出预算（8192/);assert.equal(calls,1);assert.equal(out.text,'');assert.equal(buildErrorReport({settings:{}}).recentRequests.at(-1).failureCode,'reasoning_budget_exhausted');
 }finally{globalThis.fetch=old;}
});
