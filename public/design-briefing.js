
import {buildBriefEvidence,selectBriefEvidence,summarizeBriefCoverage,BRIEFING_SECTIONS} from './briefing-core.js';

const $=id=>document.getElementById(id);
const state={drawings:[],support:[],evidence:[],latest:null};
const MAX_PAGES=80;
const LABELS={
  scope:"图纸范围",key_design:"关键设计",dimensions_levels:"尺寸 / 标高",
  rooms_functions:"房间 / 功能",doors_windows_facade:"门窗 / 立面",
  circulation_access:"交通 / 无障碍",materials_details:"材料 / 节点",
  coordination_interfaces:"专业接口",open_items:"未决事项"
};
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const download=(name,content)=>{const b=new Blob([content],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),700)};

function setFiles(kind,files){
  const list=[...files].filter(f=>f.type==='application/pdf'||(kind==='support'&&(f.type==='text/plain'||/\.txt$/i.test(f.name))));
  state[kind]=list;
  $(kind==='drawings'?'drawingInfo':'supportInfo').textContent=list.length?list.map(f=>f.name).join('；'):(kind==='drawings'?'尚未选择文件':'未添加补充资料');
  $('generateBtn').disabled=!state.drawings.length;
}
function bindDrop(zoneId,inputId,kind){
  const z=$(zoneId),i=$(inputId);z.onclick=()=>i.click();i.onchange=()=>setFiles(kind,i.files);z.ondragover=e=>e.preventDefault();z.ondrop=e=>{e.preventDefault();setFiles(kind,e.dataTransfer.files)};
}
bindDrop('drawingDrop','drawingFiles','drawings');
bindDrop('supportDrop','supportFiles','support');

let pdfp;
async function pdfjs(){
  if(!pdfp)pdfp=import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(p=>{
    p.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';return p;
  });
  return pdfp;
}
function rowsFromItems(items){
  const rows=[];
  for(const it of items){
    const s=String(it.str||'').trim();if(!s)continue;
    const y=Number(it.transform?.[5]||0),x=Number(it.transform?.[4]||0);
    let row=rows.find(r=>Math.abs(r.y-y)<=4);
    if(!row){row={y,items:[]};rows.push(row);}
    row.items.push({x,s});
  }
  return rows.sort((a,b)=>b.y-a.y).map(r=>r.items.sort((a,b)=>a.x-b.x).map(x=>x.s).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean);
}
async function parsePdf(file,documentId,sourceType){
  const p=await pdfjs(),doc=await p.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise,pages=[];
  for(let n=1;n<=Math.min(doc.numPages,MAX_PAGES);n++){
    const pg=await doc.getPage(n),tc=await pg.getTextContent({normalizeWhitespace:true,disableCombineTextItems:false});
    pages.push({pageNumber:n,lines:rowsFromItems(tc.items)});
  }
  return {documentId,documentName:file.name,sourceType,pages,sourcePages:doc.numPages,scannedPages:pages.length};
}
async function parseSupport(file,documentId){
  if(file.type==='text/plain'||/\.txt$/i.test(file.name))return {documentId,documentName:file.name,sourceType:'requirement',pages:[{pageNumber:1,lines:(await file.text()).split(/\r?\n+/)}],sourcePages:1,scannedPages:1};
  return parsePdf(file,documentId,'requirement');
}
function progress(title,text){$('progressTitle').textContent=title;$('progressText').textContent=text}

function renderCoverage(cov,sections=[]){
  const by=new Map((sections||[]).map(x=>[x.key,x]));
  $('sectionGrid').innerHTML=BRIEFING_SECTIONS.map(k=>{
    const s=by.get(k),status=s?.status|| (cov.found[k]?'ready':'not_found');
    return '<div class="sec-chip '+status+'"><b>'+esc(LABELS[k])+'</b><span>'+(s?.items?.length||cov.found[k]||0)+' 项 · '+esc(status)+'</span></div>';
  }).join('');
  $('readiness').textContent=Math.round(cov.covered/cov.totalSections*100)+'%';
}
function renderEvidence(ev){
  $('evidenceList').innerHTML=ev.length?ev.map(x=>'<article class="brief-evidence" id="ev-'+esc(x.id.replace(/[^A-Za-z0-9_-]/g,'-'))+'"><div class="id">'+esc(x.id)+'<br>P'+x.pageNumber+'</div><div class="loc">'+esc(x.sheetId||x.documentName)+'<br>'+esc(LABELS[x.category]||x.category)+'</div><p>'+esc(x.text)+'</p></article>').join(''):'<div class="empty">没有确定性证据。</div>';
}
function renderSections(sections){
  $('briefingSections').innerHTML=sections.map(s=>'<section class="brief-section"><div class="brief-section-head"><h4>'+esc(LABELS[s.key]||s.key)+'</h4><span>'+esc(s.status)+'</span></div><div class="brief-items">'
    +(s.items?.length?s.items.map(item=>'<article class="brief-item"><span class="priority '+esc(item.priority)+'">'+esc(item.priority)+'</span><h5>'+esc(item.title)+'</h5><p>'+esc(item.message)+'</p><p><b>交底动作：</b>'+esc(item.action||'现场确认并按正式图纸执行')+'</p><div class="cite-row">'+(item.citations||[]).map(id=>'<button class="cite" data-cite="'+esc(id)+'">'+esc(id)+'</button>').join('')+'</div></article>').join(''):'<div class="brief-item"><p>当前证据中未找到可形成该部分交底的内容。</p></div>')
    +'</div></section>').join('');
  document.querySelectorAll('[data-cite]').forEach(b=>b.onclick=()=>showEvidence(b.dataset.cite));
}
function renderOpenItems(items){
  $('openItems').innerHTML=items.length?items.map(x=>'<article class="open-card"><h4>'+esc(x.title||'未决事项')+'</h4><p>'+esc(x.message||'')+'</p><p><b>动作：</b>'+esc(x.action||'交底前关闭')+'</p><div class="cite-row">'+(x.citations||[]).map(id=>'<button class="cite" data-cite="'+esc(id)+'">'+esc(id)+'</button>').join('')+'</div></article>').join(''):'<div class="empty">本次文字证据未识别到 CHECK / VERIFY / TBD / HOLD / PENDING 等未决事项。</div>';
  $('openItems').querySelectorAll('[data-cite]').forEach(b=>b.onclick=()=>showEvidence(b.dataset.cite));
}
function showEvidence(id){
  const e=state.evidence.find(x=>x.id===id);
  if(e)alert((e.sheetId||e.documentName)+' · P'+e.pageNumber+' · '+(LABELS[e.category]||e.category)+'\n\n'+e.text);
}

