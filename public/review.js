import {detectSheetId} from './diff-core.js';
import {deterministicReview,rankReviewPages} from './review-core.js';

const $ = id => document.getElementById(id);
const state = {drawing:null, reference:null, latest:null};
const MAX_SCAN_PAGES=30;
const MAX_AI_PAGES=10;
const MAX_FILE=35*1024*1024;
const PAGE_MAX_SIDE=1280;
const MAX_REFERENCE_CHARS=60000;
const MAX_REFERENCE_PAGES=30;
const REF_CHUNK_CHARS=900;

async function checkHealth(){
  const el=$('serviceStatus');
  try{
    const r=await fetch('/api/health',{cache:'no-store'}); const d=await r.json();
    if(d.ok&&d.configured){el.className='status ok';el.innerHTML='<span></span> Module 02 V2 已就绪';}
    else{el.className='status warn';el.innerHTML='<span></span> 等待模型配置';}
  }catch{el.className='status warn';el.innerHTML='<span></span> 服务状态未知';}
}
function humanSize(n){return n<1024*1024?Math.round(n/1024)+' KB':(n/1024/1024).toFixed(1)+' MB';}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function toJpeg(canvas,q=.70){return canvas.toDataURL('image/jpeg',q);}

function setDrawing(file){
  if(!file)return;
  if(file.size>MAX_FILE)return alert('施工图单文件最大 35MB。');
  if(!(file.type==='application/pdf'||/^image\/(png|jpeg|webp)$/.test(file.type)))return alert('施工图支持 PDF / PNG / JPG / WEBP。');
  state.drawing=file; document.querySelector('[data-target="drawing"]').classList.add('ready');
  $('drawingInfo').textContent=file.name+' · '+humanSize(file.size); $('reviewBtn').disabled=false;
}
function setReference(file){
  if(!file)return;
  if(file.size>MAX_FILE)return alert('参考资料单文件最大 35MB。');
  if(!(file.type==='application/pdf'||file.type==='text/plain'||/\.txt$/i.test(file.name)))return alert('参考资料支持 PDF / TXT。');
  state.reference=file; document.querySelector('[data-target="reference"]').classList.add('ready');
  $('referenceInfo').textContent=file.name+' · '+humanSize(file.size);
}
for(const target of ['drawing','reference']){
  const zone=document.querySelector('[data-target="'+target+'"]');
  const input=$(target==='drawing'?'drawingFile':'referenceFile');
  zone.addEventListener('click',()=>input.click());
  zone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')input.click();});
  input.addEventListener('change',()=>target==='drawing'?setDrawing(input.files[0]):setReference(input.files[0]));
  ['dragenter','dragover'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove('drag');}));
  zone.addEventListener('drop',e=>target==='drawing'?setDrawing(e.dataTransfer.files[0]):setReference(e.dataTransfer.files[0]));
}

let pdfJsPromise;
async function loadPdfJs(){
  if(!pdfJsPromise)pdfJsPromise=import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(pdfjs=>{
    pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs'; return pdfjs;
  });
  return pdfJsPromise;
}
async function extractPageText(page){
  try{
    const tc=await page.getTextContent({normalizeWhitespace:true,disableCombineTextItems:false});
    const parts=tc.items.map(x=>String(x.str||'').trim()).filter(Boolean);
    return {textRaw:parts.join(' '),textItemCount:parts.length};
  }catch{return {textRaw:'',textItemCount:0};}
}
async function scanDrawing(file){
  if(file.type!=='application/pdf'){
    const bitmap=await createImageBitmap(file);const scale=Math.min(1,PAGE_MAX_SIDE/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    return {name:file.name,type:'image',sourcePages:1,scannedPages:1,pages:[{pageNumber:1,image:toJpeg(canvas),sheetId:null,textRaw:'',textDigest:'',textDigestTruncated:false,textItemCount:0}],_pdf:null};
  }
  const pdfjs=await loadPdfJs();
  const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const count=Math.min(pdf.numPages,MAX_SCAN_PAGES),pages=[];
  for(let i=1;i<=count;i++){
    const page=await pdf.getPage(i);const tx=await extractPageText(page);const digest=tx.textRaw.slice(0,7000);
    pages.push({pageNumber:i,sheetId:detectSheetId(tx.textRaw),textRaw:tx.textRaw,textDigest:digest,textDigestTruncated:tx.textRaw.length>digest.length,textItemCount:tx.textItemCount});
  }
  return {name:file.name,type:'pdf',sourcePages:pdf.numPages,scannedPages:count,pages,_pdf:pdf};
}
async function renderPdfPage(pdf,pageMeta){
  const page=await pdf.getPage(pageMeta.pageNumber);
  const raw=page.getViewport({scale:1});const scale=Math.min(2.0,PAGE_MAX_SIDE/Math.max(raw.width,raw.height));const vp=page.getViewport({scale});
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);
  const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:ctx,viewport:vp,background:'white'}).promise;
  return {...pageMeta,image:toJpeg(canvas)};
}
async function selectAndRender(scanned,det){
  if(scanned.type!=='pdf') return {selected:scanned.pages,ranking:[{pageNumber:1,sheetId:null,role:'other',score:100}]};
  const ranking=rankReviewPages(scanned.pages,det,MAX_AI_PAGES);
  const selected=[];
  for(const r of ranking){
    selected.push(await renderPdfPage(scanned._pdf,scanned.pages[r.index]));
  }
  return {selected,ranking};
}

