import {buildHistoryRecord,searchHistory,summarizeLibrary} from './history-core.js';

const $=id=>document.getElementById(id);
const DB_NAME='agent-hong-history-v1',DB_VERSION=1,STORE='records';
const MAX_PAGES_PER_FILE=100,THUMB_MAX=620;
const state={files:[],records:[],projects:[],lastResults:[]};

async function health(){
  const el=$('serviceStatus');
  try{
    const r=await fetch('/api/health',{cache:'no-store'}),d=await r.json();
    if(d.ok&&d.configured){el.className='status ok';el.innerHTML='<span></span> Module 04 已就绪';}
    else{el.className='status warn';el.innerHTML='<span></span> 本机检索可用 / AI未配置';}
  }catch{el.className='status warn';el.innerHTML='<span></span> 本机检索可用';}
}

function openDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(STORE)){
        const s=db.createObjectStore(STORE,{keyPath:'id'});
        s.createIndex('projectId','projectId',{unique:false});
        s.createIndex('importedAt','importedAt',{unique:false});
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function dbGetAll(){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).getAll();
    req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);
  });
}
async function dbPutMany(records){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE);
    for(const r of records)s.put(r);
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
}
async function dbDeleteProject(projectId){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite'),idx=tx.objectStore(STORE).index('projectId'),req=idx.openCursor(IDBKeyRange.only(projectId));
    req.onsuccess=()=>{const c=req.result;if(c){c.delete();c.continue();}};
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
}
async function dbClear(){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite'),req=tx.objectStore(STORE).clear();
    req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);
  });
}

