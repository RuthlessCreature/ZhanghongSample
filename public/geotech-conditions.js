import {buildGeotechEvidence,selectGeotechEvidence,summarizeGeotechCoverage,GEOTECH_KEYS} from './geotech-core.js';

const $=id=>document.getElementById(id);
const state={files:[],evidence:[],latest:null};
const MAX_PAGES=120;
const LABELS={
  site_class:"场地类别",seismic:"抗震/地震参数",groundwater:"地下水",soil_layers:"土层/地层",
  bearing_capacity:"地基承载力",pile_conditions:"桩基/持力层",liquefaction:"液化",
  corrosion:"腐蚀性",adverse_geology:"不良地质",excavation:"基坑/开挖",
  dewatering:"降水/抗浮",exploration:"勘探孔/孔深"
};
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
function setFiles(fs){state.files=[...fs].filter(f=>f.type==='application/pdf'||f.type==='text/plain'||/\.(pdf|txt)$/i.test(f.name));$('geoInfo').textContent=state.files.length?state.files.map(f=>f.name).join('；'):'尚未选择文件';$('extractBtn').disabled=!state.files.length}
const drop=$('geoDrop'),input=$('geoFiles');drop.onclick=()=>input.click();input.onchange=()=>setFiles(input.files);drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();setFiles(e.dataTransfer.files)};

