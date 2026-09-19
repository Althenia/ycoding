export * as MemoryGraph from "./graph"

import path from "node:path"
import { MemoryFormat } from "./format"

export interface Node {
  /** Qualified identity within the exported memory base, e.g. `repository/repo_x/guide` or `knowledge/build`. */
  readonly id: string
  readonly concept: MemoryFormat.Concept
}

export function render(nodes: readonly Node[]) {
  const ids = new Set(nodes.map((node) => node.id))
  const edges = new Map<string, { source: string; target: string }>()
  const warnings: MemoryFormat.Warning[] = []
  for (const node of nodes) {
    const concept = node.concept
    for (const link of concept.links) {
      if (/^(?:https?:|mailto:|repo:)/i.test(link) || link.startsWith("#")) continue
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(link)) {
        warnings.push({ id: concept.id, code: "unsafe-link" })
        continue
      }
      const decoded = decode(link.split(/[?#]/)[0])
      if (decoded === undefined || decoded.includes("\\")) {
        warnings.push({ id: concept.id, code: "unsafe-link" })
        continue
      }
      const target = path.posix
        .normalize(decoded.startsWith("/") ? decoded.slice(1) : path.posix.join(path.posix.dirname(node.id), decoded))
        .replace(/\.md$/, "")
      if (target.startsWith("../") || target === "..") {
        warnings.push({ id: concept.id, code: "unsafe-link" })
        continue
      }
      if (!ids.has(target)) {
        warnings.push({ id: concept.id, code: "dangling-link" })
        continue
      }
      edges.set(`${node.id}\0${target}`, { source: node.id, target })
    }
  }
  const data = JSON.stringify({
    nodes: nodes.map((node) => ({ ...MemoryFormat.summary(node.concept), id: node.id, body: node.concept.content })),
    edges: [...edges.values()],
    warnings,
  }).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
  return { nodes: nodes.length, edges: edges.size, warnings, html: page(data) }
}

function decode(value: string) {
  try { return decodeURIComponent(value) } catch { return undefined }
}

function page(data: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<title>YCoding · Workspace knowledge</title>
<style>
:root{color-scheme:dark light;--bg:#101619;--panel:#172126;--text:#e5eeea;--muted:#a7bdb4;--accent:#98e0bc;--line:#354c43}
body,button{overflow-wrap:anywhere}button{max-width:100%;white-space:normal}label{min-width:0;max-width:100%}select{max-width:100%}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}header,main{max-width:1440px;margin:auto;padding:24px 32px}header{border-bottom:1px solid var(--line)}small{letter-spacing:.14em;color:var(--accent)}h1{font-size:clamp(26px,4vw,40px);margin:4px 0}p{margin:8px 0;color:var(--muted)}.controls{display:flex;gap:16px;flex-wrap:wrap;margin-top:20px}label{display:grid;gap:5px}input,select,button{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:8px 12px}input{width:min(420px,75vw)}button{cursor:pointer}button:hover{border-color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}main{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:28px}section{min-width:0}svg{width:100%;height:auto;min-height:240px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}svg line{stroke:var(--line);stroke-width:2}svg circle{fill:var(--bg);stroke:var(--accent);stroke-width:2}svg text{fill:var(--text);font-size:13px;paint-order:stroke;stroke:var(--panel);stroke-width:4px}svg [aria-pressed=true] circle{fill:var(--accent)}svg g{cursor:pointer}#concepts,#related{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}#reader{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 ui-monospace,monospace;border-top:1px solid var(--line);padding-top:20px}#reader-title{margin-top:0}#status{font-size:14px}#empty{padding:32px;text-align:center}@media(max-width:850px){main{grid-template-columns:1fr}header,main{padding:20px}}@media(prefers-color-scheme:light){:root{--bg:#f5f7f3;--panel:#fff;--text:#192b23;--muted:#465e51;--accent:#17613e;--line:#bdcbbf}}
</style></head><body><header><small>YCODING / LOCAL KNOWLEDGE</small><h1>Workspace knowledge</h1><p>A read-only view of your linked Markdown concepts. Select a node to read its source and relationships.</p><div class="controls"><label>Search<input id="search" type="search" placeholder="Title, type, tag or text"></label><label>Type<select id="type"><option value="">All types</option></select></label></div><p id="status" role="status"></p></header>
<main><section aria-label="Knowledge graph"><p id="empty" hidden>No knowledge saved yet. Ask your agent to save a workspace concept.</p><svg id="graph" viewBox="0 0 800 650" role="group" aria-label="Concept relationships"></svg><div id="concepts" aria-label="Matching concepts"></div></section><section aria-label="Concept reader"><h2 id="reader-title">Select a concept</h2><p id="reader-meta"></p><div id="related" aria-label="Related concepts"></div><pre id="reader"></pre></section></main>
<script id="knowledge-data" type="application/json">${data}</script>
<script>
const knowledge=JSON.parse(document.getElementById('knowledge-data').textContent);
const search=document.getElementById('search'),type=document.getElementById('type'),graph=document.getElementById('graph'),list=document.getElementById('concepts');
let selected=knowledge.nodes[0]?.id;
for(const value of [...new Set(knowledge.nodes.map(n=>n.type))].sort()){const option=document.createElement('option');option.value=value;option.textContent=value;type.append(option)}
function button(node){const b=document.createElement('button');b.type='button';b.dataset.id=node.id;b.textContent=node.title||node.id;b.setAttribute('aria-pressed',String(node.id===selected));b.onclick=()=>select(node.id);return b}
function select(id){selected=id;draw()}
function draw(){
const active=document.activeElement,focusID=active?.getAttribute('data-id'),focusRegion=active?.parentElement?.id;
const query=search.value.toLowerCase();const nodes=knowledge.nodes.filter(n=>(!type.value||n.type===type.value)&&[n.id,n.title,n.description,n.type,...(n.tags||[]),n.body].filter(Boolean).join(' ').toLowerCase().includes(query));
document.getElementById('empty').hidden=knowledge.nodes.length!==0;graph.hidden=knowledge.nodes.length===0;
document.getElementById('status').textContent=nodes.length+' / '+knowledge.nodes.length+' concepts · '+knowledge.edges.length+' links · '+knowledge.warnings.length+' warnings. Lines show the selected concept’s relationships.';
list.replaceChildren(...nodes.map(button));graph.replaceChildren();const positions=new Map(nodes.map((n,i)=>[n.id,{x:400+Math.cos(i*2*Math.PI/Math.max(nodes.length,1))*285,y:325+Math.sin(i*2*Math.PI/Math.max(nodes.length,1))*250}]));
const element=(name,attrs)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e};
for(const edge of knowledge.edges){if(edge.source!==selected&&edge.target!==selected)continue;const a=positions.get(edge.source),b=positions.get(edge.target);if(a&&b)graph.append(element('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y}))}
for(const n of nodes){const p=positions.get(n.id),g=element('g',{role:'button',tabindex:0,'data-id':n.id,'aria-label':n.title||n.id,'aria-pressed':n.id===selected});g.append(element('circle',{cx:p.x,cy:p.y,r:10}));const text=element('text',{x:p.x,y:p.y+28,'text-anchor':'middle'});text.textContent=(n.title||n.id).slice(0,36);g.append(text);g.onclick=()=>select(n.id);g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(n.id)}};graph.append(g)}
const current=knowledge.nodes.find(n=>n.id===selected);document.getElementById('reader-title').textContent=current?.title||current?.id||'Select a concept';document.getElementById('reader-meta').textContent=current?current.type+' · '+current.id:'';document.getElementById('reader').textContent=current?.body||'';
const connected=new Set(knowledge.edges.filter(e=>e.source===selected||e.target===selected).flatMap(e=>[e.source,e.target]));document.getElementById('related').replaceChildren(...knowledge.nodes.filter(n=>n.id!==selected&&connected.has(n.id)).map(button));
if(current)document.getElementById('status').textContent+=' Selected: '+(current.title||current.id)+'.';
if(focusID&&focusRegion){const replacement=[...(document.getElementById(focusRegion)?.querySelectorAll('[data-id]')||[]),...list.querySelectorAll('[data-id]')].find(e=>e.getAttribute('data-id')===focusID);const target=replacement||document.getElementById('reader-title');if(!replacement)target.tabIndex=-1;target.focus({preventScroll:true})}
}
search.addEventListener('input',draw);type.addEventListener('change',draw);draw();
</script></body></html>`
}
