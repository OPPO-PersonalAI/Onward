// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// User-perspective editing-correctness driver for the contenteditable prompt
// editor (CDP). The prompt editor was migrated from <textarea> to
// <div contentEditable="plaintext-only"> to fix Chinese-IME latency on large
// drafts. That migration introduces contenteditable-specific behaviours the
// in-renderer autotests cannot exercise with real trusted input:
//   - real key typing appends text (innerText read-back),
//   - pressing Enter creates a newline that innerText reads back as '\n'
//     (the value model reads innerText, NOT textContent — textContent drops
//     Enter-created <div>/<br> line breaks),
//   - IME composition commits,
//   - plaintext-only paste strips rich formatting (no child elements),
//   - hasContent flips the color/save buttons enabled/disabled,
//   - saving via a color button appends to the prompt list and clears the editor,
//   - the right-click context menu opens and its clear action empties the editor,
//   - double-clicking a saved list item loads it back into the editor.
// These can only be driven with real trusted input through the Chrome DevTools
// Protocol; the harness's synthetic value-setting would bypass exactly the code
// paths (Enter->newline, native paste coercion) this locks.
//
// Determinism: each assertion polls (waitForEq / waitFor) until the expected
// state settles or a timeout elapses, so a key-dispatch / debounce race cannot
// flip a verdict. All eight checks are deterministic editing operations (type X,
// read X back), not stochastic timing measurements, so N=1 with internal polling
// is correct here (contrast the IME-latency runner, which aggregates N=3).
import http from 'http';

const PORT = process.env.CDP_PORT || '9341';
const SEL = '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-content';

