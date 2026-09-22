import {detectSheetId,pairPages,summarizeDeterministicDiff,mergeTextItems} from './diff-core.js';
import {parseCommentLines,buildCommentEvidence,scorePagePairsForComments} from './comment-core.js';

const $=id=>document.getElementById(id);
const state={comments:null,old:null,new:null,latest:null,currentFilter:'all'};
const MAX_FILE=35*1024*1024,MAX_SCAN=30,MAX_AI_PAIRS=8,PAGE_MAX_SIDE=1150;

async function checkHealth(){
  const el=$('serviceStatus');
  try{
    const r=await fetch('/api/health',{cache:'no-store'}),d=await r.json();
    if(d.ok&&d.configured){el.className='status ok';el.innerHTML='<span></span> Module 03 已就绪';}
    else{el.className='status warn';el.innerHTML='<span></span> 等待模型配置';}
  }catch{el.className='status warn';el.innerHTML='<span></span> 服务状态未知';}
}
const humanSize=n=>n<1024*1024?Math.round(n/1024)+' KB':(n/1024/1024).toFixed(1)+' MB';
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const clamp=(n,min=0,max=1)=>Math.max(min,Math.min(max,n));
const jpeg=(canvas,q=.64)=>canvas.toDataURL('image/jpeg',q);

function validDrawing(file){return file&&(file.type==='application/pdf'||/^image\/(png|jpeg|webp)$/.test(file.type));}
function validComments(file){
  if(!file)return false;
  const n=file.name.toLowerCase();
  return file.type==='application/pdf'||file.type==='text/plain'||file.type==='text/csv'||/\.(txt|csv|docx|xlsx|xls)$/i.test(n);
}
function setFile(target,file){
  if(!file)return;
  if(file.size>MAX_FILE)return alert('单文件最大 35MB。');
  if(target==='comments'&&!validComments(file))return alert('意见文件支持 PDF / TXT / CSV / DOCX / XLSX / XLS。');
  if(target!=='comments'&&!validDrawing(file))return alert('图纸支持 PDF / PNG / JPG / WEBP。');
  state[target]=file;
  document.querySelector('[data-target="'+target+'"]').classList.add('ready');
  $(target+'Info').textContent=file.name+' · '+humanSize(file.size);
  $('checkBtn').disabled=!(state.comments&&state.old&&state.new);
}
for(const target of ['comments','old','new']){
  const zone=document.querySelector('[data-target="'+target+'"]'),input=$(target+'File');
  zone.addEventListener('click',()=>input.click());
  zone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')input.click();});
  input.addEventListener('change',()=>setFile(target,input.files[0]));
  ['dragenter','dragover'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove('drag');}));
  zone.addEventListener('drop',e=>setFile(target,e.dataTransfer.files[0]));
}

let pdfJsPromise;
async function loadPdfJs(){
  if(!pdfJsPromise)pdfJsPromise=import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(pdfjs=>{
    pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';return pdfjs;
  });
  return pdfJsPromise;
}
const scriptPromises=new Map();
function loadScript(src){
  if(scriptPromises.has(src))return scriptPromises.get(src);
  const p=new Promise((resolve,reject)=>{
    const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error('依赖加载失败：'+src));document.head.appendChild(s);
  });
  scriptPromises.set(src,p);return p;
}
function extractTextItem(item,raw){
  const x=Number(item.transform?.[4]||0),y=Number(item.transform?.[5]||0),w=Number(item.width||0),h=Math.abs(Number(item.height||item.transform?.[3]||0));
  return {str:String(item.str||'').trim(),x:clamp(x/raw.width),y:clamp(1-y/raw.height),w:clamp(w/raw.width),h:clamp(h/raw.height)};
}
async function scanPdf(file){
  const pdfjs=await loadPdfJs(),pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const pages=[];
  for(let i=1;i<=Math.min(pdf.numPages,MAX_SCAN);i++){
    const page=await pdf.getPage(i),raw=page.getViewport({scale:1});
    let textItems=[],textRaw='';
    try{
      const tc=await page.getTextContent({normalizeWhitespace:true,disableCombineTextItems:false});
      textItems=mergeTextItems(tc.items.map(x=>extractTextItem(x,raw)).filter(x=>x.str));
      textRaw=textItems.map(x=>x.str).join(' | ');
    }catch{}
    pages.push({pageNumber:i,sheetId:detectSheetId(textRaw),textItems,textRaw});
  }
  return {name:file.name,type:'pdf',sourcePages:pdf.numPages,scannedPages:pages.length,pages,pdf};
}
async function scanImage(file){
  const bitmap=await createImageBitmap(file),scale=Math.min(1,PAGE_MAX_SIDE/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return {name:file.name,type:'image',sourcePages:1,scannedPages:1,pages:[{pageNumber:1,sheetId:null,textItems:[],textRaw:'',canvas}],pdf:null};
}
async function scanDrawing(file){return file.type==='application/pdf'?scanPdf(file):scanImage(file);}

async function renderPage(doc,index){
  const meta=doc.pages[index];
  if(meta.canvas)return {image:jpeg(meta.canvas),textRaw:meta.textRaw||''};
  const page=await doc.pdf.getPage(index+1),raw=page.getViewport({scale:1}),scale=Math.min(1.9,PAGE_MAX_SIDE/Math.max(raw.width,raw.height)),vp=page.getViewport({scale});
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);
  const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:ctx,viewport:vp,background:'white'}).promise;
  return {image:jpeg(canvas),textRaw:meta.textRaw||''};
}