const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
function humanSize(n){return n<1024*1024?Math.round(n/1024)+' KB':(n/1024/1024).toFixed(1)+' MB';}
function download(name,content,type='application/json'){
  const b=new Blob([content],{type}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

let pdfJsPromise;
async function pdfjs(){
  if(!pdfJsPromise)pdfJsPromise=import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(p=>{
    p.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';return p;
  });
  return pdfJsPromise;
}

function mergeRows(items,raw){
  const pts=items.map(it=>({
    s:String(it.str||'').trim(),x:Number(it.transform?.[4]||0)/raw.width,y:1-Number(it.transform?.[5]||0)/raw.height
  })).filter(x=>x.s).sort((a,b)=>a.y-b.y||a.x-b.x);
  const rows=[];
  for(const p of pts){
    let row=rows.find(r=>Math.abs(r.y-p.y)<.007);
    if(!row){row={y:p.y,items:[]};rows.push(row);}
    row.items.push(p);
  }
  return rows.sort((a,b)=>a.y-b.y).map(r=>r.items.sort((a,b)=>a.x-b.x).map(x=>x.s).join(' ')).join(' | ');
}

async function pageThumb(page){
  const raw=page.getViewport({scale:1}),scale=Math.min(1,THUMB_MAX/Math.max(raw.width,raw.height)),vp=page.getViewport({scale});
  const c=document.createElement('canvas');c.width=Math.max(1,Math.ceil(vp.width));c.height=Math.max(1,Math.ceil(vp.height));
  const ctx=c.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
  await page.render({canvasContext:ctx,viewport:vp,background:'white'}).promise;
  return c.toDataURL('image/jpeg',.48);
}

async function indexPdf(file,meta,onProgress){
  const p=await pdfjs(),doc=await p.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const count=Math.min(doc.numPages,MAX_PAGES_PER_FILE),records=[];
  for(let i=1;i<=count;i++){
    const page=await doc.getPage(i),raw=page.getViewport({scale:1});
    let text='';
    try{const tc=await page.getTextContent({normalizeWhitespace:true,disableCombineTextItems:false});text=mergeRows(tc.items,raw);}catch{}
    const thumb=await pageThumb(page);
    records.push(buildHistoryRecord({
      id:meta.projectId+'|'+file.name+'|'+i,
      projectId:meta.projectId,projectName:meta.projectName,projectYear:meta.projectYear,
      fileName:file.name,pageNumber:i,text,thumbnail:thumb,importedAt:meta.importedAt
    }));
    onProgress?.(i,count);
  }
  return {records,sourcePages:doc.numPages,indexedPages:count};
}

function setFiles(files){
  state.files=[...files].filter(f=>f.type==='application/pdf'||/\.pdf$/i.test(f.name));
  $('historyInfo').textContent=state.files.length?state.files.map(f=>f.name+' · '+humanSize(f.size)).join('；'):'尚未选择文件';
  $('importBtn').disabled=!state.files.length;
}
const drop=$('historyDrop'),input=$('historyFiles');
drop.addEventListener('click',()=>input.click());
drop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')input.click();});
input.addEventListener('change',()=>setFiles(input.files));
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('drag');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag');}));
drop.addEventListener('drop',e=>setFiles(e.dataTransfer.files));

function buildProjects(records){
  const map=new Map();
  for(const r of records){
    if(!map.has(r.projectId))map.set(r.projectId,{id:r.projectId,name:r.projectName,year:r.projectYear,files:new Set(),pages:0,importedAt:r.importedAt});
    const p=map.get(r.projectId);p.files.add(r.fileName);p.pages++;p.importedAt=Math.max(p.importedAt||0,r.importedAt||0);
  }
  return [...map.values()].map(p=>({...p,files:[...p.files]})).sort((a,b)=>(b.year||0)-(a.year||0)||b.importedAt-a.importedAt);
}
function roleName(r){return ({plan:'平面',elevation:'立面',section:'剖面',detail:'详图/节点',schedule:'门窗表',notes:'说明',other:'其他'})[r]||r;}
function refreshFilters(){
  const project=$('projectFilter'),year=$('yearFilter'),currentP=project.value,currentY=year.value;
  project.innerHTML='<option value="">全部项目</option>'+state.projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
  const years=[...new Set(state.records.map(r=>r.projectYear).filter(Boolean))].sort((a,b)=>b-a);
  year.innerHTML='<option value="">全部年份</option>'+years.map(y=>'<option value="'+y+'">'+y+'</option>').join('');
  if([...project.options].some(o=>o.value===currentP))project.value=currentP;
  if([...year.options].some(o=>o.value===currentY))year.value=currentY;
}
function renderStats(){
  const s=summarizeLibrary(state.records);
  $('statProjects').textContent=s.projects;$('statFiles').textContent=s.files;$('statPages').textContent=s.pages;
  $('statYears').textContent=s.oldestYear?(s.oldestYear===s.newestYear?String(s.oldestYear):s.oldestYear+'–'+s.newestYear):'—';
}
function renderProjects(){
  const el=$('projectList');
  if(!state.projects.length){el.innerHTML='<div class="empty-history">还没有历史项目。</div>';return;}
  el.innerHTML=state.projects.map(p=>'<article class="project-card"><div><h4>'+esc(p.name)+'</h4><p>'+(p.year||'年份未填')+' · '+p.files.length+' 个 PDF · '+p.pages+' 页索引</p></div><button data-del="'+esc(p.id)+'">删除项目</button></article>').join('');
  el.querySelectorAll('[data-del]').forEach(btn=>btn.addEventListener('click',async()=>{
    const p=state.projects.find(x=>x.id===btn.dataset.del);
    if(!confirm('删除本机索引项目“'+(p?.name||'')+'”？原始 PDF 不受影响。'))return;
    await dbDeleteProject(btn.dataset.del);await reload();
  }));
}
async function reload(){
  state.records=await dbGetAll();state.projects=buildProjects(state.records);renderStats();refreshFilters();renderProjects();
  $('searchStatus').textContent=state.records.length?'已载入 '+state.records.length+' 页本机索引。':'本机历史库为空，请先导入项目。';
}

$('importBtn').addEventListener('click',async()=>{
  const projectName=$('projectName').value.trim();
  if(!projectName)return alert('先填写项目名称。');
  const yearRaw=$('projectYear').value.trim(),projectYear=/^\d{4}$/.test(yearRaw)?Number(yearRaw):null;
  const projectId='p_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8),importedAt=Date.now();
  $('importBtn').disabled=true;$('indexProgress').classList.remove('hidden');
  const batch=[];
  try{
    for(let fi=0;fi<state.files.length;fi++){
      const file=state.files[fi];
      $('indexTitle').textContent='正在索引 '+file.name;
      const result=await indexPdf(file,{projectId,projectName,projectYear,importedAt},(i,count)=>{
        const overall=(fi+i/count)/state.files.length;$('indexFill').style.width=Math.round(overall*100)+'%';
        $('indexText').textContent='文件 '+(fi+1)+' / '+state.files.length+' · 第 '+i+' / '+count+' 页';
      });
      batch.push(...result.records);
    }
    await dbPutMany(batch);$('indexFill').style.width='100%';$('indexTitle').textContent='索引完成';$('indexText').textContent='新增 '+batch.length+' 页。';
    state.files=[];input.value='';$('historyInfo').textContent='尚未选择文件';await reload();
    setTimeout(()=>$('indexProgress').classList.add('hidden'),1200);
  }catch(e){alert('建立索引失败：'+(e.message||e));}
  finally{$('importBtn').disabled=!state.files.length;}
});

$('exportBtn').addEventListener('click',async()=>{
  const records=await dbGetAll();if(!records.length)return alert('历史库为空。');
  download('agent-hong-history-index-'+Date.now()+'.json',JSON.stringify({version:1,product:'Agent Hong Module 04',exportedAt:new Date().toISOString(),records},null,2));
});
$('importIndexFile').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{
    const data=JSON.parse(await file.text()),records=Array.isArray(data)?data:data.records;
    if(!Array.isArray(records)||!records.length)throw new Error('备份中没有 records');
    const safe=records.filter(r=>r&&r.id&&r.projectId&&r.fileName&&Number.isFinite(Number(r.pageNumber))).slice(0,20000);
    await dbPutMany(safe);await reload();alert('已导入 '+safe.length+' 页索引。');
  }catch(err){alert('导入索引失败：'+(err.message||err));}
  e.target.value='';
});
$('clearBtn').addEventListener('click',async()=>{
  if(!state.records.length)return;
  if(!confirm('确定清空当前浏览器里的全部历史图纸索引？建议先导出备份。'))return;
  await dbClear();state.lastResults=[];$('results').innerHTML='';await reload();
});

