import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
import { retrieveVerifiedSources } from '../src/llm/guide.js';
const hooks=[{book:'Canon',uid:1,brief:'INDEX_ONLY'}];
const ctx=()=>({chat:[{mes:'The room is quiet.'}],chatMetadata:{},loadWorldInfo:async()=>({entries:{1:{uid:1,content:'REJECTED_SECRET'}}})});
for(const empty of [true,false]) test(`adversary valid ${empty?'empty locate':'unknown assessment'} permits facts only, default stays closed`,async()=>{
 const old=LlmClient.prototype.complete;let count=0;
 try{LlmClient.prototype.complete=async()=>({ok:true,text:JSON.stringify(++count===1?{picks:empty?[]:[1]}:{sourceAssessment:[{book:'Canon',uid:1,status:'unknown',conditions:[],evidence:[],reason:'not met'}]})});
 const out=await retrieveVerifiedSources(ctx(),defaultSettings(),{hooks,allowNoApplicableSources:true});assert.equal(out.error,'');assert.deepEqual(out.sources,[]);assert.ok(out.note);count=0;
 const strict=await retrieveVerifiedSources(ctx(),defaultSettings(),{hooks});assert.ok(strict.error);
 }finally{LlmClient.prototype.complete=old;}
});
for(const response of [{ok:false,error:'network'}, {ok:true,text:'not json'}, {ok:true,text:'{"picks":[99]}'}]) test(`invalid retrieval remains error ${response.error||response.text}`,async()=>{
 const old=LlmClient.prototype.complete;try{LlmClient.prototype.complete=async()=>response;const out=await retrieveVerifiedSources(ctx(),defaultSettings(),{hooks,allowNoApplicableSources:true});assert.ok(out.error);assert.deepEqual(out.sources,[]);}finally{LlmClient.prototype.complete=old;}
});
test('malformed assessment never becomes factual fallback',async()=>{
 const old=LlmClient.prototype.complete;let count=0;try{LlmClient.prototype.complete=async()=>({ok:true,text:++count===1?'{"picks":[1]}':'{"wrong":[]}'});const out=await retrieveVerifiedSources(ctx(),defaultSettings(),{hooks,allowNoApplicableSources:true});assert.match(out.error,/sourceAssessment/);}finally{LlmClient.prototype.complete=old;}
});