function groupPdfLines(items){
  const rows=[];
  for(const item of items){
    const s=String(item.str||'').trim();if(!s)continue;
    const y=Number(item.transform?.[5]||0),x=Number(item.transform?.[4]||0);
    let row=rows.find(r=>Math.abs(r.y-y)<=4);
    if(!row){row={y,items:[]};rows.push(row);}
    row.items.push({x,s});
  }
  return rows.sort((a,b)=>b.y-a.y).map(r=>r.items.sort((a,b)=>a.x-b.x).map(x=>x.s).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean);
}
async function commentsFromPdf(file){
  const pdfjs=await loadPdfJs(),pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise,lines=[];
  for(let i=1;i<=Math.min(pdf.numPages,30);i++){
    const page=await pdf.getPage(i),tc=await page.getTextContent({normalizeWhitespace:true,disableCombineTextItems:false});
    lines.push(...groupPdfLines(tc.items));
  }
  return lines;
}
async function commentsFromDocx(file){
  await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js');
  if(!window.mammoth)throw new Error('DOCX 解析组件未加载');
  const r=await window.mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()});
  return String(r.value||'').split(/\r?\n+/);
}
async function commentsFromXlsx(file){
  await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  if(!window.XLSX)throw new Error('XLSX 解析组件未加载');
  const wb=window.XLSX.read(await file.arrayBuffer(),{type:'array'}),lines=[];
  for(const name of wb.SheetNames){
    const rows=window.XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:false,defval:''});
    for(const row of rows){
      const line=row.map(x=>String(x||'').trim()).filter(Boolean).join(' | ');
      if(line)lines.push(line);
    }
  }
  return lines;
}
async function parseCommentsFile(file){
  const n=file.name.toLowerCase();
  let lines=[];
  if(file.type==='application/pdf'||n.endsWith('.pdf'))lines=await commentsFromPdf(file);
  else if(n.endsWith('.docx'))lines=await commentsFromDocx(file);
  else if(/\.(xlsx|xls)$/i.test(n))lines=await commentsFromXlsx(file);
  else lines=(await file.text()).split(/\r?\n+/);
  const comments=parseCommentLines(lines);
  if(!comments.length)throw new Error('没有从意见文件中识别到可核对的意见。建议使用编号列表、Excel逐行或清晰PDF。');
  return {name:file.name,comments,rawLineCount:lines.length};
}
function selectedPairs(scoredPairs){
  const both=scoredPairs.filter(p=>p.pageA!==null&&p.pageB!==null);
  const positive=both.filter(p=>p.score>0).slice(0,MAX_AI_PAIRS);
  if(positive.length>=Math.min(3,both.length))return positive;
  const ids=new Set(positive.map(p=>p.pageA+'|'+p.pageB));
  for(const p of both){
    if(positive.length>=MAX_AI_PAIRS)break;
    const k=p.pageA+'|'+p.pageB;if(!ids.has(k)){ids.add(k);positive.push(p);}
  }
  return positive;
}
async function buildVisualPairs(oldDoc,newDoc,pairs){
  const out=[];
  for(const p of pairs){
    const [a,b]=await Promise.all([renderPage(oldDoc,p.pageA),renderPage(newDoc,p.pageB)]);
    out.push({
      sheetId:p.sheetId||oldDoc.pages[p.pageA]?.sheetId||newDoc.pages[p.pageB]?.sheetId||null,
      pageA:p.pageA+1,pageB:p.pageB+1,score:p.score||0,
      oldImage:a.image,newImage:b.image,
      oldTextDigest:String(a.textRaw||'').slice(0,5000),
      newTextDigest:String(b.textRaw||'').slice(0,5000)
    });
  }
  return out;
}
function progress(step,title,text){
  $('progressTitle').textContent=title;$('progressText').textContent=text;
  ['p1','p2','p3','p4','p5'].forEach((id,i)=>$(id).classList.toggle('active',i<=step));
}

