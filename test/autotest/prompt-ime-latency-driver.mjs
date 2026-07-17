// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// Prompt IME-composition latency driver (CDP). Real Chinese IME composition can
// only be driven through the Chrome DevTools Protocol (Input.imeSetComposition);
// the in-renderer autotest harness cannot simulate it. This driver connects to
// the dev app's remote-debugging port, pre-loads a large mixed CJK/ASCII draft
// into the prompt editor, drives pinyin composition, and measures input->paint
// latency. It exists to lock the contenteditable fix: a textarea's IME
// composition is O(text-before-caret) (~47-263ms at 78KB); the contenteditable
// editor is ~16ms and independent of caret position.
//
// Timing-sensitive rule: N=3 trials, PASS if >= 1 of 3 meets the budget (a
// transient GC/scheduling spike must not fail the gate; only a systematic
// regression — all 3 over budget — fails). Budget is data-derived: 40ms is well
// below the textarea's 47ms floor (so a regression to textarea fails) and well
// above the contenteditable's ~16ms (so the fix passes with margin).
import http from 'http';
import {
  evaluatePromptImeLatencyTrials,
  nearestRankPercentile
} from './prompt-ime-latency-metrics.mjs';

const PORT = process.env.CDP_PORT || '9333';
const DRAFT_CHARS = 78000;
const BUDGET_MS = 40;          // IME input->paint p95 budget at 78KB
const TRIALS = 3;
const KEYS_PER_TRIAL = 20;
const INPUTS_PER_KEY = 3;
const EXPECTED_SAMPLES_PER_TRIAL = KEYS_PER_TRIAL * INPUTS_PER_KEY;

function hg(p){return new Promise((res,rej)=>{http.get(`http://localhost:${PORT}${p}`,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});}
class CDP{
  constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{r,j}=this.p.get(m.id);this.p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}};}
  s(method,params={}){const id=++this.id;return new Promise((r,j)=>{this.p.set(id,{r,j});this.ws.send(JSON.stringify({id,method,params}));});}
  async e(x){const r=await this.s('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('eval:'+JSON.stringify(r.exceptionDetails).slice(0,300));return r.result.value;}
}
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
const p95 = a=>{const value=nearestRankPercentile(a,0.95);return value===null?null:+value.toFixed(1)};

const SEL = '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-content';
const list = JSON.parse(await hg('/json'));
const page = list.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);
if(!page){ console.log('[PromptIMELatency] FAIL no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
const cdp = new CDP(ws);
await cdp.s('Runtime.enable'); await cdp.s('Page.enable'); await cdp.s('Page.bringToFront').catch(()=>{});
await cdp.e(`(function(){const c=t=>{const b=document.querySelector('button[title="'+t+'"]');if(b){b.click();return true}return false};if(!document.querySelector('${SEL}'))c('Prompt notebook');return true})()`);
await sleep(1500);

async function rectAndPreload(){
  return cdp.e(`(function(){
    const el=document.querySelector('${SEL}'); if(!el) return {ok:false};
    if(!(window.__onwardPromptEditorContentControl&&window.__onwardPromptEditorContentControl.setContent)) return {ok:false, noControl:true};
    const chunk='    <li><a href="#s3">3 · content 中文 <span class="en">y</span></a></li>'+String.fromCharCode(10);
    let s=''; while(s.length<${DRAFT_CHARS}) s+=chunk; s=s.slice(0,${DRAFT_CHARS});
    window.__onwardPromptEditorContentControl.setContent(s);
    window.__imeS=[]; if(window.__imeL) el.removeEventListener('input',window.__imeL);
    window.__imeL=function(){const t0=performance.now();requestAnimationFrame(function(){setTimeout(function(){window.__imeS.push(performance.now()-t0)},0)})};
    el.addEventListener('input',window.__imeL);
    const r=el.getBoundingClientRect();
    return {ok:true, len:el.innerText.length, cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+30)};
  })()`);
}
const g = await rectAndPreload();
if(!g.ok){ console.log('[PromptIMELatency] FAIL editor/control unavailable ' + JSON.stringify(g)); ws.close(); process.exit(1); }
if(g.len < DRAFT_CHARS - 100){ console.log('[PromptIMELatency] FAIL preload len=' + g.len); ws.close(); process.exit(1); }
await sleep(400);
// establish real widget focus + caret at end (worst case for the old textarea)
await cdp.s('Input.dispatchMouseEvent',{type:'mousePressed',x:g.cx,y:g.cy,button:'left',clickCount:1}).catch(()=>{});
await cdp.s('Input.dispatchMouseEvent',{type:'mouseReleased',x:g.cx,y:g.cy,button:'left',clickCount:1}).catch(()=>{});
await sleep(100);

const trials = [];
for(let t=0;t<TRIALS;t++){
  await cdp.e(`(function(){const el=document.querySelector('${SEL}');el.focus();const s=window.getSelection();s.selectAllChildren(el);s.collapseToEnd();window.__imeS=[];return true})()`);
  for(let k=0;k<KEYS_PER_TRIAL;k++){
    let acc='';
    for(const ch of ['n','i']){ acc+=ch; await cdp.s('Input.imeSetComposition',{text:acc,selectionStart:acc.length,selectionEnd:acc.length}).catch(()=>{}); await sleep(45); }
    await cdp.s('Input.insertText',{text:'你'}).catch(()=>{}); await sleep(70);
  }
  await sleep(250);
  const arr = await cdp.e('window.__imeS');
  const val = p95(arr);
  trials.push({ p95: val, n: arr.length });
}
const verdict = evaluatePromptImeLatencyTrials(trials, {
  budgetMs: BUDGET_MS,
  expectedTrials: TRIALS,
  expectedSamplesPerTrial: EXPECTED_SAMPLES_PER_TRIAL
});
const result = {
  testId: 'PIL-01',
  draftChars: DRAFT_CHARS,
  budgetMs: BUDGET_MS,
  expectedSamplesPerTrial: EXPECTED_SAMPLES_PER_TRIAL,
  trials,
  ...verdict
};
console.log('[PromptIMELatency:RESULT]' + JSON.stringify(result));
console.log('[PromptIMELatency:PIL-01] ' + (verdict.pass ? 'PASS' : 'FAIL') + ' best IME p95=' + (verdict.bestP95Ms ?? 'unavailable') + 'ms (budget ' + BUDGET_MS + 'ms), ' + verdict.trialsMeetingBudget + '/' + TRIALS + ' trials met, samplesValid=' + verdict.sampleCountsValid);
ws.close();
process.exit(verdict.pass ? 0 : 1);