function chunkReference(parts){
  const chunks=[];let seq=1;
  for(const part of parts){
    let s=String(part.text||'').trim();
    while(s){
      let cut=Math.min(REF_CHUNK_CHARS,s.length);
      if(cut<s.length){
        const p=Math.max(s.lastIndexOf('. ',cut),s.lastIndexOf('。',cut),s.lastIndexOf('; ',cut),s.lastIndexOf('；',cut));
        if(p>REF_CHUNK_CHARS*.55)cut=p+1;
      }
      const text=s.slice(0,cut).trim();
      if(text)chunks.push({id:'R'+String(seq++).padStart(3,'0'),page:part.page||null,text});
      s=s.slice(cut).trim();
      if(chunks.length>=80)return chunks;
    }
  }
  return chunks;
}
async function prepareReference(file){
  if(!file)return {name:null,text:'',chunks:[],mode:'none',truncated:false,pagesRead:0};
  if(file.type==='text/plain'||/\.txt$/i.test(file.name)){
    const raw=await file.text();const text=raw.slice(0,MAX_REFERENCE_CHARS);
    return {name:file.name,text,chunks:chunkReference([{page:null,text}]),mode:'text',truncated:raw.length>MAX_REFERENCE_CHARS,pagesRead:1};
  }
  const pdfjs=await loadPdfJs();const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const parts=[];let text='',pagesRead=0;
  for(let i=1;i<=Math.min(pdf.numPages,MAX_REFERENCE_PAGES);i++){
    const tx=await extractPageText(await pdf.getPage(i));parts.push({page:i,text:tx.textRaw});
    if(tx.textRaw)text+='[P'+i+'] '+tx.textRaw+'\n';pagesRead=i;
    if(text.length>=MAX_REFERENCE_CHARS)break;
  }
  text=text.slice(0,MAX_REFERENCE_CHARS);
  return {name:file.name,text,chunks:chunkReference(parts),mode:text.trim()?'pdf-text':'pdf-no-text',truncated:text.length>=MAX_REFERENCE_CHARS||pdf.numPages>pagesRead,pagesRead};
}
function stripDrawing(scanned,selected,ranking){
  return {
    name:scanned.name,type:scanned.type,sourcePages:scanned.sourcePages,scannedPages:scanned.scannedPages,
    selectedPageNumbers:selected.map(p=>p.pageNumber),
    selection:ranking.map(({pageNumber,sheetId,role,score})=>({pageNumber,sheetId,role,score})),
    pages:selected.map(p=>({pageNumber:p.pageNumber,image:p.image,sheetId:p.sheetId,textDigest:p.textDigest,textDigestTruncated:p.textDigestTruncated,textItemCount:p.textItemCount}))
  };
}
function progress(step,title,text){
  $('progressTitle').textContent=title;$('progressText').textContent=text;
  ['p1','p2','p3','p4'].forEach((id,i)=>$(id).classList.toggle('active',i<=step));
}
function sev(s){return s==='high'?'高风险':s==='medium'?'需关注':'一般';}
function sourceBadge(s){
  if(s==='pdf_text')return '<span class="source exact">程序证据</span>';
  if(s==='mixed')return '<span class="source mixed">混合证据</span>';
  if(s==='visual')return '<span class="source visual">视觉判断</span>';
  if(s==='reference')return '<span class="source exact">用户依据</span>';
  return '<span class="source ai">AI判断</span>';
}
function renderHard(items){
  const el=$('hardCards');
  if(!items?.length){el.innerHTML='<div class="empty">程序硬检查暂未发现明确问题。</div>';return;}
  el.innerHTML=items.map(x=>'<article class="hard-card" data-severity="'+esc(x.severity)+'"><div class="sev '+esc(x.severity)+'">'+sev(x.severity)+'</div><div><span class="hard-source">程序证据</span><h4>'+esc(x.category)+' · '+esc(x.location)+'</h4><p>'+esc(x.issue)+'</p><p><b>证据：</b>'+esc(x.evidence)+'</p></div><div class="confidence">'+esc(x.id)+'</div></article>').join('');
}
function renderIssues(el,items){
  if(!items?.length){el.innerHTML='<div class="empty">本次未识别到明确问题。</div>';return;}
  el.innerHTML=items.map(x=>{
    const s=['high','medium','low'].includes(x.severity)?x.severity:'medium';
    const refs=x.referenceIds?.length?'<p class="refs">依据 '+x.referenceIds.map(esc).join(', ')+'</p>':'';
    const det=x.deterministicIds?.length?'<p class="refs">程序证据 '+x.deterministicIds.map(esc).join(', ')+'</p>':'';
    return '<article class="issue-card" data-severity="'+s+'"><div class="sev '+s+'">'+sev(s)+'</div><div class="issue-main"><div>'+sourceBadge(x.evidenceSource)+'</div><h4>'+esc(x.category||'问题')+' · '+esc(x.location||'位置待确认')+'</h4><p><b>问题：</b>'+esc(x.issue)+'</p><p><b>证据：</b>'+esc(x.evidence)+'</p><p><b>为什么要看：</b>'+esc(x.why||'需人工复核')+'</p><p><b>建议：</b>'+esc(x.action||'人工复核')+'</p>'+det+refs+'</div><div class="confidence">'+(Number.isFinite(Number(x.confidence))?Math.round(Number(x.confidence)*100)+'% 置信':'')+'</div></article>';
  }).join('');
}
function roleName(role){return ({index:'目录',plan:'平面',elevation:'立面',section:'剖面',schedule:'门窗表',detail:'详图',notes:'说明',other:'其他'})[role]||role;}
function renderSheets(det,result){
  const summaries=new Map((result?.sheetSummary||[]).map(x=>[x.sheetId||('P'+x.page),x]));
  const hardCountBySheet=new Map();
  for(const a of det.alerts||[]){
    for(const s of det.sheets||[]){
      const key=s.sheetId||('P'+s.page);
      if(String(a.location||'').includes(key))hardCountBySheet.set(key,(hardCountBySheet.get(key)||0)+1);
    }
  }
  $('sheetTable').innerHTML=(det.sheets||[]).map(s=>{
    const key=s.sheetId||('P'+s.page),sum=summaries.get(key);
    return '<div class="sheet-row"><b>'+esc(key)+'</b><span>'+esc(roleName(s.role))+'</span><span>文字 '+esc(s.textItemCount)+'</span><span class="'+((hardCountBySheet.get(key)||0)?'sheet-risk':'')+'">'+(hardCountBySheet.get(key)||0)+' 硬问题</span><small>'+esc(sum?.note||'')+'</small></div>';
  }).join('')||'<div class="empty">无图纸清单。</div>';
}
function renderReferences(reference,result){
  const used=new Set();
  for(const x of [...(result.issues||[]),...(result.crossSheetRisks||[])]) for(const id of x.referenceIds||[]) used.add(id);
  const chunks=(reference.chunks||[]).filter(x=>used.has(x.id));
  const el=$('referenceCards');
  if(!reference.name){el.innerHTML='<div class="empty">本次未提供项目要求 / 院标，因此不做依据型合规判断。</div>';return;}
  if(!chunks.length){el.innerHTML='<div class="empty">已读取 '+esc(reference.name)+'，本次问题没有直接引用其中具体条款。</div>';return;}
  el.innerHTML=chunks.map(x=>'<article class="reference-card"><b>'+esc(x.id)+(x.page?' · P'+x.page:'')+'</b><p>'+esc(x.text)+'</p></article>').join('');
}
function applyFilter(level){
  document.querySelectorAll('[data-severity]').forEach(el=>{el.style.display=(level==='all'||el.dataset.severity===level)?'':'none';});
  document.querySelectorAll('#filters button').forEach(b=>b.classList.toggle('active',b.dataset.level===level));
}
function renderResult(data,det,reference,timing,scanned,selected){
  const r=data.result||{};
  state.latest={...data,local:{deterministic:det,reference:{name:reference.name,mode:reference.mode,truncated:reference.truncated,chunks:reference.chunks},timing,selectedPages:selected.map(p=>p.pageNumber)}};
  $('summaryText').textContent=r.summary||'预审完成';$('overallText').textContent=r.overall||'请查看下方问题。';
  $('hardCount').textContent=r.counts?.hard??det.alerts.length;$('issueCount').textContent=r.counts?.issues??r.issues?.length??0;$('crossCount').textContent=r.counts?.crossSheet??r.crossSheetRisks?.length??0;$('refCount').textContent=r.counts?.referenceBased??0;$('highCount').textContent=r.counts?.highRisk??0;
  $('reviewStatus').className='review-status '+esc(r.reviewStatus||'review');$('reviewStatus').textContent=({clear:'NO MAJOR ISSUE','review':'REVIEW','needs-attention':'NEEDS ATTENTION'})[r.reviewStatus]||'REVIEW';
  const mode=r.analysisMode||det.textCoverage.mode;$('analysisMode').className='mode '+(mode==='hybrid'?'hybrid':'visual');$('analysisMode').textContent=mode==='hybrid'?'HYBRID · 文字规则 + 关键页视觉 + M3':'VISUAL · 文字层不足';
  renderHard(r.hardAlerts||det.alerts);renderIssues($('issueCards'),r.issues||[]);renderIssues($('crossCards'),r.crossSheetRisks||[]);
  renderSheets(det,r);renderReferences(reference,r);
  const ck=Array.isArray(r.checklist)?r.checklist:[];$('checklist').innerHTML=ck.length?ck.map(x=>'<li>'+esc(x)+'</li>').join(''):'<li>建议设计负责人复核高风险问题。</li>';
  const lm=Array.isArray(r.limitations)?r.limitations:[];$('limitations').innerHTML=lm.length?lm.map(x=>'<li>'+esc(x)+'</li>').join(''):'<li>预审用于辅助核对，不替代专业终审。</li>';
  const u=data.usage||{};$('runtimeMeta').textContent='模型 '+(data.model||'MiniMax-M3')+' · '+(u.total_tokens?('Token '+Number(u.total_tokens).toLocaleString()+' · '):'')+'扫描 '+scanned.scannedPages+'/'+scanned.sourcePages+' 页 · M3查看 '+selected.length+' 页 · 程序硬问题 '+det.alerts.length+' · 总耗时 '+(timing.totalMs/1000).toFixed(1)+'s';
  applyFilter('all');
}
$('filters').addEventListener('click',e=>{const b=e.target.closest('button[data-level]');if(b)applyFilter(b.dataset.level);});

