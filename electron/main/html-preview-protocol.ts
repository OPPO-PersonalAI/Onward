/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { protocol } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import {
  buildHtmlPreviewUrl,
  classifyHtmlPreviewLink,
  HTML_PREVIEW_SCHEME,
  isInPageAnchorHref,
  resolveHtmlPreviewRequest,
  type HtmlPreviewLinkClassification
} from './html-preview-path'

interface HtmlPreviewSession {
  id: string
  rootPath: string
  entryFilePath: string
  autotest: boolean
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
}

protocol.registerSchemesAsPrivileged([{
  scheme: HTML_PREVIEW_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
}])

function buildBridgeScript(session: HtmlPreviewSession): string {
  const config = JSON.stringify({
    marker: 'onward-html-preview',
    version: 1,
    sessionId: session.id,
    autotest: session.autotest
  })
  return `<script>(()=>{const C=${config};const isAnchor=(${isInPageAnchorHref.toString()});let find={query:'',matches:0,ordinal:0};const send=(type,payload,extra={})=>parent.postMessage({marker:C.marker,version:C.version,sessionId:C.sessionId,type,payload,...extra},'*');const scroll=()=>{const d=document.documentElement,b=document.body;return{x:window.scrollX||d.scrollLeft||(b?b.scrollLeft:0)||0,y:window.scrollY||d.scrollTop||(b?b.scrollTop:0)||0,scrollWidth:Math.max(d.scrollWidth||0,b?b.scrollWidth||0:0),scrollHeight:Math.max(d.scrollHeight||0,b?b.scrollHeight||0:0),clientWidth:d.clientWidth||window.innerWidth||0,clientHeight:d.clientHeight||window.innerHeight||0}};const state=()=>send('state',{url:location.href,title:document.title,readyState:document.readyState,scroll:scroll()});const inspect=()=>{const images=Array.from(document.images||[]);return{title:document.title,readyState:document.readyState,bodyText:(document.body&&document.body.innerText?document.body.innerText:'').slice(0,20000),bodyDatasetMarker:document.body?document.body.dataset.onwardHtmlPreviewFixture||null:null,externalReady:Boolean(window.__ONWARD_HTML_EXTERNAL_READY),localReady:Boolean(window.__ONWARD_HTML_LOCAL_READY),saveMarker:document.querySelector('[data-save-marker]')?document.querySelector('[data-save-marker]').textContent:null,imageCount:images.length,loadedImageCount:images.filter(i=>i.complete&&i.naturalWidth>0).length,brokenImageCount:images.filter(i=>i.complete&&i.naturalWidth===0).length,scrollX:scroll().x,scrollY:scroll().y,scrollHeight:scroll().scrollHeight,scrollWidth:scroll().scrollWidth,clientHeight:scroll().clientHeight,clientWidth:scroll().clientWidth}};addEventListener('message',async e=>{const m=e.data;if(e.source!==parent||!m||m.marker!==C.marker||m.version!==C.version||m.sessionId!==C.sessionId||m.type!=='command')return;let value=true;let reload=false;try{const p=m.payload||{};switch(m.command){case'inspect':value=inspect();break;case'evaluate':if(!C.autotest)throw new Error('Evaluation is only available during autotest');value=await(0,eval)(String(p.script||''));break;case'get-scroll':value=scroll();break;case'restore-scroll':{const rx=Number(p.x)||0,ry=Number(p.y)||0;const apply=()=>window.scrollTo(rx,ry);apply();requestAnimationFrame(apply);if(document.readyState!=='complete')addEventListener('load',()=>{apply();requestAnimationFrame(apply)},{once:true});value=scroll();break}case'reload':reload=true;break;case'back':history.back();break;case'forward':history.forward();break;case'zoom':document.documentElement.style.zoom=String(Number(p.zoomFactor)||1);value=Number(p.zoomFactor)||1;break;case'find':{const q=String(p.text||'');const hay=document.body&&document.body.innerText?document.body.innerText:'';const source=p.matchCase?hay:hay.toLocaleLowerCase();const needle=p.matchCase?q:q.toLocaleLowerCase();let count=0,index=0;while(needle&&index<=source.length){const next=source.indexOf(needle,index);if(next<0)break;count++;index=next+Math.max(1,needle.length);if(count>=10000)break}if(find.query!==q||!p.findNext)find={query:q,matches:count,ordinal:count?1:0};else if(count){find.ordinal+=p.forward===false?-1:1;if(find.ordinal>count)find.ordinal=1;if(find.ordinal<1)find.ordinal=count}window.find(q,Boolean(p.matchCase),p.forward===false,true,false,true,false);value={requestId:Date.now(),activeMatchOrdinal:find.ordinal,matches:count,finalUpdate:true};send('found-in-page',value);break}case'stop-find':getSelection()?.removeAllRanges();find={query:'',matches:0,ordinal:0};break;default:throw new Error('Unknown HTML Preview command')}}catch(error){send('response',null,{requestId:m.requestId,success:false,error:String(error)});return}send('response',null,{requestId:m.requestId,success:true,value});if(reload)setTimeout(()=>location.reload(),0)});window.open=(u)=>{try{if(u)send('navigate-request',{url:new URL(String(u),location.href).href})}catch(_){}return null};addEventListener('click',e=>{const a=e.target instanceof Element?e.target.closest('a[href]'):null;if(!a)return;const raw=a.getAttribute('href');if(isAnchor(raw)){e.preventDefault();const id=decodeURIComponent(raw.slice(1));const el=id?document.getElementById(id)||document.getElementsByName(id)[0]||null:null;try{history.replaceState(null,'',raw)}catch(_){}if(el)el.scrollIntoView({block:'start',behavior:'auto'});else if(!id)window.scrollTo(0,0);send('anchor-scroll',{hash:raw.slice(0,64),found:id?Boolean(el):true});state();return}const href=a.href;if(!href)return;e.preventDefault();send('navigate-request',{url:href})},true);addEventListener('keydown',e=>{const key=e.key.toLowerCase(),mod=e.metaKey||e.ctrlKey;if(key==='escape'&&!e.altKey){send('escape');return}if(!mod||e.altKey)return;if(key==='f'){e.preventDefault();send('find-shortcut');return}if(key==='r'&&!e.shiftKey){e.preventDefault();send('reload-shortcut');return}if(['+','=','-','_','0'].includes(key)){e.preventDefault();send('zoom-shortcut',{direction:key==='0'?'reset':(key==='-'||key==='_')?'out':'in'})}},true);addEventListener('popstate',state);addEventListener('hashchange',state);if(document.readyState==='loading')addEventListener('DOMContentLoaded',state,{once:true});else state();addEventListener('load',state,{once:true})})();</script>`
}

