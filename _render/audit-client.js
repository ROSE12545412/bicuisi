import { LlmClient, withTimeout } from '../src/llm/client.js';
const calls=[];
const ctx={ConnectionManagerRequestService:{sendRequest:async(...args)=>{calls.push(args.length);if(args.length===4)throw new Error('HTTP 401 invalid API key');return {choices:[{message:{content:'fallback result'}}]};}}};
const result=await new LlmClient(ctx,{mode:'profile',profileId:'x',maxTokens:400,temperature:0,timeoutMs:3000}).complete({system:'s',user:'u',signal:new AbortController().signal});
console.log(JSON.stringify({case:'401 retried as compatibility',calls,result}));
let transportFinished=false;
try{await withTimeout(new Promise(r=>setTimeout(()=>{transportFinished=true;r('done')},35)),5);}catch(e){console.log(e.message)}
await new Promise(r=>setTimeout(r,45));console.log(JSON.stringify({case:'timeout underlying request remains active',transportFinished}));