function filters(){
  return {projectId:$('projectFilter').value||null,role:$('roleFilter').value||'all',year:$('yearFilter').value||null};
}
function reservoir(local){
  const ids=new Set(local.map(x=>x.id)),f=filters();
  const extra=state.records.filter(r=>{
    if(ids.has(r.id))return false;
    if(f.projectId&&r.projectId!==f.projectId)return false;
    if(f.role&&f.role!=='all'&&r.role!==f.role)return false;
    if(f.year&&Number(r.projectYear)!==Number(f.year))return false;
    return true;
  }).sort((a,b)=>(b.importedAt||0)-(a.importedAt||0)).slice(0,Math.max(0,60-local.length));
  return [...local.slice(0,30),...extra].slice(0,60);
}
async function aiRerank(query,candidates){
  if(!candidates.length)return null;
  const payload={
    query,
    candidates:candidates.map(r=>({
      id:r.id,projectName:r.projectName,projectYear:r.projectYear,fileName:r.fileName,pageNumber:r.pageNumber,
      sheetId:r.sheetId,sheetTitle:r.sheetTitle,role:r.role,
      deterministicScore:Number(r.searchScore||0),
      text:String(r.text||'').slice(0,900)
    }))
  };
  const resp=await fetch('/api/history-search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const data=await resp.json();if(!resp.ok)throw new Error(data.error||'AI 重排失败');
  return data;
}
function renderResults(results,aiMeta){
  const el=$('results');state.lastResults=results;
  if(!results.length){el.innerHTML='<div class="empty-history">没有找到匹配页。可以换关键词、取消筛选，或导入更多历史项目。</div>';return;}
  el.innerHTML=results.map((r,i)=>'<article class="history-hit" data-id="'+esc(r.id)+'">'
    +(r.thumbnail?'<img class="hit-thumb" src="'+r.thumbnail+'" alt="页缩略图">':'<div class="hit-thumb"></div>')
    +'<div class="hit-main"><div class="hit-meta"><span>'+esc(r.projectName)+'</span><span>'+(r.projectYear||'年份未填')+'</span><span>'+esc(roleName(r.role))+'</span></div>'
    +'<h3>'+(esc(r.sheetId||'图号未识别'))+' · '+esc(r.sheetTitle||r.fileName)+'</h3>'
    +'<p>'+esc(r.fileName)+' · 第 '+r.pageNumber+' 页</p><p>'+esc(r.snippet||String(r.text||'').slice(0,260))+'</p>'
    +'<div class="hit-meta">'+(r.matchReasons||[]).map(x=>'<span class="match-chip">'+esc(x)+'</span>').join('')+'</div></div>'
    +'<div class="hit-side"><strong>#'+(i+1)+'</strong><span>本机 '+Number(r.searchScore||0).toFixed(1)+'</span>'
    +(r.aiRelevance!==undefined?'<span class="ai">M3 '+Math.round(r.aiRelevance*100)+'%</span>':'')+'</div></article>').join('');
  el.querySelectorAll('.history-hit').forEach(card=>card.addEventListener('click',()=>openPreview(card.dataset.id)));
}
function openPreview(id){
  const r=state.records.find(x=>x.id===id);if(!r)return;
  $('previewTitle').textContent=(r.sheetId||'图号未识别')+' · '+(r.sheetTitle||r.fileName);
  $('previewMeta').textContent=r.projectName+' · '+(r.projectYear||'年份未填')+' · '+r.fileName+' · 第 '+r.pageNumber+' 页';
  $('previewImage').src=r.thumbnail||'';$('previewImage').classList.toggle('hidden',!r.thumbnail);
  $('previewText').textContent=r.text||'（无可提取文字层）';$('preview').classList.remove('hidden');
}
$('previewClose').addEventListener('click',()=>$('preview').classList.add('hidden'));
$('previewMask').addEventListener('click',()=>$('preview').classList.add('hidden'));

async function doSearch(){
  const q=$('query').value.trim();if(!q)return;
  const t0=performance.now();$('searchBtn').disabled=true;$('searchStatus').textContent='正在检索…';$('searchTiming').textContent='';
  try{
    const local=searchHistory(state.records,q,filters(),30);
    let results=local,aiData=null;
    if($('aiToggle').checked&&state.records.length){
      try{
        const candidates=reservoir(local);
        aiData=await aiRerank(q,candidates);
        const aiMap=new Map((aiData?.ranked||[]).map(x=>[x.id,x]));
        const combined=[...candidates].map(r=>{
          const localHit=local.find(x=>x.id===r.id)||r,ai=aiMap.get(r.id);
          return {...localHit,searchScore:Number(localHit.searchScore||0),matchReasons:localHit.matchReasons||[],snippet:localHit.snippet||String(r.text||'').slice(0,260),aiRelevance:ai?Number(ai.relevance):undefined,aiReason:ai?.reason||''};
        }).filter(r=>r.searchScore>0||r.aiRelevance>=.35)
          .sort((a,b)=>(Number(b.aiRelevance??-.1)-Number(a.aiRelevance??-.1))||(b.searchScore-a.searchScore))
          .slice(0,30);
        results=combined;
      }catch(e){console.warn('AI rerank failed',e);$('searchStatus').textContent='M3 重排失败，已回退到本机检索：'+(e.message||e);}
    }
    renderResults(results,aiData);
    if(!$('searchStatus').textContent.startsWith('M3 重排失败'))$('searchStatus').textContent='找到 '+results.length+' 个候选页'+(aiData?'，已由 M3 对候选重排。':'。');
    $('searchTiming').textContent=(performance.now()-t0).toFixed(0)+' ms';
  }finally{$('searchBtn').disabled=false;}
}
$('searchBtn').addEventListener('click',doSearch);
$('query').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
document.querySelectorAll('[data-q]').forEach(b=>b.addEventListener('click',()=>{$('query').value=b.dataset.q;doSearch();}));

health();reload();