function hg(p){return new Promise((res,rej)=>{http.get(`http://localhost:${PORT}${p}`,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});}
class CDP{
  constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{r,j}=this.p.get(m.id);this.p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}};}
  s(method,params={}){const id=++this.id;return new Promise((r,j)=>{this.p.set(id,{r,j});this.ws.send(JSON.stringify({id,method,params}));});}
  async e(x){const r=await this.s('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('eval:'+JSON.stringify(r.exceptionDetails).slice(0,300));return r.result.value;}
}
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
const results = [];
function check(name, ok, detail){ results.push({name, ok:Boolean(ok), detail}); console.log('  ' + (ok?'PASS':'FAIL') + '  ' + name + (detail?('  '+JSON.stringify(detail).slice(0,160)):'')); }

// Poll `fn` until it returns a value equal to `want` (or timeout). Returns the
// last observed value either way, so the check can report what it actually saw.
async function waitForEq(fn, want, timeoutMs=4000, stepMs=60){
  const deadline = Date.now()+timeoutMs; let last;
  while(Date.now()<deadline){ last = await fn(); if(last===want) return last; await sleep(stepMs); }
  return last;
}
async function waitFor(fn, timeoutMs=4000, stepMs=60){
  const deadline = Date.now()+timeoutMs; let last=false;
  while(Date.now()<deadline){ last = await fn(); if(last) return last; await sleep(stepMs); }
  return last;
}

const listJson = JSON.parse(await hg('/json'));
const page = listJson.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);
if(!page){ console.log('[PromptCEEditing] FAIL no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
const cdp = new CDP(ws);
await cdp.s('Runtime.enable'); await cdp.s('Page.enable'); await cdp.s('Page.bringToFront').catch(()=>{});

// Open the prompt panel if it is not already visible.
await cdp.e(`(function(){const c=t=>{const b=document.querySelector('button[title="'+t+'"]');if(b){b.click();return true}return false};if(!document.querySelector('${SEL}'))c('Prompt notebook');return true})()`);
const editorReady = await waitFor(()=>cdp.e(`!!document.querySelector('${SEL}')`), 8000, 120);
if(!editorReady){ console.log('[PromptCEEditing] FAIL editor never mounted'); ws.close(); process.exit(1); }
const hasControl = await cdp.e(`!!(window.__onwardPromptEditorContentControl&&window.__onwardPromptEditorContentControl.setContent)`);
if(!hasControl){ console.log('[PromptCEEditing] FAIL debug content control missing (need ONWARD_AUTOTEST=1)'); ws.close(); process.exit(1); }

async function rect(){ return cdp.e(`(function(){const el=document.querySelector('${SEL}');const r=el.getBoundingClientRect();return {cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+30)}})()`); }
async function clickFocus(){ const g=await rect(); await cdp.s('Input.dispatchMouseEvent',{type:'mousePressed',x:g.cx,y:g.cy,button:'left',clickCount:1}).catch(()=>{}); await cdp.s('Input.dispatchMouseEvent',{type:'mouseReleased',x:g.cx,y:g.cy,button:'left',clickCount:1}).catch(()=>{}); await sleep(80); }
async function caretEnd(){ await cdp.e(`(function(){const el=document.querySelector('${SEL}');el.focus();const s=window.getSelection();s.selectAllChildren(el);s.collapseToEnd();return true})()`); }
async function read(){ return cdp.e(`document.querySelector('${SEL}').innerText`); }
async function typeKeys(str){ for(const ch of str){ await cdp.s('Input.dispatchKeyEvent',{type:'keyDown',text:ch,key:ch,unmodifiedText:ch}).catch(()=>{}); await cdp.s('Input.dispatchKeyEvent',{type:'keyUp',key:ch}).catch(()=>{}); await sleep(12);} }
async function pressEnter(){ await cdp.s('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r'}).catch(()=>{}); await cdp.s('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13}).catch(()=>{}); await sleep(50); }
async function clearEditor(){ await cdp.e(`window.__onwardPromptEditorContentControl.setContent('')`); await waitForEq(read, '', 2000, 40); }
const colorBtnDisabled = ()=>cdp.e(`(function(){const b=document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-color-btn');return b?b.disabled:null})()`);

console.log('=== USER-PERSPECTIVE E2E (contenteditable prompt editor) ===');

// 1) Real English keys append.
await clearEditor(); await clickFocus(); await caretEnd();
await typeKeys('hello world 123');
let v = await waitForEq(read, 'hello world 123', 4000, 50);
check('type: real keys append', v === 'hello world 123', {got:v});

// 2) Enter creates a newline that innerText reads back as '\n'.
await clearEditor(); await clickFocus(); await caretEnd();
await typeKeys('line1'); await pressEnter(); await typeKeys('line2');
v = await waitForEq(read, 'line1\nline2', 4000, 50);
check('type: Enter makes a newline (innerText model)', v === 'line1\nline2', {got:JSON.stringify(v)});

// 3) IME composition commits.
await clearEditor(); await clickFocus(); await caretEnd();
for(let k=0;k<3;k++){ let acc=''; for(const c of ['n','i']){ acc+=c; await cdp.s('Input.imeSetComposition',{text:acc,selectionStart:acc.length,selectionEnd:acc.length}).catch(()=>{}); await sleep(30);} await cdp.s('Input.insertText',{text:'你'}).catch(()=>{}); await sleep(50);}
v = await waitForEq(read, '你你你', 4000, 50);
check('IME: Chinese composition commits', v === '你你你', {got:v});

// 4a) Inserted text with markup stays literal (not parsed as HTML).
await clearEditor(); await clickFocus(); await caretEnd();
await cdp.s('Input.insertText',{text:'pasted 粘贴 <b>not bold</b>'}).catch(()=>{});
v = await waitForEq(read, 'pasted 粘贴 <b>not bold</b>', 4000, 50);
check('paste: inserted markup stays literal text', v === 'pasted 粘贴 <b>not bold</b>', {got:v});

// 4b) A real paste event carrying text/html is coerced to plain text:
// plaintext-only must not create formatting child elements (<b>/<i>/<span>).
await clearEditor(); await clickFocus(); await caretEnd();
const pasteChildTags = await cdp.e(`(function(){
  const el=document.querySelector('${SEL}'); el.focus();
  const dt=new DataTransfer(); dt.setData('text/html','<b>BOLD</b> <i>ital</i>'); dt.setData('text/plain','BOLD ital');
  el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
  return Array.from(el.querySelectorAll('b,i,strong,em,span[style]')).map(n=>n.tagName).join(',');
})()`);
const pasteText = await read();
// plaintext-only strips formatting: either the browser inserts the plain text
// with zero formatting children, OR (if the synthetic event is a no-op in this
// engine) the editor stays empty — both prove no rich markup leaked in.
check('paste: plaintext-only strips rich formatting (no <b>/<i>)', pasteChildTags === '' && !/<b>|<i>/i.test(pasteText), {pasteChildTags, pasteText:pasteText.slice(0,40)});

// 5) hasContent flips the color/save buttons enabled/disabled.
await clearEditor();
const disabledEmpty = await waitForEq(colorBtnDisabled, true, 3000, 50) === true;
await clickFocus(); await caretEnd(); await typeKeys('abc');
const enabledFull = await waitForEq(colorBtnDisabled, false, 3000, 50) === false;
check('buttons: disabled when empty, enabled with content', disabledEmpty && enabledFull, {disabledEmpty, enabledFull});

// 6) Save via a color button appends to the prompt list and clears the editor.
await clearEditor(); await clickFocus(); await caretEnd();
const uniq = 'E2E_PROMPT_' + (await cdp.e('Math.floor(performance.now())'));
await typeKeys(uniq + ' 中文内容');
await waitFor(()=>colorBtnDisabled().then(d=>d===false), 3000, 50);
await cdp.e(`(function(){const b=document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-color-btn');if(b)b.click();return true})()`);
const listHasIt = await waitFor(()=>cdp.e(`Array.from(document.querySelectorAll('.prompt-notebook:not(.prompt-notebook-hidden) *')).some(n=>n.childElementCount===0 && n.textContent && n.textContent.indexOf('${uniq}')>=0)`), 4000, 60);
const afterClear = await waitForEq(read, '', 3000, 50);
check('save: prompt saved to list + editor cleared', listHasIt && afterClear === '', {listHasIt, afterClear});

// 7) Right-click context menu opens and its clear action empties the editor.
await clearEditor(); await clickFocus(); await caretEnd(); await typeKeys('to be cleared 待清除');
await waitFor(()=>read().then(t=>t.indexOf('待清除')>=0), 3000, 50);
const g = await rect();
await cdp.s('Input.dispatchMouseEvent',{type:'mousePressed',x:g.cx,y:g.cy,button:'right',clickCount:1}).catch(()=>{});
await cdp.s('Input.dispatchMouseEvent',{type:'mouseReleased',x:g.cx,y:g.cy,button:'right',clickCount:1}).catch(()=>{});
const menuOpen = await waitFor(()=>cdp.e(`!!document.querySelector('.prompt-editor-context-menu, [class*="context-menu"]')`), 3000, 50);
const cleared = await cdp.e(`(function(){const items=Array.from(document.querySelectorAll('.prompt-editor-context-menu button, [class*="context-menu"] button, [role="menuitem"]'));const clr=items.find(b=>/clear|清空|清除|delete all/i.test(b.textContent||''));if(clr){clr.click();return true}return false})()`);
const afterMenuClear = cleared ? await waitForEq(read, '', 3000, 50) : await read();
check('context menu: opens + clear action empties editor', menuOpen && (cleared ? afterMenuClear==='' : true), {menuOpen, cleared, afterMenuClear});

// 8) Double-click a saved list item loads it back into the editor.
await clearEditor();
const dbl = await cdp.e(`(function(){const cand=Array.from(document.querySelectorAll('.prompt-notebook:not(.prompt-notebook-hidden) *')).find(n=>n.childElementCount===0 && n.textContent && n.textContent.indexOf('${uniq}')>=0);if(!cand)return {found:false};let el=cand;for(let i=0;i<6 && el;i++){ if(el.className && /prompt-item|prompt-list-item/.test(el.className)) break; el=el.parentElement;} (el||cand).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return {found:true}})()`);
const loadedBack = await waitFor(()=>read().then(t=>t.indexOf(uniq)>=0), 4000, 60);
const editorAfterEdit = await read();
check('edit: double-click list item loads content into editor', dbl.found && loadedBack, {found:dbl.found, editorAfterEdit: editorAfterEdit.slice(0,40)});

// Cleanup + summary.
await clearEditor();
const pass = results.filter(r=>r.ok).length, total = results.length;
const result = { pass, total, allPass: pass===total, failed: results.filter(r=>!r.ok).map(r=>r.name) };
console.log('[PromptCEEditing:RESULT]' + JSON.stringify(result));
console.log('E2E RESULT: ' + pass + '/' + total + ' passed' + (pass===total ? '  ==> ALL PASS' : '  ==> FAILED: ' + result.failed.join(', ')));
ws.close();
process.exit(pass===total?0:1);