let pdfp;async function pdfjs(){if(!pdfp)pdfp=import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(p=>{p.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';return p});return pdfp}
function rowsFromItems(items){const rows=[];for(const it of items){const s=String(it.str||'').trim();if(!s)continue;const y=Number(it.transform?.[5]||0),x=Number(it.transform?.[4]||0);let r=rows.find(z=>Math.abs(z.y-y)<=4);if(!r){r={y,items:[]};rows.push(r)}r.items.push({x,s})}return rows.sort((a,b)=>b.y-a.y).map(r=>r.items.sort((a,b)=>a.x-b.x).map(x=>x.s).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean)}
async function parseFile(file,idx){if(file.type==='text/plain'||/\.txt$/i.test(file.name))return {documentId:'geo'+idx,name:file.name,pages:[{pageNumber:1,lines:(await file.text()).split(/\r?\n+/)}],sourcePages:1,scannedPages:1};
 const p=await pdfjs(),doc=await p.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise,pages=[];for(let i=1;i<=Math.min(doc.numPages,MAX_PAGES);i++){const pg=await doc.getPage(i);let lines=[];try{const tc=await pg.getTextContent({normalizeWhitespace:true,disableCombineTextItems:false});lines=rowsFromItems(tc.items)}catch{}pages.push({pageNumber:i,lines})}return {documentId:'geo'+idx,name:file.name,pages,sourcePages:doc.numPages,scannedPages:pages.length}}
function renderCoverage(cov){const el=$('coverageGrid');el.innerHTML=GEOTECH_KEYS.map(k=>'<div class="coverage-chip '+(cov.found[k]?'found':'missing')+'"><b>'+esc(LABELS[k])+'</b><span>'+(cov.found[k]?cov.found[k]+' 条证据':'未找到')+'</span></div>').join('');$('coveredCount').textContent=cov.covered+'/'+cov.totalKeys}
function renderEvidence(ev){$('evidenceList').innerHTML=ev.length?ev.map(x=>'<article class="geo-evidence" id="ev-'+esc(x.id.replace(/[^A-Za-z0-9_-]/g,'-'))+'"><div class="gid">'+esc(x.id)+'<br>P'+x.pageNumber+'</div><div class="cat">'+esc(LABELS[x.key]||x.label)+'</div><p>'+esc(x.text)+'</p></article>').join(''):'<div class="empty">未抽取到地勘证据。</div>'}
function renderConditions(conditions){$('conditionList').innerHTML=conditions.map(x=>'<article class="condition '+esc(x.status)+'"><div><div class="status">'+esc(x.status)+'</div><div class="key">'+esc(LABELS[x.key]||x.key)+'</div></div><div><h4>'+esc(x.value)+'</h4><p><b>设计含义：</b>'+esc(x.designImplication)+'</p><div class="cite-row">'+(x.citations||[]).map(id=>'<button class="cite" data-cite="'+esc(id)+'">'+esc(id)+'</button>').join('')+'</div></div><div class="side"><strong>'+Math.round((x.confidence||0)*100)+'%</strong>'+(x.pages?.length?'P'+x.pages.join(', P'):'无页码')+'</div></article>').join('');
 $('conditionList').querySelectorAll('[data-cite]').forEach(b=>b.onclick=()=>{const e=state.evidence.find(x=>x.id===b.dataset.cite);if(e)alert((LABELS[e.key]||e.label)+' · '+e.documentName+' · P'+e.pageNumber+'\n\n'+e.text)})}
function download(name,content){const blob=new Blob([content],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)}
function progress(title,text){$('progressTitle').textContent=title;$('progressText').textContent=text}
$('extractBtn').onclick=async()=>{if(!state.files.length)return;const t0=performance.now();$('extractBtn').disabled=true;$('results').classList.add('hidden');$('progress').classList.remove('hidden');$('progress').scrollIntoView({behavior:'smooth'});try{
 progress('正在读取报告文字层…','扫描数字 PDF / TXT，不上传原始文件。');
 const docs=[];for(let i=0;i<state.files.length;i++){progress('正在读取 '+state.files[i].name,'文件 '+(i+1)+' / '+state.files.length);docs.push(await parseFile(state.files[i],i+1))}
 progress('正在抽取地勘硬证据…','先按地下水、承载力、桩基、腐蚀性等类别抓原文。');
 let evidence=[];for(const d of docs)evidence.push(...buildGeotechEvidence(d.pages,{documentId:d.documentId,documentName:d.name}));
 state.evidence=evidence;const selected=selectGeotechEvidence(evidence,36),coverage=summarizeGeotechCoverage(evidence);
 renderCoverage(coverage);renderEvidence(evidence);
 progress('MiniMax M3 正在整理设计条件…','模型只能使用 Gxxxx 证据，不能补造报告中不存在的数值。');
 const r=await fetch('/api/geotech-conditions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
   projectName:$('projectName').value.trim(),notes:$('notes').value.trim(),
   documents:docs.map(d=>({documentId:d.documentId,name:d.name,sourcePages:d.sourcePages,scannedPages:d.scannedPages})),
   coverage,candidates:selected
 })});const data=await r.json();if(!r.ok)throw new Error(data.error||'地勘条件整理失败');
 state.latest=data;renderConditions(data.result.conditions||[]);$('summary').textContent=data.result.summary||'地勘设计条件提取完成';$('overall').textContent=data.result.overall||'请复核各条件及原报告。';
 $('runtimeMeta').textContent='模型 '+(data.model||'MiniMax-M3')+' · Token '+(data.usage?.total_tokens||0)+' · 确定性证据 '+evidence.length+' 条 · M3候选 '+selected.length+' 条 · '+((performance.now()-t0)/1000).toFixed(1)+'s';
 $('checklist').innerHTML=(data.result.checklist||[]).map(x=>'<li>'+esc(x)+'</li>').join('')||'<li>回看原始地勘报告并由岩土/结构专业确认。</li>';
 $('limitations').innerHTML=(data.result.limitations||[]).map(x=>'<li>'+esc(x)+'</li>').join('')||'<li>仅基于已扫描文字层。</li>';
 $('progress').classList.add('hidden');$('results').classList.remove('hidden');$('results').scrollIntoView({behavior:'smooth'});
 }catch(e){$('progress').classList.add('hidden');alert('提取失败：'+(e.message||e))}finally{$('extractBtn').disabled=!state.files.length}};
$('jsonBtn').onclick=()=>{if(state.latest)download('agent-hong-geotech-conditions-'+Date.now()+'.json',JSON.stringify({...state.latest,evidence:state.evidence},null,2))};
$('printBtn').onclick=()=>window.print();$('resetBtn').onclick=()=>{$('results').classList.add('hidden');window.scrollTo({top:0,behavior:'smooth'})};
async function health(){try{const r=await fetch('/api/health',{cache:'no-store'}),d=await r.json(),el=$('serviceStatus');el.className='status '+(d.ok&&d.configured?'ok':'warn');el.innerHTML='<span></span> '+(d.ok?'Module 06 已就绪':'服务状态未知')}catch{}}
health();