function statusText(s){return s==='implemented'?'已落实':s==='partial'?'部分落实':s==='not_found'?'未找到落实证据':'无法判定';}
function statusClass(s){return ['implemented','partial','not_found','uncertain'].includes(s)?s:'uncertain';}
function renderClosure(items){
  const el=$('closureList'),filter=state.currentFilter;
  const shown=(items||[]).filter(x=>filter==='all'||x.status===filter);
  if(!shown.length){el.innerHTML='<div class="empty">当前筛选条件下没有意见。</div>';return;}
  el.innerHTML=shown.map(x=>{
    const s=statusClass(x.status),conf=Number.isFinite(Number(x.confidence))?Math.round(Number(x.confidence)*100):null;
    return '<article class="closure-item" data-status="'+s+'">'
      +'<div><div class="closure-status '+s+'">'+statusText(s)+'</div><div class="comment-id">'+esc(x.commentId)+'</div></div>'
      +'<div class="closure-main"><h4>'+esc(x.originalComment)+'</h4>'
      +'<p><b>落实判断：</b>'+esc(x.conclusion||x.evidenceSummary||'需人工复核')+'</p>'
      +'<p><b>修改前：</b>'+esc(x.oldEvidence||'未找到明确证据')+'</p>'
      +'<p><b>修改后：</b>'+esc(x.newEvidence||'未找到明确证据')+'</p>'
      +(x.missingSync?'<p><b>疑似漏同步：</b>'+esc(x.missingSync)+'</p>':'')
      +'<p><b>人工动作：</b>'+esc(x.reviewerAction||'复核相关图纸')+'</p>'
      +'<div class="evidence-row">'+(x.impactedSheets||[]).map(v=>'<span class="sheet-chip">'+esc(v)+'</span>').join('')
      +(x.deterministicIds||[]).map(v=>'<span class="evidence-chip">'+esc(v)+'</span>').join('')+'</div></div>'
      +'<div class="closure-side">'+(conf!==null?'<strong>'+conf+'%</strong>置信':'')+(x.deterministicHint?'<span class="hint">'+esc(x.deterministicHint)+'</span>':'')+'</div>'
      +'</article>';
  }).join('');
}
function renderUnlisted(items){
  const el=$('unlistedCards');
  if(!items?.length){el.innerHTML='<div class="empty">没有识别到需要单独提醒的额外变更。</div>';return;}
  el.innerHTML=items.map(x=>'<article class="unlisted"><h4>'+esc(x.location||'位置待确认')+' · '+esc(x.category||'额外变更')+'</h4><p>'+esc(x.change||x.issue||'')+'</p><p><b>证据：</b>'+esc(x.evidence||'需人工复核')+'</p><p><b>建议：</b>'+esc(x.action||'确认是否为授权变更')+'</p></article>').join('');
}
function renderResult(data,local){
  const r=data.result||{};state.latest={...data,local:{timing:local.timing,selectedPairs:local.visualPairs.map(({oldImage,newImage,...x})=>x)}};
  $('summaryText').textContent=r.summary||'意见落实检查完成';$('overallText').textContent=r.overall||'请查看逐条闭环矩阵。';
  const c=r.counts||{},total=c.total??r.items?.length??0,done=c.implemented??0;
  $('totalCount').textContent=total;$('doneCount').textContent=done;$('partialCount').textContent=c.partial??0;$('missingCount').textContent=c.notFound??0;$('uncertainCount').textContent=c.uncertain??0;
  const rate=total?Math.round(done/total*100):0;$('closureRate').textContent=rate+'%';$('closureFill').style.width=rate+'%';
  const mode=r.analysisMode||local.det.textCoverage.mode;$('analysisMode').className='mode '+(mode==='hybrid'?'hybrid':'visual');$('analysisMode').textContent=mode==='hybrid'?'HYBRID · 意见 + 精确Diff + M3证据判定':'VISUAL · 文字层不足';
  const usage=data.usage||{};$('runtimeMeta').textContent='模型 '+(data.model||'MiniMax-M3')+' · '+(usage.total_tokens?('Token '+Number(usage.total_tokens).toLocaleString()+' · '):'')+'意见 '+total+' 条 · 精确Diff '+local.det.textChanges.length+' 条 · AI查看 '+local.visualPairs.length+' 组页面 · 总耗时 '+(local.timing.totalMs/1000).toFixed(1)+'s';
  renderClosure(r.items||[]);renderUnlisted(r.unlistedChanges||[]);
  const cl=Array.isArray(r.checklist)?r.checklist:[];$('checklist').innerHTML=cl.length?cl.map(x=>'<li>'+esc(x)+'</li>').join(''):'<li>优先复核部分落实、未找到和无法判定项。</li>';
  const lm=Array.isArray(r.limitations)?r.limitations:[];$('limitations').innerHTML=lm.length?lm.map(x=>'<li>'+esc(x)+'</li>').join(''):'<li>最终以原始图纸和总工人工复核为准。</li>';
}
function csvEscape(v){const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function download(name,content,type){
  const blob=new Blob([content],{type}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

$('checkBtn').addEventListener('click',async()=>{
  const btn=$('checkBtn');btn.disabled=true;$('results').classList.add('hidden');$('progress').classList.remove('hidden');$('progress').scrollIntoView({behavior:'smooth',block:'center'});
  const t0=performance.now();
  try{
    progress(0,'正在拆分总工意见…','把 PDF / Word / Excel / 文本意见拆成 C001 / C002...，并抽取图号、门窗号、房间号和数值条件。');
    const commentsData=await parseCommentsFile(state.comments);

    progress(1,'正在扫描修改前后图纸…','先扫前 30 页 PDF 文字层，按图号配对页面并生成精确文字/数字 Diff。');
    const [oldDoc,newDoc]=await Promise.all([scanDrawing(state.old),scanDrawing(state.new)]);
    const pairs=pairPages(oldDoc.pages,newDoc.pages),det=summarizeDeterministicDiff(oldDoc.pages,newDoc.pages,pairs);

    progress(2,'正在把每条意见匹配到变化证据…','程序先把 Cxxx 和 Txxx 对上；再按意见关联度挑选最多 8 组 A/B 页面给 M3。');
    const evidence=buildCommentEvidence(commentsData.comments,det.textChanges);
    const scored=scorePagePairsForComments(commentsData.comments,evidence,pairs,det.textChanges);
    const selected=selectedPairs(scored),visualPairs=await buildVisualPairs(oldDoc,newDoc,selected);

    progress(3,'MiniMax M3 正在逐条判定…','“已落实”必须有正向证据；只改一部分判部分落实；找不到证据不能硬说完成。');
    const apiStart=performance.now();
    const resp=await fetch('/api/comment-check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      projectName:$('projectName').value.trim(),notes:$('notes').value.trim(),
      comments:{name:commentsData.name,items:commentsData.comments},
      drawing:{
        old:{name:oldDoc.name,sourcePages:oldDoc.sourcePages,scannedPages:oldDoc.scannedPages},
        new:{name:newDoc.name,sourcePages:newDoc.sourcePages,scannedPages:newDoc.scannedPages},
        pagePairs:pairs.map(p=>({pageA:p.pageA,pageB:p.pageB,sheetId:p.sheetId,method:p.method})),
        selectedPairs:visualPairs
      },
      deterministic:{textCoverage:det.textCoverage,textChanges:det.textChanges.slice(0,220),commentEvidence:evidence}
    })});
    const data=await resp.json();if(!resp.ok)throw new Error(data.error||'意见落实检查失败');

    progress(4,'正在生成闭环矩阵…','整理逐条状态、证据、疑似漏同步和人工复核动作。');
    const timing={apiMs:Math.round(performance.now()-apiStart),totalMs:Math.round(performance.now()-t0)};
    state.currentFilter='all';document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x.dataset.filter==='all'));
    renderResult(data,{det,visualPairs,timing});
    $('progress').classList.add('hidden');$('results').classList.remove('hidden');$('results').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){$('progress').classList.add('hidden');alert('检查失败：'+(e.message||e));}
  finally{btn.disabled=!(state.comments&&state.old&&state.new);}
});
document.querySelectorAll('.filter').forEach(btn=>btn.addEventListener('click',()=>{
  state.currentFilter=btn.dataset.filter;document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x===btn));renderClosure(state.latest?.result?.items||[]);
}));
$('resetBtn').addEventListener('click',()=>{$('results').classList.add('hidden');$('workspace').scrollIntoView({behavior:'smooth',block:'start'});});
$('printBtn').addEventListener('click',()=>window.print());
$('jsonBtn').addEventListener('click',()=>{if(state.latest)download('agent-hong-comment-closure-'+Date.now()+'.json',JSON.stringify(state.latest,null,2),'application/json');});
$('csvBtn').addEventListener('click',()=>{
  const items=state.latest?.result?.items||[];if(!items.length)return;
  const rows=[['意见ID','原始意见','状态','置信度','涉及图纸','落实判断','修改前证据','修改后证据','疑似漏同步','确定性证据','人工复核动作']];
  for(const x of items)rows.push([x.commentId,x.originalComment,statusText(x.status),Math.round((Number(x.confidence)||0)*100)+'%',(x.impactedSheets||[]).join(' '),x.conclusion||'',x.oldEvidence||'',x.newEvidence||'',x.missingSync||'',(x.deterministicIds||[]).join(' '),x.reviewerAction||'']);
  download('agent-hong-comment-closure-'+Date.now()+'.csv','\ufeff'+rows.map(r=>r.map(csvEscape).join(',')).join('\n'),'text/csv;charset=utf-8');
});
checkHealth();