$('generateBtn').onclick=async()=>{
  if(!state.drawings.length)return;
  const t0=performance.now();$('generateBtn').disabled=true;$('results').classList.add('hidden');$('progress').classList.remove('hidden');$('progress').scrollIntoView({behavior:'smooth'});
  try{
    const docs=[];
    progress('正在读取施工图…','扫描数字 PDF 文字层，建立图号、页码和交底证据。');
    for(let i=0;i<state.drawings.length;i++)docs.push(await parsePdf(state.drawings[i],'draw'+(i+1),'drawing'));
    progress('正在读取补充资料…','项目要求只作为独立证据源，不会冒充图纸事实。');
    for(let i=0;i<state.support.length;i++)docs.push(await parseSupport(state.support[i],'req'+(i+1)));

    progress('正在生成 Dxxxx 证据…','程序先抓图纸范围、尺寸、房间、门窗、接口与未决事项。');
    const evidence=buildBriefEvidence(docs);
    state.evidence=evidence;
    const selected=selectBriefEvidence(evidence,42),coverage=summarizeBriefCoverage(evidence);
    renderEvidence(evidence);renderCoverage(coverage);

    progress('MiniMax M3 正在组织交底稿…','模型只能重组已有 Dxxxx 证据，不能新增设计决定。');
    const resp=await fetch('/api/design-briefing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      projectName:$('projectName').value.trim(),audience:$('audience').value,notes:$('notes').value.trim(),
      documents:docs.map(d=>({documentId:d.documentId,name:d.documentName,sourceType:d.sourceType,sourcePages:d.sourcePages,scannedPages:d.scannedPages})),
      coverage,candidates:selected
    })});
    const data=await resp.json();if(!resp.ok)throw new Error(data.error||'设计交底生成失败');
    state.latest=data;
    $('summary').textContent=data.result.summary||'设计交底已生成';
    $('overall').textContent=data.result.overall||'请按交底正文逐项复核。';
    $('runtimeMeta').textContent='模型 '+(data.model||'MiniMax-M3')+' · Token '+(data.usage?.total_tokens||0)+' · 原始证据 '+evidence.length+' · M3候选 '+selected.length+' · '+((performance.now()-t0)/1000).toFixed(1)+'s';
    renderSections(data.result.sections||[]);renderOpenItems(data.result.openItems||[]);
    renderCoverage(coverage,data.result.sections||[]);
    $('agenda').innerHTML=(data.result.agenda||[]).map(x=>'<li>'+esc(x)+'</li>').join('')||'<li>按图纸范围、关键设计、专业接口、未决事项顺序进行。</li>';
    $('limitations').innerHTML=(data.result.limitations||[]).map(x=>'<li>'+esc(x)+'</li>').join('')||'<li>最终以正式图纸、变更与设计负责人确认意见为准。</li>';
    $('progress').classList.add('hidden');$('results').classList.remove('hidden');$('results').scrollIntoView({behavior:'smooth'});
  }catch(e){$('progress').classList.add('hidden');alert('生成失败：'+(e.message||e))}
  finally{$('generateBtn').disabled=!state.drawings.length}
};
$('jsonBtn').onclick=()=>{if(state.latest)download('agent-hong-design-briefing-'+Date.now()+'.json',JSON.stringify({...state.latest,evidence:state.evidence},null,2))};
$('printBtn').onclick=()=>window.print();
$('resetBtn').onclick=()=>{$('results').classList.add('hidden');window.scrollTo({top:0,behavior:'smooth'})};

async function health(){
  try{
    const r=await fetch('/api/health',{cache:'no-store'}),d=await r.json(),el=$('serviceStatus');
    el.className='status '+(d.ok&&d.configured?'ok':'warn');
    el.innerHTML='<span></span> '+(d.ok?'Module 07 已就绪':'服务状态未知');
  }catch{}
}
health();