function injectBridge(html: string, bridge: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head && head.index !== undefined) {
    const insertAt = head.index + head[0].length
    return `${html.slice(0, insertAt)}${bridge}${html.slice(insertAt)}`
  }
  return `${bridge}${html}`
}

class HtmlPreviewProtocolManager {
  private sessions = new Map<string, HtmlPreviewSession>()
  private registered = false

  register(): void {
    if (this.registered) return
    this.registered = true
    protocol.handle(HTML_PREVIEW_SCHEME, (request) => this.handleRequest(request))
  }

  createSession(rootPath: string, filePath: string, reloadKey: number): { success: boolean; sessionId?: string; url?: string; error?: string } {
    const resolvedRoot = resolve(rootPath)
    const resolvedFile = resolve(resolvedRoot, filePath)
    const id = randomUUID().replace(/-/g, '')
    const validation = resolveHtmlPreviewRequest(buildHtmlPreviewUrl(id, resolvedFile, reloadKey), {
      sessionId: id,
      rootPath: resolvedRoot
    })
    if (!validation.success) {
      return { success: false, error: 'HTML Preview entry is outside the project root' }
    }
    const session: HtmlPreviewSession = {
      id,
      rootPath: resolvedRoot,
      entryFilePath: resolvedFile,
      autotest: process.env.ONWARD_AUTOTEST === '1'
    }
    this.sessions.set(id, session)
    return {
      success: true,
      sessionId: id,
      url: buildHtmlPreviewUrl(id, resolvedFile, reloadKey)
    }
  }

  releaseSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  validateNavigation(sessionId: string, url: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (/^https?:/i.test(url)) return true
    return resolveHtmlPreviewRequest(url, { sessionId, rootPath: session.rootPath }).success
  }

  classifyNavigation(sessionId: string, url: string): HtmlPreviewLinkClassification {
    const session = this.sessions.get(sessionId)
    if (!session) return { kind: 'invalid', reason: 'session-not-found' }
    return classifyHtmlPreviewLink(url, { sessionId, rootPath: session.rootPath })
  }

  destroyAll(): void {
    this.sessions.clear()
  }

  private async handleRequest(request: Request): Promise<Response> {
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      return new Response('Invalid HTML Preview URL', { status: 400 })
    }
    const session = this.sessions.get(parsed.hostname)
    if (!session) {
      if (process.env.ONWARD_AUTOTEST === '1') console.warn('[HtmlPreviewProtocol] session not found', parsed.hostname)
      return new Response('HTML Preview session not found', { status: 404 })
    }
    const resolvedRequest = resolveHtmlPreviewRequest(request.url, {
      sessionId: session.id,
      rootPath: session.rootPath
    })
    if (!resolvedRequest.success) {
      if (process.env.ONWARD_AUTOTEST === '1') console.warn('[HtmlPreviewProtocol] rejected request', resolvedRequest.reason, request.url)
      return new Response('HTML Preview resource is outside the project root', { status: 403 })
    }
    try {
      if (process.env.ONWARD_AUTOTEST === '1') console.log('[HtmlPreviewProtocol] serving', resolvedRequest.filePath)
      const bytes = await readFile(resolvedRequest.filePath)
      const extension = extname(resolvedRequest.filePath).toLowerCase()
      const contentType = MIME_TYPES[extension] ?? 'application/octet-stream'
      if (extension === '.html' || extension === '.htm') {
        const html = injectBridge(bytes.toString('utf8'), buildBridgeScript(session))
        return new Response(html, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-store'
          }
        })
      }
      return new Response(bytes, { headers: { 'Content-Type': contentType } })
    } catch (error) {
      if (process.env.ONWARD_AUTOTEST === '1') console.warn('[HtmlPreviewProtocol] read failed', resolvedRequest.filePath, String(error))
      return new Response('HTML Preview resource not found', { status: 404 })
    }
  }
}

export const htmlPreviewProtocolManager = new HtmlPreviewProtocolManager()
