import {detectSheetId} from './diff-core.js';
import {deterministicReview} from './review-core.js';

const $ = id => document.getElementById(id);
const state = {drawing:null, reference:null, latest:null};
const MAX_PAGES=8, MAX_FILE=35*1024*1024, PAGE_MAX_SIDE=1280, MAX_REFERENCE_CHARS=36000;

async function checkHealth(){
  const el=$('serviceStatus');
  try{
    const r=await fetch('/api/health',{cache:'no-store'}); const d=await r.json();
    if(d.ok&&d.configured){el.className='status ok';el.innerHTML='<span></span> Module 02 已就绪';}
    else{el.className='status warn';el.innerHTML='<span></span> 等待模型配置';}
  }catch{el.className='status warn';el.innerHTML='<span></span> 服务状态未知';}
}
function humanSize(n){return n<1024*1024?Math.round(n/1024)+' KB':(n/1024/1024).toFixed(1)+' MB';}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function clamp(n,min=0,max=1){return Math.max(min,Math.min(max,n));}
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
async function renderPage(page,pageNumber){
  const raw=page.getViewport({scale:1});
  const scale=Math.min(2.0,PAGE_MAX_SIDE/Math.max(raw.width,raw.height));
  const vp=page.getViewport({scale});
  const canvas=document.createElement('canvas'); canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);
  const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:ctx,viewport:vp,background:'white'}).promise;
  const tx=await extractPageText(page); const digest=tx.textRaw.slice(0,7000);
  return {pageNumber,image:toJpeg(canvas),sheetId:detectSheetId(tx.textRaw),textRaw:tx.textRaw,textDigest:digest,textDigestTruncated:tx.textRaw.length>digest.length,textItemCount:tx.textItemCount};
}
async function prepareDrawing(file){
  if(file.type==='application/pdf'){
    const pdfjs=await loadPdfJs(); const bytes=new Uint8Array(await file.arrayBuffer()); const pdf=await pdfjs.getDocument({data:bytes}).promise;
    const count=Math.min(pdf.numPages,MAX_PAGES),pages=[];
    for(let i=1;i<=count;i++)pages.push(await renderPage(await pdf.getPage(i),i));
    return {name:file.name,type:'pdf',sourcePages:pdf.numPages,pages};
  }
  const bitmap=await createImageBitmap(file);const scale=Math.min(1,PAGE_MAX_SIDE/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
  const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return {name:file.name,type:'image',sourcePages:1,pages:[{pageNumber:1,image:toJpeg(canvas),sheetId:null,textRaw:'',textDigest:'',textDigestTruncated:false,textItemCount:0}]};
}
async function prepareReference(file){
  if(!file)return {name:null,text:'',mode:'none',truncated:false};
  if(file.type==='text/plain'||/\.txt$/i.test(file.name)){
    const text=await file.text();return {name:file.name,text:text.slice(0,MAX_REFERENCE_CHARS),mode:'text',truncated:text.length>MAX_REFERENCE_CHARS};
  }
  const pdfjs=await loadPdfJs();const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  let text='',pagesRead=0;
  for(let i=1;i<=Math.min(pdf.numPages,20);i++){
    const tx=await extractPageText(await pdf.getPage(i)); if(tx.textRaw)text+='[P'+i+'] '+tx.textRaw+'\n'; pagesRead=i;
    if(text.length>=MAX_REFERENCE_CHARS)break;
  }
  return {name:file.name,text:text.slice(0,MAX_REFERENCE_CHARS),mode:text.trim()?'pdf-text':'pdf-no-text',truncated:text.length>MAX_REFERENCE_CHARS||pdf.numPages>pagesRead};
}
function stripDrawing(d){
  return {name:d.name,type:d.type,sourcePages:d.sourcePages,pages:d.pages.map(p=>({pageNumber:p.pageNumber,image:p.image,sheetId:p.sheetId,textDigest:p.textDigest,textDigestTruncated:p.textDigestTruncated,textItemCount:p.textItemCount}))};
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
  el.innerHTML=items.map(x=>'<article class="hard-card"><div class="sev '+esc(x.severity)+'">'+sev(x.severity)+'</div><div><span class="hard-source">程序证据</span><h4>'+esc(x.category)+' · '+esc(x.location)+'</h4><p>'+esc(x.issue)+'</p><p><b>证据：</b>'+esc(x.evidence)+'</p></div><div class="confidence">'+esc(x.id)+'</div></article>').join('');
}
function renderIssues(el,items){
  if(!items?.length){el.innerHTML='<div class="empty">本次未识别到明确问题。</div>';return;}
  el.innerHTML=items.map(x=>{
    const s=['high','medium','low'].includes(x.severity)?x.severity:'medium';
    return '<article class="issue-card"><div class="sev '+s+'">'+sev(s)+'</div><div class="issue-main"><div>'+sourceBadge(x.evidenceSource)+'</div><h4>'+esc(x.category||'问题')+' · '+esc(x.location||'位置待确认')+'</h4><p><b>问题：</b>'+esc(x.issue)+'</p><p><b>证据：</b>'+esc(x.evidence)+'</p><p><b>为什么要看：</b>'+esc(x.why||'需人工复核')+'</p><p><b>建议：</b>'+esc(x.action||'人工复核')+'</p>'+(x.deterministicIds?.length?'<p class="refs">证据 '+x.deterministicIds.map(esc).join(', ')+'</p>':'')+'</div><div class="confidence">'+(Number.isFinite(Number(x.confidence))?Math.round(Number(x.confidence)*100)+'% 置信':'')+'</div></article>';
  }).join('');
}
function renderResult(data,det,reference,timing){
  const r=data.result||{};state.latest={...data,local:{deterministic:det,reference:{name:reference.name,mode:reference.mode,truncated:reference.truncated},timing}};
  $('summaryText').textContent=r.summary||'预审完成';$('overallText').textContent=r.overall||'请查看下方问题。';
  $('hardCount').textContent=r.counts?.hard??det.alerts.length;$('issueCount').textContent=r.counts?.issues??r.issues?.length??0;$('crossCount').textContent=r.counts?.crossSheet??r.crossSheetRisks?.length??0;$('highCount').textContent=r.counts?.highRisk??0;
  const mode=r.analysisMode||det.textCoverage.mode;$('analysisMode').className='mode '+(mode==='hybrid'?'hybrid':'visual');$('analysisMode').textContent=mode==='hybrid'?'HYBRID · 文字规则 + 视觉 + M3':'VISUAL · 文字层不足';
  renderHard(r.hardAlerts||det.alerts);renderIssues($('issueCards'),r.issues||[]);renderIssues($('crossCards'),r.crossSheetRisks||[]);
  const ck=Array.isArray(r.checklist)?r.checklist:[];$('checklist').innerHTML=ck.length?ck.map(x=>'<li>'+esc(x)+'</li>').join(''):'<li>建议设计负责人复核高风险问题。</li>';
  const lm=Array.isArray(r.limitations)?r.limitations:[];$('limitations').innerHTML=lm.length?lm.map(x=>'<li>'+esc(x)+'</li>').join(''):'<li>预审用于辅助核对，不替代专业终审。</li>';
  const u=data.usage||{};$('runtimeMeta').textContent='模型 '+(data.model||'MiniMax-M3')+' · '+(u.total_tokens?('Token '+Number(u.total_tokens).toLocaleString()+' · '):'')+'程序硬问题 '+det.alerts.length+' · 参考资料 '+(reference.name||'未提供')+' · 总耗时 '+(timing.totalMs/1000).toFixed(1)+'s';
}
$('reviewBtn').addEventListener('click',async()=>{
  if(!state.drawing)return;
  const btn=$('reviewBtn');btn.disabled=true;$('results').classList.add('hidden');$('progress').classList.remove('hidden');$('progress').scrollIntoView({behavior:'smooth',block:'center'});
  const t0=performance.now();
  try{
    progress(0,'正在读取施工图…','原始 PDF 留在浏览器；提取图号、门窗编号、文字层并渲染前 8 页。');
    const [drawing,reference]=await Promise.all([prepareDrawing(state.drawing),prepareReference(state.reference)]);
    progress(1,'正在做程序硬检查…','检查图号缺失/重复、门窗表漏项、CHECK/VERIFY/TBD 等未闭环标记。');
    const det=deterministicReview(drawing.pages,drawing.sourcePages);
    progress(2,'MiniMax M3 正在做工程预审…','结合程序证据、完整页面和你提供的院标/甲方要求，检查跨图一致性与明显风险。');
    const apiStart=performance.now();
    const resp=await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      projectName:$('projectName').value.trim(),focus:$('focus').value.trim(),drawing:stripDrawing(drawing),reference,deterministic:det
    })});
    const data=await resp.json();if(!resp.ok)throw new Error(data.error||'预审失败');
    progress(3,'正在整理预审报告…','将程序硬问题、AI问题和跨图风险分层展示。');
    const timing={apiMs:Math.round(performance.now()-apiStart),totalMs:Math.round(performance.now()-t0)};
    renderResult(data,det,reference,timing);$('progress').classList.add('hidden');$('results').classList.remove('hidden');$('results').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){$('progress').classList.add('hidden');alert('预审失败：'+(e.message||e));}
  finally{btn.disabled=false;}
});
$('resetBtn').addEventListener('click',()=>{$('results').classList.add('hidden');$('workspace').scrollIntoView({behavior:'smooth',block:'start'});});
$('printBtn').addEventListener('click',()=>window.print());
$('jsonBtn').addEventListener('click',()=>{if(!state.latest)return;const blob=new Blob([JSON.stringify(state.latest,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='agent-hong-precheck-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
checkHealth();
