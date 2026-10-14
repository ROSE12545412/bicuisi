import assert from 'node:assert/strict';
import { defaultSettings } from '../src/config.js';
import { buildConfigSections, createSettingsWindow, redactDiagnostics } from '../src/ui/panel.js';
import { LlmClient } from '../src/llm/client.js';
import { appendGuidanceToMessage, clearAppendedGuidance, observeDisplayedGuidance, repairDisplayedGuidance } from '../src/inject.js';
class N {
 constructor(tag){this.tagName=tag;this.childNodes=[];this.style={};this.dataset={};this.attrs={};this.listeners={};this._text='';this.classList={add(){}};}
 set textContent(v){this._text=String(v);this.childNodes=[];} get textContent(){return this._text+this.childNodes.map(n=>n.textContent).join('');}
 appendChild(n){this.childNodes.push(n);n.parentNode=this;return n;} replaceChildren(...ns){this._text='';for(const n of this.childNodes)n.parentNode=null;this.childNodes=[];ns.forEach(n=>this.appendChild(n));}
 setAttribute(k,v){this.attrs[k]=v;} getAttribute(k){return this.attrs[k];} addEventListener(k,f){this.listeners[k]=f;} querySelector(){return null;} querySelectorAll(){return [];} focus(){} }
const walk=n=>[n,...n.childNodes.flatMap(walk)];
globalThis.document={createElement:t=>new N(t),createTextNode:t=>{const n=new N('#text');n.textContent=t;return n;},querySelector(){return null;},querySelectorAll(){return [];}};
const timeouts=[];globalThis.setTimeout=(f,ms)=>{timeouts.push({f,ms});return timeouts.length;};
const s=defaultSettings();s.llm.mode='custom';s.llm.custom.url='https://one.example/v1';s.llm.custom.model='private-deployment';
let commits=0;const app={settings:s,ctx:{},persistSettings(){commits++;},log(){},channelStatus(){return {ready:true};},state(){return {lastError:'Bearer sk-state-secret'};}};
let renderCount=0;const secs=buildConfigSections(app,()=>renderCount++);const llm=secs.find(x=>x.id==='llm');
const pull=walk({childNodes:llm.body}).find(n=>n.tagName==='button'&&n.textContent==='🔄 拉取模型');
let resolve;LlmClient.fetchModels=()=>new Promise(r=>resolve=r);
pull.listeners.click({preventDefault(){}});s.llm.custom.url='https://two.example/v1';s.llm.custom.model='two-private';resolve({ok:true,models:['one-only']});await Promise.resolve();await Promise.resolve();
assert.equal(s.llm.custom.model,'one-only');console.log('CONFIRMED model pull overwrites custom model; stale endpoint response writes new endpoint settings:',s.llm.custom);
const ctx={chat:[{mes:'RAW',extra:{display_text:'PREEXISTING THIRD PARTY RENDER'}}]};appendGuidanceToMessage(ctx,0,{guidance:'hello'},s);assert.equal(ctx.chat[0].extra.display_text.includes('PREEXISTING'),false);clearAppendedGuidance(ctx,0);assert.equal(ctx.chat[0].extra.display_text,undefined);console.log('CONFIRMED append clobbers preexisting display_text; clear deletes rather than restores it');
const sec2=buildConfigSections(app,()=>renderCount++);const pass=walk({childNodes:sec2.find(x=>x.id==='llm').body}).find(n=>n.attrs?.type==='password');pass.value='s';pass.listeners.input();assert.equal(renderCount,2);console.log('CONFIRMED password first input invokes full render immediately');
const win=createSettingsWindow({app});win.open('llm');const oldPass=walk(win.node).find(n=>n.attrs?.type==='password');oldPass.value='sk-first';oldPass.listeners.input();assert.equal(oldPass.parentNode?.parentNode?.parentNode,null);assert.notEqual(walk(win.node).find(n=>n.attrs?.type==='password'),oldPass);console.log('CONFIRMED actual window replaces key input on each keystroke (loses focus)');
const data={llm:{custom:{url:'https://api.example/v1?api_key=sk-url-secret',key:'sk-good'}},future:{access_token:'sk-access-secret',client_secret:'sk-client-secret'}};const red=redactDiagnostics(data);assert.equal(red.llm.custom.key,'[REDACTED]');assert.ok(JSON.stringify(red).includes('sk-url-secret'));assert.ok(JSON.stringify(red).includes('sk-access-secret'));console.log('CONFIRMED diagnostics redactor misses credentials inside URLs and access_token/client_secret');
const diag=buildConfigSections(app).find(x=>x.id==='diag');let copied;Object.defineProperty(globalThis,'navigator',{value:{clipboard:{writeText(t){copied=t;}},userAgent:'fake'},configurable:true});const copy=walk({childNodes:diag.body}).find(n=>n.tagName==='button'&&n.textContent==='📋 复制诊断信息');copy.listeners.click({preventDefault(){}});await Promise.resolve();assert.ok(copied.includes('sk-state-secret'));console.log('CONFIRMED diagnostic export copies state/error text verbatim without redaction');
console.log('Worldbook-list fetch timers scheduled during all-tab renders:',timeouts.filter(x=>x.ms===0).length);
const editCtx={chat:[{mes:'original body',extra:{}}]};appendGuidanceToMessage(editCtx,0,{guidance:'old guidance'},s);editCtx.chat[0].mes='original';repairDisplayedGuidance(editCtx,0,{domOnly:true});assert.ok(editCtx.chat[0].extra.display_text.startsWith('original body'));console.log('CONFIRMED shortening mes to a prefix does not invalidate old display_text / old guidance');