$('reviewBtn').addEventListener('click',async()=>{
  if(!state.drawing)return;
  const btn=$('reviewBtn');btn.disabled=true;$('results').classList.add('hidden');$('progress').classList.remove('hidden');$('progress').scrollIntoView({behavior:'smooth',block:'center'});
  const t0=performance.now();
  try{
    progress(0,'正在扫描施工图文字层…','最多扫描前 30 页建立图号、目录、房间、门窗、引用和待确认项索引；原始 PDF 不上传。');
    const [scanned,reference]=await Promise.all([scanDrawing(state.drawing),prepareReference(state.reference)]);
    progress(1,'正在做程序硬检查并挑关键页…','先跑目录/门窗/房间/跨图引用/未闭环规则，再把问题页和主要图种优先送给 M3。');
    const det=deterministicReview(scanned.pages,scanned.sourcePages);
    const {selected,ranking}=await selectAndRender(scanned,det);
    progress(2,'MiniMax M3 正在做工程预审…','M3 只查看最多 10 个关键页，同时读取全部文字硬证据和项目要求引用。');
    const apiStart=performance.now();
    const resp=await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      projectName:$('projectName').value.trim(),focus:$('focus').value.trim(),
      drawing:stripDrawing(scanned,selected,ranking),
      reference:{name:reference.name,text:reference.text,chunks:reference.chunks,mode:reference.mode,truncated:reference.truncated,pagesRead:reference.pagesRead},
      deterministic:det
    })});
    const data=await resp.json();if(!resp.ok)throw new Error(data.error||'预审失败');
    progress(3,'正在整理预审报告…','将程序硬问题、AI问题、跨图风险、图纸覆盖和引用依据分层展示。');
    const timing={apiMs:Math.round(performance.now()-apiStart),totalMs:Math.round(performance.now()-t0)};
    renderResult(data,det,reference,timing,scanned,selected);$('progress').classList.add('hidden');$('results').classList.remove('hidden');$('results').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){$('progress').classList.add('hidden');alert('预审失败：'+(e.message||e));}
  finally{btn.disabled=false;}
});
$('resetBtn').addEventListener('click',()=>{$('results').classList.add('hidden');$('workspace').scrollIntoView({behavior:'smooth',block:'start'});});
$('printBtn').addEventListener('click',()=>window.print());
$('jsonBtn').addEventListener('click',()=>{if(!state.latest)return;const blob=new Blob([JSON.stringify(state.latest,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='agent-hong-precheck-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
checkHealth();
