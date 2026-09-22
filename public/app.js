const $ = (id) => document.getElementById(id);
const state = { A: null, B: null };
const MAX_PAGES = 8;
const MAX_FILE = 35 * 1024 * 1024;

async function checkHealth() {
  const el = $("serviceStatus");
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const d = await r.json();
    if (d.ok && d.configured) { el.className = "status ok"; el.innerHTML = "<span></span> MiniMax M3 已就绪"; }
    else { el.className = "status warn"; el.innerHTML = "<span></span> 等待配置模型密钥"; }
  } catch { el.className = "status warn"; el.innerHTML = "<span></span> 服务状态未知"; }
}

function humanSize(n) { return n < 1024*1024 ? `${(n/1024).toFixed(0)} KB` : `${(n/1024/1024).toFixed(1)} MB`; }

function setFile(side, file) {
  if (!file) return;
  if (file.size > MAX_FILE) return alert("单文件最大 35MB。请先压缩或拆分图纸。");
  const ok = file.type === "application/pdf" || /^image\/(png|jpeg|webp)$/.test(file.type);
  if (!ok) return alert("当前 MVP 只支持 PDF / PNG / JPG / WEBP。");
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

async function loadPdfJs() {
  const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  return pdfjs;
}

function canvasToJpeg(canvas) { return canvas.toDataURL("image/jpeg", .72); }

async function imageFileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const max = 1500;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return [canvasToJpeg(canvas)];
}

async function pdfToDataUrls(file) {
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const count = Math.min(pdf.numPages, MAX_PAGES);
  const pages = [];
  for (let i=1; i<=count; i++) {
    const page = await pdf.getPage(i);
    const raw = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 1500 / Math.max(raw.width, raw.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: "white" }).promise;
    pages.push(canvasToJpeg(canvas));
  }
  return pages;
}

async function prepare(file) { return file.type === "application/pdf" ? pdfToDataUrls(file) : imageFileToDataUrl(file); }

function progress(step, title, text) {
  $("progressTitle").textContent = title; $("progressText").textContent = text;
  ["p1","p2","p3"].forEach((id,i)=>$(id).classList.toggle("active", i <= step));
}

function sevText(s){ return s === "high" ? "高风险" : s === "medium" ? "需关注" : "一般"; }
function esc(v){ return String(v ?? "").replace(/[&<>'"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }

function renderCards(el, items, risk=false) {
  if (!Array.isArray(items) || !items.length) { el.innerHTML = '<div class="empty">本次未识别到明确项目。</div>'; return; }
  el.innerHTML = items.map(x => {
    const s = ["high","medium","low"].includes(x.severity) ? x.severity : "low";
    const title = risk ? x.issue : `${x.category || "变化"} · ${x.location || "位置待确认"}`;
    const body = risk
      ? `<p><b>证据：</b>${esc(x.evidence || "需人工复核")}</p>`
      : `<p><b>A：</b>${esc(x.versionA)}</p><p><b>B：</b>${esc(x.versionB)}</p><p><b>影响：</b>${esc(x.impact)}</p>`;
    const conf = Number(x.confidence); const pct = Number.isFinite(conf) ? `${Math.round(conf*100)}% 置信` : "";
    return `<article class="issue-card"><div class="sev ${s}">${sevText(s)}</div><div class="issue-main"><h4>${esc(title)}</h4>${body}</div><div class="confidence">${pct}</div></article>`;
  }).join("");
}

function renderResult(data) {
  const r = data.result || {};
  $("summaryText").textContent = r.summary || "分析完成";
  $("overallText").textContent = r.overall || "请查看下方明细。";
  $("changedCount").textContent = r.counts?.changed ?? r.changes?.length ?? 0;
  $("riskCount").textContent = r.counts?.highRisk ?? 0;
  $("syncCount").textContent = r.counts?.possibleMissedSync ?? r.syncRisks?.length ?? 0;
  renderCards($("changeCards"), r.changes, false);
  renderCards($("riskCards"), r.syncRisks, true);
  const vs = Array.isArray(r.verification) ? r.verification : [];
  $("verifyList").innerHTML = vs.length ? vs.map(x=>`<li>${esc(x)}</li>`).join("") : "<li>建议由项目设计人员复核关键变更。</li>";
}

$("analyzeBtn").addEventListener("click", async () => {
  const btn = $("analyzeBtn"); btn.disabled = true;
  $("results").classList.add("hidden"); $("progress").classList.remove("hidden");
  $("progress").scrollIntoView({behavior:"smooth", block:"center"});
  try {
    progress(0,"正在读取两版图纸…","PDF 会在你的浏览器里先转换成页面图，不上传原始 PDF。最多读取每版前 8 页。");
    const [pagesA, pagesB] = await Promise.all([prepare(state.A), prepare(state.B)]);
    progress(1,"MiniMax M3 正在逐页比较…","正在识别墙体、门窗、尺寸、标高、文字、编号和跨图纸一致性变化。");
    const resp = await fetch("/api/compare", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({
        projectName:$("projectName").value.trim(), notes:$("notes").value.trim(),
        versionA:{name:state.A.name,pages:pagesA}, versionB:{name:state.B.name,pages:pagesB}
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "分析失败");
    progress(2,"正在整理审查报告…","把识别到的差异按风险、位置和置信度归类。");
    renderResult(data);
    await new Promise(r=>setTimeout(r,420));
    $("progress").classList.add("hidden"); $("results").classList.remove("hidden");
    $("results").scrollIntoView({behavior:"smooth", block:"start"});
  } catch (e) {
    $("progress").classList.add("hidden");
    alert(`分析失败：${e.message || e}`);
  } finally { btn.disabled = !(state.A && state.B); }
});

$("resetBtn").addEventListener("click", () => {
  $("results").classList.add("hidden"); $("workspace").scrollIntoView({behavior:"smooth",block:"start"});
});

checkHealth();
