import {detectSheetId, pairPages, summarizeDeterministicDiff} from './diff-core.js';

const $ = (id) => document.getElementById(id);
const state = { A: null, B: null, prepared: null, latestResponse: null };
const MAX_PAGES = 8;
const MAX_FILE = 35 * 1024 * 1024;
const PAGE_MAX_SIDE = 1280;
const REGION_LIMIT = 12;

async function checkHealth() {
  const el = $("serviceStatus");
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const d = await r.json();
    if (d.ok && d.configured) { el.className = "status ok"; el.innerHTML = "<span></span> Hybrid Engine 已就绪"; }
    else { el.className = "status warn"; el.innerHTML = "<span></span> 等待模型配置"; }
  } catch { el.className = "status warn"; el.innerHTML = "<span></span> 服务状态未知"; }
}

function humanSize(n) { return n < 1024*1024 ? `${(n/1024).toFixed(0)} KB` : `${(n/1024/1024).toFixed(1)} MB`; }
function esc(v){ return String(v ?? "").replace(/[&<>'"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
function clamp(n,min=0,max=1){ return Math.max(min,Math.min(max,n)); }

function setFile(side, file) {
  if (!file) return;
  if (file.size > MAX_FILE) return alert("单文件最大 35MB。请先压缩或拆分图纸。");
  const ok = file.type === "application/pdf" || /^image\/(png|jpeg|webp)$/.test(file.type);
  if (!ok) return alert("当前版本支持 PDF / PNG / JPG / WEBP。");
  state[side] = file;
  const zone = document.querySelector(`.dropzone[data-side="${side}"]`);
  zone.classList.add("ready");
  $("info"+side).textContent = `${file.name} · ${humanSize(file.size)}`;
  $("analyzeBtn").disabled = !(state.A && state.B);
}

for (const side of ["A", "B"]) {
  const zone = document.querySelector(`.dropzone[data-side="${side}"]`);
  const input = $("file"+side);
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", () => setFile(side, input.files[0]));
  ["dragenter","dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("drag"); }));
  ["dragleave","drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("drag"); }));
  zone.addEventListener("drop", e => setFile(side, e.dataTransfer.files[0]));
}

let pdfJsPromise;
async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs").then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

function canvasToJpeg(canvas, quality=.70) { return canvas.toDataURL("image/jpeg", quality); }

function extractTextItem(item, rawViewport) {
  const x = Number(item.transform?.[4] || 0);
  const y = Number(item.transform?.[5] || 0);
  const w = Number(item.width || 0);
  const h = Math.abs(Number(item.height || item.transform?.[3] || 0));
  return {
    str:String(item.str || "").trim(),
    x:clamp(x / rawViewport.width),
    y:clamp(1 - y / rawViewport.height),
    w:clamp(w / rawViewport.width),
    h:clamp(h / rawViewport.height)
  };
}

async function renderPdfPage(page, pageNumber) {
  const raw = page.getViewport({ scale: 1 });
  const scale = Math.min(2.0, PAGE_MAX_SIDE / Math.max(raw.width, raw.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", {alpha:false});
  ctx.fillStyle="#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({ canvasContext: ctx, viewport, background: "white" }).promise;

  let textItems = [], textRaw = "";
  try {
    const tc = await page.getTextContent({ normalizeWhitespace:true, disableCombineTextItems:false });
    textItems = tc.items.map(x => extractTextItem(x, raw)).filter(x => x.str);
    textRaw = textItems.map(x=>x.str).join(" ");
  } catch {}

  return {
    pageNumber,
    image: canvasToJpeg(canvas),
    canvas,
    width:canvas.width,
    height:canvas.height,
    textItems,
    textRaw,
    sheetId:detectSheetId(textRaw)
  };
}

async function preparePdf(file) {
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const count = Math.min(pdf.numPages, MAX_PAGES);
  const pages=[];
  for (let i=1;i<=count;i++) pages.push(await renderPdfPage(await pdf.getPage(i), i));
  return {name:file.name, type:"pdf", sourcePages:pdf.numPages, pages};
}

async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext("2d",{alpha:false});
  ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return {name:file.name,type:"image",sourcePages:1,pages:[{pageNumber:1,image:canvasToJpeg(canvas),canvas,width:canvas.width,height:canvas.height,textItems:[],textRaw:"",sheetId:null}]};
}

async function prepareFile(file) { return file.type === "application/pdf" ? preparePdf(file) : prepareImage(file); }

function drawNormalized(source, width=640, height=null) {
  const ratio=source.height/source.width;
  const h=height || Math.max(1,Math.round(width*ratio));
  const c=document.createElement("canvas");c.width=width;c.height=h;
  const x=c.getContext("2d",{willReadFrequently:true,alpha:false});x.fillStyle="#fff";x.fillRect(0,0,width,h);x.drawImage(source,0,0,width,h);
  return c;
}

function connectedComponents(mask, cols, rows) {
  const seen=new Uint8Array(mask.length), comps=[];
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
  for(let i=0;i<mask.length;i++){
    if(!mask[i]||seen[i]) continue;
    const q=[i];seen[i]=1;let minX=cols,maxX=0,minY=rows,maxY=0,count=0;
    while(q.length){
      const cur=q.pop(), x=cur%cols,y=Math.floor(cur/cols);count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const [dx,dy] of dirs){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=cols||ny>=rows)continue;const ni=ny*cols+nx;if(mask[ni]&&!seen[ni]){seen[ni]=1;q.push(ni)}}
    }
    comps.push({minX,maxX,minY,maxY,count});
  }
  return comps;
}

function cropComposite(canvasA, canvasB, bbox, titleA="A", titleB="B") {
  const pad=.018;
  const x0=clamp(bbox.x-pad),y0=clamp(bbox.y-pad),x1=clamp(bbox.x+bbox.w+pad),y1=clamp(bbox.y+bbox.h+pad);
  const sxA=x0*canvasA.width, syA=y0*canvasA.height, swA=Math.max(2,(x1-x0)*canvasA.width), shA=Math.max(2,(y1-y0)*canvasA.height);
  const sxB=x0*canvasB.width, syB=y0*canvasB.height, swB=Math.max(2,(x1-x0)*canvasB.width), shB=Math.max(2,(y1-y0)*canvasB.height);
  const half=430, header=26, targetH=Math.min(360,Math.max(120,Math.round(half*(y1-y0)/(x1-x0))));
  const out=document.createElement("canvas");out.width=half*2;out.height=header+targetH;
  const o=out.getContext("2d",{alpha:false});o.fillStyle="#fff";o.fillRect(0,0,out.width,out.height);o.fillStyle="#111";o.fillRect(0,0,out.width,header);
  o.fillStyle="#b8ff32";o.font="bold 13px sans-serif";o.fillText(titleA,10,18);o.fillText(titleB,half+10,18);
  o.drawImage(canvasA,sxA,syA,swA,shA,0,header,half,targetH);o.drawImage(canvasB,sxB,syB,swB,shB,half,header,half,targetH);
  o.strokeStyle="#111";o.lineWidth=2;o.strokeRect(0,header,half,targetH);o.strokeRect(half,header,half,targetH);
  return canvasToJpeg(out,.72);
}

function visualRegionsForPair(pa,pb,pair) {
  if(!pa?.canvas||!pb?.canvas) return [];
  const W=640; const ratio=Math.max(pa.canvas.height/pa.canvas.width,pb.canvas.height/pb.canvas.width); const H=Math.max(200,Math.round(W*ratio));
  const a=drawNormalized(pa.canvas,W,H), b=drawNormalized(pb.canvas,W,H);
  const ad=a.getContext("2d",{willReadFrequently:true}).getImageData(0,0,W,H).data;
  const bd=b.getContext("2d",{willReadFrequently:true}).getImageData(0,0,W,H).data;
  const tile=20,cols=Math.ceil(W/tile),rows=Math.ceil(H/tile),counts=new Uint16Array(cols*rows);
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i=(y*W+x)*4;
    const la=.2126*ad[i]+.7152*ad[i+1]+.0722*ad[i+2], lb=.2126*bd[i]+.7152*bd[i+1]+.0722*bd[i+2];
    const inkA=la<205, inkB=lb<205;
    if((inkA!==inkB) || (inkA&&inkB&&Math.abs(la-lb)>70)) counts[Math.floor(y/tile)*cols+Math.floor(x/tile)]++;
  }
  const active=new Uint8Array(counts.length);
  for(let i=0;i<counts.length;i++) active[i]=counts[i]>=Math.max(8,Math.round(tile*tile*.025))?1:0;
  const comps=connectedComponents(active,cols,rows)
    .filter(c=>c.count>=1)
    .map(c=>{
      const ex=Math.max(0,c.minX-1),ey=Math.max(0,c.minY-1),ex2=Math.min(cols-1,c.maxX+1),ey2=Math.min(rows-1,c.maxY+1);
      const bbox={x:ex*tile/W,y:ey*tile/H,w:Math.min(1,(ex2-ex+1)*tile/W),h:Math.min(1,(ey2-ey+1)*tile/H)};
      let pixels=0;for(let yy=c.minY;yy<=c.maxY;yy++)for(let xx=c.minX;xx<=c.maxX;xx++)pixels+=counts[yy*cols+xx];
      return {bbox,pixels,tileCount:c.count,score:clamp(pixels/Math.max(1,c.count*tile*tile))};
    })
    .filter(c=>c.pixels>=18)
    .sort((x,y)=>y.pixels-x.pixels)
    .slice(0,3);
  return comps.map((c,i)=>({
    id:`V-P${pair.pageA+1}-${i+1}`,
    pageA:pair.pageA+1,pageB:pair.pageB+1,sheetId:pair.sheetId||null,bbox:c.bbox,diffScore:Number(c.score.toFixed(3)),changedPixels:c.pixels,
    image:cropComposite(pa.canvas,pb.canvas,c.bbox,`A · ${pair.sheetId||`P${pair.pageA+1}`}`,`B · ${pair.sheetId||`P${pair.pageB+1}`}`)
  }));
}

function computeVisualEvidence(A,B,pairs) {
  const regions=[];
  for(const pair of pairs){
    if(pair.pageA===null||pair.pageB===null) continue;
    regions.push(...visualRegionsForPair(A.pages[pair.pageA],B.pages[pair.pageB],pair));
  }
  return regions.sort((x,y)=>y.changedPixels-x.changedPixels).slice(0,REGION_LIMIT).map((x,i)=>({...x,id:`V${String(i+1).padStart(3,'0')}`}));
}

function stripPrepared(version){
  return {
    name:version.name,type:version.type,sourcePages:version.sourcePages,
    pages:version.pages.map(p=>{
      const digest=String(p.textRaw||"");
      return {
        pageNumber:p.pageNumber,image:p.image,sheetId:p.sheetId,textItemCount:p.textItems.length,
        textDigest:digest.slice(0,6000),textDigestTruncated:digest.length>6000
      };
    })
  };
}

function deterministicPayload(det, visualRegions){
  return {
    pagePairs:det.pagePairs,
    textCoverage:det.textCoverage,
    textChanges:det.textChanges.slice(0,160),
    visualRegions:visualRegions.map(r=>({id:r.id,pageA:r.pageA,pageB:r.pageB,sheetId:r.sheetId,bbox:r.bbox,diffScore:r.diffScore,image:r.image}))
  };
}

function progress(step,title,text){
  $("progressTitle").textContent=title;$("progressText").textContent=text;
  ["p1","p2","p3","p4"].forEach((id,i)=>$(id).classList.toggle("active",i<=step));
}

function sourceBadge(source){
  if(source==="pdf_text") return '<span class="source exact">程序证据</span>';
  if(source==="mixed") return '<span class="source mixed">混合证据</span>';
  if(source==="visual") return '<span class="source visual">视觉判断</span>';
  return '<span class="source ai">AI判断</span>';
}

function exactChangeCard(x){
  const delta=x.numeric ? `<span class="delta">Δ ${x.numeric.delta>0?'+':''}${esc(x.numeric.delta)}</span>` : '';
  const title=x.type==='replace'?'文字/数字替换':x.type==='add'?'新增文字':'删除文字';
  return `<article class="exact-card">
    <div class="exact-head"><div>${sourceBadge('pdf_text')}<b>${esc(x.id)} · ${esc(x.sheetId||`P${x.pageB||x.pageA}`)}</b></div><span>${Math.round((x.matchConfidence||1)*100)}%</span></div>
    <h4>${title} ${delta}</h4>
    <div class="ab"><div><small>A版</small><code>${esc(x.before||'—')}</code></div><div class="arrow">→</div><div><small>B版</small><code>${esc(x.after||'—')}</code></div></div>
  </article>`;
}

function renderExact(items){
  const el=$("exactCards");
  if(!items?.length){el.innerHTML='<div class="empty">没有可从 PDF 文字层确定的文字/数字变化；将以视觉分析为主。</div>';return;}
  el.innerHTML=items.map(exactChangeCard).join('');
}

function renderSemantic(items){
  const el=$("changeCards");
  if(!items?.length){el.innerHTML='<div class="empty">本次未识别到额外工程语义变化。</div>';return;}
  el.innerHTML=items.map(x=>{
    const s=["high","medium","low"].includes(x.severity)?x.severity:"low";
    return `<article class="issue-card"><div class="sev ${s}">${s==='high'?'高风险':s==='medium'?'需关注':'一般'}</div><div class="issue-main"><div>${sourceBadge(x.evidenceSource)}</div><h4>${esc(x.category||'变化')} · ${esc(x.location||'位置待确认')}</h4><p><b>A：</b>${esc(x.versionA)}</p><p><b>B：</b>${esc(x.versionB)}</p><p><b>影响：</b>${esc(x.impact)}</p>${x.deterministicIds?.length?`<p class="refs">证据 ${x.deterministicIds.map(esc).join(', ')}</p>`:''}</div><div class="confidence">${Number.isFinite(Number(x.confidence))?Math.round(Number(x.confidence)*100)+'% 置信':''}</div></article>`;
  }).join('');
}

function renderRisks(items){
  const el=$("riskCards");
  if(!items?.length){el.innerHTML='<div class="empty">本次未识别到明确跨图漏同步风险。</div>';return;}
  el.innerHTML=items.map(x=>{const s=["high","medium","low"].includes(x.severity)?x.severity:"low";return `<article class="issue-card"><div class="sev ${s}">${s==='high'?'高风险':s==='medium'?'需关注':'一般'}</div><div class="issue-main"><div>${sourceBadge(x.evidenceSource)}</div><h4>${esc(x.location||'位置待确认')}</h4><p>${esc(x.issue)}</p><p><b>证据：</b>${esc(x.evidence)}</p>${x.deterministicIds?.length?`<p class="refs">证据 ${x.deterministicIds.map(esc).join(', ')}</p>`:''}</div><div class="confidence">${Number.isFinite(Number(x.confidence))?Math.round(Number(x.confidence)*100)+'% 置信':''}</div></article>`}).join('');
}

function renderVisual(regions){
  const el=$("visualCards");
  if(!regions?.length){el.innerHTML='<div class="empty">未检测到明显图像变化区域。</div>';return;}
  el.innerHTML=regions.map(r=>`<figure class="visual-card"><img src="${r.image}" alt="${esc(r.id)} 视觉差异区域"><figcaption><b>${esc(r.id)} · ${esc(r.sheetId||`P${r.pageB}`)}</b><span>像素差异强度 ${Math.round(r.diffScore*100)}%</span></figcaption></figure>`).join('');
}

function renderResult(data, local){
  const r=data.result||{}; state.latestResponse={...data,local:{analysisMode:local.det.textCoverage.mode,pagePairs:local.det.pagePairs,visualRegions:local.visualRegions.map(({image,...x})=>x)}};
  $("summaryText").textContent=r.summary||"分析完成";$("overallText").textContent=r.overall||"请查看下方证据与风险。";
  const counts=r.counts||{};
  $("exactCount").textContent=counts.exactText ?? local.det.textChanges.length;
  $("semanticCount").textContent=counts.semantic ?? r.semanticChanges?.length ?? 0;
  $("riskCount").textContent=counts.syncRisks ?? r.syncRisks?.length ?? 0;
  $("highCount").textContent=counts.highRisk ?? 0;
  const mode=r.analysisMode||local.det.textCoverage.mode;
  $("analysisMode").className=`mode ${mode==='hybrid'?'hybrid':'visual'}`;
  $("analysisMode").textContent=mode==='hybrid'?'HYBRID · 文字精确层 + 视觉 + M3':'VISUAL · 扫描图视觉模式';
  renderExact(r.exactChanges||local.det.textChanges);
  renderSemantic(r.semanticChanges||r.changes||[]);
  renderRisks(r.syncRisks||[]);
  renderVisual(local.visualRegions);
  const vs=Array.isArray(r.verification)?r.verification:[];
  $("verifyList").innerHTML=vs.length?vs.map(x=>`<li>${esc(x)}</li>`).join(''):'<li>建议由项目设计人员复核关键变更。</li>';
  const lim=Array.isArray(r.limitations)?r.limitations:[];
  $("limitations").innerHTML=lim.length?lim.map(x=>`<li>${esc(x)}</li>`).join(''):'<li>AI判断用于辅助核对，最终以原始图纸与专业人员复核为准。</li>';
  const usage=data.usage||{};
  $("runtimeMeta").textContent=`模型 ${data.model||'MiniMax-M3'} · ${usage.total_tokens?`Token ${usage.total_tokens.toLocaleString()} · `:''}文字层 ${local.det.textCoverage.itemsA+local.det.textCoverage.itemsB} 项 · 视觉区域 ${local.visualRegions.length} 个`;
}

$("analyzeBtn").addEventListener("click", async()=>{
  const btn=$("analyzeBtn");btn.disabled=true;$("results").classList.add("hidden");$("progress").classList.remove("hidden");$("progress").scrollIntoView({behavior:"smooth",block:"center"});
  try{
    const t0=performance.now();
    progress(0,"正在读取图纸与文字层…","PDF 原文件留在浏览器本地；先提取可验证的文字、尺寸和图号，再生成低分辨率页面图。最大读取前 8 页。");
    const [A,B]=await Promise.all([prepareFile(state.A),prepareFile(state.B)]);
    progress(1,"正在做确定性文字 Diff…","先用程序比数字和文字，不让模型猜 800、500 这种关键值。");
    const pairs=pairPages(A.pages,B.pages);const det=summarizeDeterministicDiff(A.pages,B.pages,pairs);
    progress(2,"正在定位视觉变化区域…","逐页做二值化图像差异，只把主要变化区域作为高精度视觉证据送给模型。");
    const visualRegions=computeVisualEvidence(A,B,pairs);
    const prepMs=Math.round(performance.now()-t0);
    progress(3,"MiniMax M3 正在做工程语义校核…","精确文字证据优先，M3负责解释工程含义、识别跨图漏同步和生成复核清单。");
    const apiStart=performance.now();
    const resp=await fetch('/api/compare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      projectName:$("projectName").value.trim(),notes:$("notes").value.trim(),
      versionA:stripPrepared(A),versionB:stripPrepared(B),deterministic:deterministicPayload(det,visualRegions)
    })});
    const data=await resp.json();if(!resp.ok)throw new Error(data.error||'分析失败');
    data.timing={prepMs,apiMs:Math.round(performance.now()-apiStart),totalMs:Math.round(performance.now()-t0)};
    state.prepared={A,B,det,visualRegions};renderResult(data,{A,B,det,visualRegions});
    $("progress").classList.add("hidden");$("results").classList.remove("hidden");$("results").scrollIntoView({behavior:"smooth",block:"start"});
  }catch(e){$("progress").classList.add("hidden");alert(`分析失败：${e.message||e}`)}finally{btn.disabled=!(state.A&&state.B)}
});

$("resetBtn").addEventListener("click",()=>{$("results").classList.add("hidden");$("workspace").scrollIntoView({behavior:"smooth",block:"start"})});
$("printBtn").addEventListener("click",()=>window.print());
$("jsonBtn").addEventListener("click",()=>{
  if(!state.latestResponse)return;const blob=new Blob([JSON.stringify(state.latestResponse,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`agent-hong-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});

checkHealth();
