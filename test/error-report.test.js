import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { buildErrorReport, responseShape } from '../src/error-report.js';
import { LlmClient } from '../src/llm/client.js';
test('response summary keeps finish/usage/reasoning lengths, never raw content or refusal',()=>{
 const shape=responseShape({choices:[{message:{content:null,reasoning_content:'PRIVATE_STORY',refusal:'PRIVATE_KEY'},finish_reason:'length'}],usage:{completion_tokens:3000},error:{message:'PRIVATE_KEY'}});
 assert.equal(shape.reasoningChars,13);assert.equal(shape.finishReason,'length');assert.equal(shape.contentType,'null');assert.equal(shape.usage.completion,3000);assert.ok(!JSON.stringify(shape).includes('PRIVATE_'));
});
test('custom empty response reports HTTP and shape without credentials/story/endpoint',async()=>{
 const old=globalThis.fetch;
 try{globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:null,reasoning_content:'SECRET_BODY'},finish_reason:'length'}],usage:{completion_tokens:3000}})});
 const out=await new LlmClient({}, {mode:'custom',custom:{url:'https://private.example/v1?api_key=SECRET_KEY',key:'SECRET_KEY',model:'PRIVATE_MODEL'}},'共享事实观察').complete({system:'SECRET_PROMPT',user:'SECRET_STORY'});
 assert.equal(out.ok,false);
 const report=buildErrorReport({settings:{enabled:true,realm:'void'},lastError:out.error,lastAdversaryStage:{targetIndex:10}});
 const r=report.recentRequests.at(-1);assert.equal(r.label,'共享事实观察');assert.equal(r.status,'failed');assert.equal(r.response.httpStatus,200);assert.equal(r.response.shape.finishReason,'length');assert.equal(report.targetIndex,10);
 assert.ok(!/SECRET|private\.example|PRIVATE_MODEL/.test(JSON.stringify(report)));
 }finally{globalThis.fetch=old;}
});
test('HTTP failure records status without leaking arbitrary upstream error text',async()=>{
 const old=globalThis.fetch;try{globalThis.fetch=async()=>({ok:false,status:429,text:async()=> 'secret user body api_key=SECRET_KEY'});
 await new LlmClient({}, {mode:'custom',custom:{url:'https://a/v1',model:'model'}}).complete({user:'private'});
 const report=buildErrorReport({settings:{}});assert.equal(report.recentRequests.at(-1).response.httpStatus,429);assert.ok(!JSON.stringify(report).includes('secret user body'));
 }finally{globalThis.fetch=old;}
});
