const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_PAGES = 8;
const MAX_BODY_BYTES = 38 * 1024 * 1024;
const MAX_DETERMINISTIC = 160;
const MAX_VISUAL_REGIONS = 12;

const SYSTEM_PROMPT = `你是 Agent Hong 的建筑施工图版本变更校核引擎。你只负责“版本变化与跨图一致性核对”，不替代注册建筑师、设计负责人或法定施工图审查。

你会同时收到三类证据：
A. 【确定性 PDF 文字证据】由程序直接从 PDF 文字层提取并比较；其中数字、文字、图号是最高优先级事实来源。
B. 【视觉差异区域】由程序做图像 Diff 后裁出的 A/B 对照区域。
C. 【完整页面低精度图】用于理解上下文、构件关系和跨页/跨图一致性。

强制规则：
1. 若 A 类确定性证据与视觉读数冲突，以 A 类为准。绝不把视觉 OCR 猜到的数字覆盖程序提取值。
2. 对精确尺寸、标高、编号、面积、Revision Note 等，只能引用 A 类给出的原文/数值，或者明确写“视觉可见但无法精确确认”。pageTextIndex 也是 PDF 文字层的确定性索引；只有当对应页 truncated=false 时，才能把“索引中不存在某编号/文字”作为缺失证据。
3. 不要把“程序明确的文字替换”重复包装成很多 AI 变化。AI 变化应强调工程含义、几何/构件变化和跨图一致性。
4. 优先检查：平面↔立面、平面↔剖面、平面↔门窗表/材料表/详图索引、房间名↔相关说明、尺寸链↔修订说明、图号↔标题栏。
5. 对疑似漏同步，必须说清：哪张图发生了什么、哪张关联图没有同步、证据是什么。
6. 不根据图纸做法律/规范合规结论；可以提示“需复核防火/疏散/构造等影响”，但不得声称满足或违反某条规范，除非用户另行提供规范证据。
7. 不确定时降低 confidence 并写“需人工复核”，禁止补造不存在的尺寸、房间、门窗或规范。
8. 对缩写或含义不唯一的标注（例如 CLR、CL、AFF 等），除非图纸文字明确给出方向/含义，否则必须保留原始标注并写“需人工确认含义”，禁止自行展开成“净宽”“净高”等具体含义。
9. 只输出严格 JSON，不要 Markdown，不要代码围栏。

输出结构：
{
  "summary": "一句话总结",
  "overall": "2-4句话，强调真正需要人工看的问题",
  "semanticChanges": [
    {
      "id":"C01",
      "severity":"high|medium|low",
      "category":"墙体|门窗|轴网|尺寸|标高|文字|编号|构件|图框|其他",
      "location":"图号/页码/轴网/房间等",
      "versionA":"A版状态；精确数字必须来自确定性证据",
      "versionB":"B版状态；精确数字必须来自确定性证据",
      "impact":"工程影响或需复核事项",
      "evidenceSource":"exact_text|mixed|visual|ai",
      "deterministicIds":["T001"],
      "confidence":0.0
    }
  ],
  "syncRisks": [
    {
      "id":"R01",
      "severity":"high|medium|low",
      "location":"跨图位置",
      "issue":"疑似漏同步说明",
      "evidence":"具体证据",
      "evidenceSource":"mixed|visual|exact_text|ai",
      "deterministicIds":["T001"],
      "confidence":0.0
    }
  ],
  "verification":["按优先级排列的人工复核动作"],
  "limitations":["本次分析的证据局限，例如扫描图无文字层、只读取前8页等"]
}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function dataUrlBytes(s) {
  if (typeof s !== "string") return 0;
  const i = s.indexOf(","), b64 = i >= 0 ? s.slice(i + 1) : s;
  return Math.ceil((b64.length * 3) / 4);
}

function validImage(s) { return typeof s === "string" && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(s); }

function validatePayload(body) {
  if (!body || typeof body !== "object") return "请求体无效";
  for (const key of ["versionA", "versionB"]) {
    const v = body[key];
    if (!v || !Array.isArray(v.pages) || v.pages.length === 0) return `${key} 缺少图纸页面`;
    if (v.pages.length > MAX_PAGES) return `${key} 最多支持 ${MAX_PAGES} 页`;
    for (const p of v.pages) if (!p || !validImage(p.image)) return `${key} 页面格式无效`;
  }
  const regions = body?.deterministic?.visualRegions || [];
  if (!Array.isArray(regions) || regions.length > MAX_VISUAL_REGIONS) return `视觉差异区域最多 ${MAX_VISUAL_REGIONS} 个`;
  const all = [
    ...body.versionA.pages.map(p=>p.image),
    ...body.versionB.pages.map(p=>p.image),
    ...regions.map(r=>r.image).filter(Boolean)
  ];
  const total = all.reduce((n,p)=>n+dataUrlBytes(p),0);
  if (total > 34 * 1024 * 1024) return "预处理后的图像证据超过 34MB，请减少页数或压缩图纸";
  return null;
}

function stripJsonFence(text) {
  let s=String(text||"").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
  const start=s.indexOf("{"),end=s.lastIndexOf("}");
  if(start>=0&&end>start)s=s.slice(start,end+1);
  return s;
}

function safeArray(v){return Array.isArray(v)?v:[]}
function source(v, fallback="ai"){return ["exact_text","mixed","visual","ai"].includes(v)?v:fallback}
function severity(v){return ["high","medium","low"].includes(v)?v:"medium"}
function confidence(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):.5}

function deterministicForPrompt(body) {
  const d=body?.deterministic||{};
  const changes=safeArray(d.textChanges).slice(0,MAX_DETERMINISTIC).map(x=>({
    id:x.id,sheetId:x.sheetId,pageA:x.pageA,pageB:x.pageB,type:x.type,before:x.before,after:x.after,
    numeric:x.numeric||null,position:x.position,matchConfidence:x.matchConfidence
  }));
  const pageTextIndex={
    versionA:safeArray(body?.versionA?.pages).map((p,i)=>({page:i+1,sheetId:p?.sheetId||null,text:String(p?.textDigest||""),truncated:Boolean(p?.textDigestTruncated)})),
    versionB:safeArray(body?.versionB?.pages).map((p,i)=>({page:i+1,sheetId:p?.sheetId||null,text:String(p?.textDigest||""),truncated:Boolean(p?.textDigestTruncated)}))
  };
  return {
    analysisMode:d?.textCoverage?.mode||"visual-only",
    textCoverage:d?.textCoverage||{},
    pagePairs:safeArray(d.pagePairs),
    exactTextChanges:changes,
    pageTextIndex,
    visualRegions:safeArray(d.visualRegions).map(({image,...x})=>x)
  };
}

function buildUserContent(body) {
  const content=[];
  const det=deterministicForPrompt(body);
  content.push({type:"text",text:`项目：${body.projectName||"未填写"}\n用户关注：${body.notes||"无"}\n\n以下 JSON 是程序生成的确定性/定位证据。对精确文字与数字，以 exactTextChanges 为最高优先级事实来源：\n${JSON.stringify(det)}`});

  const pairs=safeArray(body?.deterministic?.pagePairs);
  const pageOrder=[];
  if(pairs.length){
    for(const p of pairs){if(p.pageA!==null&&p.pageB!==null)pageOrder.push(p)}
  } else {
    const n=Math.min(body.versionA.pages.length,body.versionB.pages.length);
    for(let i=0;i<n;i++)pageOrder.push({pageA:i,pageB:i,sheetId:null});
  }
  for(const pair of pageOrder){
    const a=body.versionA.pages[pair.pageA],b=body.versionB.pages[pair.pageB];
    content.push({type:"text",text:`完整页上下文｜${pair.sheetId||`A第${pair.pageA+1}页 / B第${pair.pageB+1}页`}｜先A后B。完整页主要用于理解构件和跨图关系，不要靠它猜小数字。`});
    content.push({type:"image_url",image_url:{url:a.image,detail:"low",max_long_side_pixel:1100}});
    content.push({type:"image_url",image_url:{url:b.image,detail:"low",max_long_side_pixel:1100}});
  }

  const regions=safeArray(body?.deterministic?.visualRegions).slice(0,MAX_VISUAL_REGIONS);
  for(const r of regions){
    if(!validImage(r.image))continue;
    content.push({type:"text",text:`高精度视觉差异 ${r.id}｜图号 ${r.sheetId||"未知"}｜A第${r.pageA}页 vs B第${r.pageB}页｜bbox=${JSON.stringify(r.bbox)}。图片左侧A版、右侧B版。`});
    content.push({type:"image_url",image_url:{url:r.image,detail:"high",max_long_side_pixel:1200}});
  }
  return content;
}

function parseModelContent(envelope) {
  const content=envelope?.choices?.[0]?.message?.content;
  if(!content)throw new Error("MiniMax 未返回分析内容");
  if(content&&typeof content==="object"&&!Array.isArray(content))return content;
  if(Array.isArray(content)){
    const direct=content.find(x=>x&&typeof x==="object"&&!("text" in x)&&!("type" in x));
    if(direct)return direct;
    const s=content.map(x=>typeof x==="string"?x:(x?.text||"")).join("");
    return JSON.parse(stripJsonFence(s));
  }
  return JSON.parse(stripJsonFence(content));
}

async function callMiniMax(env, body) {
  if(!env.MINIMAX_API_KEY)throw new Error("服务端尚未配置 MINIMAX_API_KEY");
  const base=(env.MINIMAX_API_BASE||"https://api.minimaxi.com/v1").replace(/\/$/,"");
  const model=env.MINIMAX_MODEL||"MiniMax-M3";
  const resp=await fetch(`${base}/chat/completions`,{
    method:"POST",
    headers:{Authorization:`Bearer ${env.MINIMAX_API_KEY}`,"content-type":"application/json"},
    body:JSON.stringify({
      model,
      messages:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:buildUserContent(body)}],
      temperature:.1,
      max_completion_tokens:7000,
      reasoning_split:true,
      thinking:{type:"adaptive"}
    })
  });
  const raw=await resp.text();
  if(!resp.ok)throw new Error(`MiniMax API ${resp.status}: ${raw.slice(0,600)}`);
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax 返回了非 JSON 响应")}
  let parsed;try{parsed=parseModelContent(envelope)}catch(e){
    throw new Error(`模型结构化结果解析失败：${e?.message||e}`);
  }
  return {parsed,usage:envelope.usage||null,model};
}

function normalizeModelResult(parsed, body) {
  const exact=safeArray(body?.deterministic?.textChanges).slice(0,MAX_DETERMINISTIC).map(x=>({...x,source:"pdf_text"}));
  const semantic=safeArray(parsed?.semanticChanges || parsed?.changes).map((x,i)=>({
    id:x?.id||`C${String(i+1).padStart(2,"0")}`,
    severity:severity(x?.severity),category:String(x?.category||"其他"),location:String(x?.location||"位置待确认"),
    versionA:String(x?.versionA||"需人工复核"),versionB:String(x?.versionB||"需人工复核"),impact:String(x?.impact||"需人工复核"),
    evidenceSource:source(x?.evidenceSource,"ai"),deterministicIds:safeArray(x?.deterministicIds).filter(v=>typeof v==="string").slice(0,12),confidence:confidence(x?.confidence)
  })).slice(0,60);
  const risks=safeArray(parsed?.syncRisks).map((x,i)=>({
    id:x?.id||`R${String(i+1).padStart(2,"0")}`,severity:severity(x?.severity),location:String(x?.location||"位置待确认"),
    issue:String(x?.issue||"需人工复核"),evidence:String(x?.evidence||"证据不足，需人工复核"),evidenceSource:source(x?.evidenceSource,"ai"),
    deterministicIds:safeArray(x?.deterministicIds).filter(v=>typeof v==="string").slice(0,12),confidence:confidence(x?.confidence)
  })).slice(0,40);
  const highRisk=[...semantic,...risks].filter(x=>x.severity==="high").length;
  const mode=body?.deterministic?.textCoverage?.mode||"visual-only";
  const limitations=safeArray(parsed?.limitations).map(String).slice(0,12);
  if(body.versionA.sourcePages>MAX_PAGES||body.versionB.sourcePages>MAX_PAGES)limitations.unshift(`本次只读取每版前 ${MAX_PAGES} 页，原文件存在更多页面。`);
  if(mode!=="hybrid")limitations.unshift("未检测到足够的 PDF 文字层，本次精确数字/文字主要依赖视觉，关键尺寸必须人工复核。");
  return {
    summary:String(parsed?.summary||"版本分析完成"),
    overall:String(parsed?.overall||"请查看确定性证据与跨图风险。"),
    analysisMode:mode,
    counts:{exactText:exact.length,semantic:semantic.length,syncRisks:risks.length,highRisk},
    exactChanges:exact,
    semanticChanges:semantic,
    syncRisks:risks,
    verification:safeArray(parsed?.verification).map(String).slice(0,20),
    limitations
  };
}


const MAX_REVIEW_IMAGES=10;
const MAX_REVIEW_SCANNED=30;
const MAX_REFERENCE_CHUNKS=80;
const MAX_REFERENCE_CHARS=65000;

const REVIEW_SYSTEM_PROMPT = [
  "你是 Agent Hong 的建筑施工图 AI 预审引擎。你的职责是帮助设计院在人工终审前发现明显问题、未闭环事项和跨图不一致；你不是法定施工图审查机构。",
  "",
  "输入证据分层：",
  "A. deterministic.alerts：程序从 PDF 文字层和规则引擎得到的硬检查结果，优先级最高。",
  "B. deterministic.sheets / indices：最多前30页的图号、图种、门窗、房间、跨图引用等文字索引。",
  "C. drawing.pages：程序按风险和图种挑选的最多10个关键页图像 + 文字摘要，用于视觉/工程语义复核。",
  "D. reference.chunks：用户提供的院标、甲方要求、项目要求片段，每条有 R001 / R002 等ID。",
  "",
  "强制规则：",
  "1. 没有 reference.chunks 时，禁止声称‘违反规范’‘符合规范’或编造条文；只能写‘需按适用规范/院标复核’。",
  "2. 如果问题直接依赖用户要求，必须在 referenceIds 填真实存在的 Rxxx；不得编造不存在的引用ID。",
  "3. 程序硬检查不得被视觉 OCR 覆盖。图号、门窗号、房间号、文字冲突优先相信 deterministic 文字证据。",
  "4. 不要原样重复硬检查凑数量。AI issues 应补充：工程影响、跨图关系、视觉证据或需要人工做的具体动作。",
  "5. 重点检查：图纸目录↔实际图号、平面↔门窗表、平面↔立面/剖面、房间编号/名称、详图/索引引用、文字说明、CHECK/VERIFY/TBD/PENDING/HOLD 等未闭环项。",
  "6. 对门窗跨图判断要克制：没有方向/立面归属证据时，不要武断地说某个窗必须出现在某一张立面；若有明确 NOTE / CHECK / reference 要求则可提高置信度。",
  "7. 对 CLR、CL、AFF 等多义缩写保持原文；图纸未明确含义时不得自行展开成净高/净宽等。",
  "8. 对看不清或证据不足的视觉信息降低 confidence 并写‘需人工复核’，不得补造尺寸、构件、材料或规范。",
  "9. 一般性说明中出现 CHECK/VERIFY 等词不等于未闭环；以 deterministic.alerts 为准。",
  "10. 只输出严格 JSON，不要 Markdown，不要代码围栏。",
  "",
  "输出 JSON：",
  "{",
  "  \"summary\":\"一句话摘要\",",
  "  \"overall\":\"2-4句话整体判断\",",
  "  \"issues\":[{\"id\":\"I01\",\"severity\":\"high|medium|low\",\"category\":\"图号/图框|图纸目录|门窗一致性|房间编号/名称|跨图一致性|尺寸/标高|编号/索引|文字说明|未闭环标记|构件/空间|依据待核|其他\",\"location\":\"图号/页码/位置\",\"issue\":\"问题\",\"evidence\":\"证据\",\"why\":\"为什么值得看\",\"action\":\"复核动作\",\"evidenceSource\":\"pdf_text|mixed|visual|ai|reference\",\"deterministicIds\":[\"P001\"],\"referenceIds\":[\"R001\"],\"confidence\":0.0}],",
  "  \"crossSheetRisks\":[{\"id\":\"X01\",\"severity\":\"high|medium|low\",\"category\":\"跨图一致性\",\"location\":\"A-101 ↔ A-601\",\"issue\":\"风险\",\"evidence\":\"证据\",\"why\":\"影响\",\"action\":\"复核动作\",\"evidenceSource\":\"mixed|pdf_text|visual|ai|reference\",\"deterministicIds\":[\"P001\"],\"referenceIds\":[\"R001\"],\"confidence\":0.0}],",
  "  \"checklist\":[\"按优先级排列的人工复核动作\"],",
  "  \"limitations\":[\"本次分析局限\"],",
  "  \"sheetSummary\":[{\"sheetId\":\"A-101\",\"page\":2,\"role\":\"plan\",\"note\":\"该页关键内容/风险\"}]",
  "}"
].join("\n");

function validateReviewPayload(body){
  if(!body||typeof body!=="object")return "请求体无效";
  const d=body.drawing;
  if(!d||!Array.isArray(d.pages)||!d.pages.length)return "缺少施工图关键页";
  if(d.pages.length>MAX_REVIEW_IMAGES)return "M3 视觉关键页最多 "+MAX_REVIEW_IMAGES+" 页";
  if(Number(d.scannedPages||d.pages.length)>MAX_REVIEW_SCANNED)return "施工图文字预扫最多 "+MAX_REVIEW_SCANNED+" 页";
  for(const p of d.pages)if(!p||!validImage(p.image))return "施工图页面格式无效";
  const sheets=safeArray(body?.deterministic?.sheets);
  if(sheets.length>MAX_REVIEW_SCANNED)return "程序图纸索引超过限制";
  const alerts=safeArray(body?.deterministic?.alerts);
  if(alerts.length>140)return "程序硬检查结果过多";
  const refText=String(body?.reference?.text||"");
  if(refText.length>MAX_REFERENCE_CHARS)return "参考资料文字过长";
  const chunks=safeArray(body?.reference?.chunks);
  if(chunks.length>MAX_REFERENCE_CHUNKS)return "参考资料片段过多";
  const total=d.pages.reduce((n,p)=>n+dataUrlBytes(p.image),0);
  if(total>34*1024*1024)return "预处理后的施工图图像超过 34MB";
  return null;
}

function reviewEvidenceForPrompt(body){
  const d=body?.deterministic||{};
  return {
    textCoverage:d.textCoverage||{},
    sheets:safeArray(d.sheets).slice(0,MAX_REVIEW_SCANNED),
    alerts:safeArray(d.alerts).slice(0,140),
    indices:d.indices||{},
    fullyLoaded:Boolean(d.fullyLoaded)
  };
}

function compactReference(body){
  return safeArray(body?.reference?.chunks).slice(0,MAX_REFERENCE_CHUNKS).map(x=>({
    id:String(x?.id||""),
    page:Number.isFinite(Number(x?.page))?Number(x.page):null,
    text:String(x?.text||"").slice(0,1100)
  })).filter(x=>/^R\d{3}$/.test(x.id)&&x.text);
}

function buildReviewContent(body){
  const content=[];
  const evidence=reviewEvidenceForPrompt(body);
  const refs=compactReference(body);
  content.push({type:"text",text:
    "项目："+(body.projectName||"未填写")+
    "\n重点关注："+(body.focus||"无")+
    "\n\n程序硬检查与全局文字索引：\n"+JSON.stringify(evidence)+
    "\n\n用户项目依据片段：\n"+(refs.length?JSON.stringify(refs):"未提供。不得输出规范/院标符合或违反结论。")+
    "\n\n视觉选页信息："+JSON.stringify(body?.drawing?.selection||[])
  });
  safeArray(body?.drawing?.pages).forEach((p,i)=>{
    content.push({type:"text",text:
      "关键页 "+(i+1)+" / "+body.drawing.pages.length+
      "｜原PDF第 "+(p.pageNumber||"?")+" 页｜图号 "+(p.sheetId||"未识别")+
      "\nPDF文字层摘要："+String(p.textDigest||"")+
      (p.textDigestTruncated?"\n[文字摘要已截断]":"")
    });
    content.push({type:"image_url",image_url:{url:p.image,detail:"default",max_long_side_pixel:1250}});
  });
  return content;
}

async function callReviewMiniMax(env,body){
  if(!env.MINIMAX_API_KEY)throw new Error("服务端尚未配置 MINIMAX_API_KEY");
  const base=(env.MINIMAX_API_BASE||"https://api.minimaxi.com/v1").replace(/\/$/,"");
  const model=env.MINIMAX_MODEL||"MiniMax-M3";
  const resp=await fetch(base+"/chat/completions",{
    method:"POST",
    headers:{Authorization:"Bearer "+env.MINIMAX_API_KEY,"content-type":"application/json"},
    body:JSON.stringify({
      model,
      messages:[{role:"system",content:REVIEW_SYSTEM_PROMPT},{role:"user",content:buildReviewContent(body)}],
      temperature:.08,
      max_completion_tokens:8000,
      reasoning_split:true,
      thinking:{type:"adaptive"}
    })
  });
  const raw=await resp.text();
  if(!resp.ok)throw new Error("MiniMax API "+resp.status+": "+raw.slice(0,700));
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax 返回了非 JSON 响应")}
  let parsed;try{parsed=parseModelContent(envelope)}catch(e){throw new Error("预审结构化结果解析失败："+(e?.message||e))}
  return {parsed,usage:envelope.usage||null,model};
}

function reviewSource(v,fallback="ai"){return ["pdf_text","mixed","visual","ai","reference"].includes(v)?v:fallback}

function validReferenceIds(body){
  return new Set(compactReference(body).map(x=>x.id));
}

function normalizeReviewIssue(x,i,prefix,body){
  const refs=validReferenceIds(body);
  return {
    id:String(x?.id||(prefix+String(i+1).padStart(2,"0"))),
    severity:severity(x?.severity),
    category:String(x?.category||"其他"),
    location:String(x?.location||"位置待确认"),
    issue:String(x?.issue||"需人工复核"),
    evidence:String(x?.evidence||"证据不足，需人工复核"),
    why:String(x?.why||"需人工复核"),
    action:String(x?.action||"人工复核"),
    evidenceSource:reviewSource(x?.evidenceSource,"ai"),
    deterministicIds:safeArray(x?.deterministicIds).filter(v=>typeof v==="string"&&/^P\d{3}$/.test(v)).slice(0,16),
    referenceIds:safeArray(x?.referenceIds).filter(v=>typeof v==="string"&&refs.has(v)).slice(0,12),
    confidence:confidence(x?.confidence)
  };
}

function normalizeSheetSummary(x){
  return {
    sheetId:String(x?.sheetId||""),
    page:Number.isFinite(Number(x?.page))?Number(x.page):null,
    role:String(x?.role||"other"),
    note:String(x?.note||"").slice(0,800)
  };
}

function normalizeReviewResult(parsed,body){
  const hard=safeArray(body?.deterministic?.alerts).slice(0,140);
  const issues=safeArray(parsed?.issues).map((x,i)=>normalizeReviewIssue(x,i,"I",body)).slice(0,70);
  const cross=safeArray(parsed?.crossSheetRisks).map((x,i)=>normalizeReviewIssue(x,i,"X",body)).slice(0,50);
  const highRisk=[...hard,...issues,...cross].filter(x=>x.severity==="high").length;
  const referenceBased=[...issues,...cross].filter(x=>x.referenceIds?.length).length;
  const mode=body?.deterministic?.textCoverage?.mode||"visual-only";
  const limitations=safeArray(parsed?.limitations).map(String).slice(0,14);
  const scanned=Number(body?.drawing?.scannedPages||body?.deterministic?.textCoverage?.scannedPages||body?.drawing?.pages?.length||0);
  const source=Number(body?.drawing?.sourcePages||scanned);
  if(source>scanned)limitations.unshift("施工图原文件共 "+source+" 页，本次程序文字预扫前 "+scanned+" 页；未扫描页不在本次结论范围内。");
  if(scanned>body.drawing.pages.length)limitations.unshift("程序已检查 "+scanned+" 页文字层；M3 视觉只查看按风险排序选出的 "+body.drawing.pages.length+" 个关键页。");
  if(mode!=="hybrid")limitations.unshift("未检测到足够 PDF 文字层，本次图号、编号和文字检查主要依赖视觉，关键内容必须人工复核。");
  if(!compactReference(body).length)limitations.unshift("未提供可读取的院标/甲方要求/规范依据，本次不做依据型符合性结论。");
  if(body?.reference?.truncated)limitations.unshift("参考资料过长，本次只读取了部分文字；引用结论仅覆盖已读取片段。");
  const reviewStatus=highRisk>0?"needs-attention":((hard.length||issues.some(x=>x.severity==="medium")||cross.length)?"review":"clear");
  return {
    summary:String(parsed?.summary||"施工图预审完成"),
    overall:String(parsed?.overall||"请查看程序硬检查、AI问题与跨图风险。"),
    reviewStatus,
    analysisMode:mode,
    counts:{hard:hard.length,issues:issues.length,crossSheet:cross.length,referenceBased,highRisk,scannedPages:scanned,aiPages:body.drawing.pages.length},
    hardAlerts:hard,
    issues,
    crossSheetRisks:cross,
    checklist:safeArray(parsed?.checklist).map(String).slice(0,24),
    limitations:uniqStrings(limitations).slice(0,16),
    sheetSummary:safeArray(parsed?.sheetSummary).map(normalizeSheetSummary).slice(0,MAX_REVIEW_SCANNED)
  };
}

function uniqStrings(items){
  const seen=new Set(),out=[];
  for(const x of items){const s=String(x||"").trim();if(s&&!seen.has(s)){seen.add(s);out.push(s)}}
  return out;
}



const MAX_COMMENT_ITEMS=80;
const MAX_COMMENT_DIFFS=220;
const MAX_COMMENT_AI_PAIRS=8;

const COMMENT_SYSTEM_PROMPT=[
  "你是 Agent Hong 的“总工/校审意见落实检查”引擎。你的任务不是重新设计建筑，而是逐条判断修改意见是否在新图纸中得到落实，并给出证据。",
  "",
  "你会收到：",
  "A. comments.items：用户的总工/校审意见，ID 为 C001/C002...",
  "B. deterministic.textChanges：程序直接从 A/B PDF 文字层提取的精确变化，ID 为 T001/T002...；数字、文字、图号以此为最高优先级事实。",
  "C. deterministic.commentEvidence：程序已将每条 Cxxx 匹配到候选 Txxx，并给出 deterministicHint。",
  "D. drawing.pagePairs：全部已配对图页元数据；selectedPairs 是最多8组最相关的 A/B 页面图像和文字摘要。",
  "",
  "每条意见只能落在以下四种状态之一：",
  "implemented：有明确正向证据，且意见要求的关键目标均已落实。",
  "partial：只落实了一部分，或主图修改了但相关图/表/说明没有同步。",
  "not_found：本次扫描范围内应能验证，但没有找到落实证据，或新图仍保留旧状态。",
  "uncertain：证据不足、目标图未扫描/未配对、图像看不清，不能可靠判断。",
  "",
  "强制规则：",
  "1. 必须对 comments.items 中每个 Cxxx 都输出且只输出一条结果，不得遗漏、不得新增不存在的 Cxxx。",
  "2. implemented 必须有明确新图证据；“可能改了”“看起来像”不能判 implemented。",
  "3. 若意见包含多个动作/多个目标图，只完成部分则必须判 partial。",
  "4. 精确数字、房间名、门窗号、图号优先相信 deterministic.textChanges，不得用视觉 OCR 覆盖。",
  "5. 若 deterministicHint=likely-implemented，只能作为证据提示，不是最终结论；仍需确认意见是否还有跨图同步要求。",
  "6. 对“删除/关闭/取消”类意见：若 old 中明确存在目标旧文本，而 new 同图已不再存在；Txxx 显示 remove 或 replace，且 CHECK/VERIFY/TBD/TBC/PENDING/HOLD 等未闭环词已经消失或被 RESOLVED/COORDINATED 等完成表述替代，应判 implemented。不要因为新图保留了同一主题的“已协调/已解决”说明而降成 partial。",
  "7. 如果目标图号在 pagePairs 中不存在或未进入扫描范围，优先判 uncertain，而不是 not_found。",
  "8. 对 CLR、CL、AFF 等多义缩写保持原文；除非图纸明确含义，不得自行展开。",
  "9. 不得编造规范条文或法定合规结论。这里只判断“意见是否落实”。",
  "10. 可以指出与意见无明显对应的额外变更，放入 unlistedChanges，提醒人工确认是否为授权修改。",
  "11. 只输出严格 JSON，不要 Markdown，不要代码围栏。",
  "",
  "输出 JSON：",
  "{",
  "  \"summary\":\"一句话闭环摘要\",",
  "  \"overall\":\"2-4句话说明最值得人工看的意见\",",
  "  \"items\":[{",
  "    \"commentId\":\"C001\",",
  "    \"status\":\"implemented|partial|not_found|uncertain\",",
  "    \"confidence\":0.0,",
  "    \"impactedSheets\":[\"A-101\",\"A-201\"],",
  "    \"conclusion\":\"为什么这样判\",",
  "    \"oldEvidence\":\"修改前证据\",",
  "    \"newEvidence\":\"修改后证据\",",
  "    \"deterministicIds\":[\"T001\"],",
  "    \"missingSync\":\"若部分落实，具体漏同步位置；否则空字符串\",",
  "    \"reviewerAction\":\"人工下一步动作\"",
  "  }],",
  "  \"unlistedChanges\":[{",
  "    \"category\":\"尺寸|门窗|房间|图号|文字|构件|其他\",",
  "    \"location\":\"图号/页码\",",
  "    \"change\":\"额外变化\",",
  "    \"evidence\":\"证据\",",
  "    \"action\":\"确认是否为授权修改\",",
  "    \"confidence\":0.0",
  "  }],",
  "  \"checklist\":[\"人工复核动作\"],",
  "  \"limitations\":[\"分析局限\"]",
  "}"
].join("\n");

function validateCommentPayload(body){
  if(!body||typeof body!=="object")return "请求体无效";
  const comments=safeArray(body?.comments?.items);
  if(!comments.length)return "缺少可核对的总工/校审意见";
  if(comments.length>MAX_COMMENT_ITEMS)return "意见最多支持 "+MAX_COMMENT_ITEMS+" 条";
  for(const x of comments){
    if(!/^C\d{3}$/.test(String(x?.id||"")))return "意见 ID 格式无效";
    if(!String(x?.text||"").trim())return "存在空意见";
  }
  const pairs=safeArray(body?.drawing?.selectedPairs);
  if(pairs.length>MAX_COMMENT_AI_PAIRS)return "M3 视觉页面对最多 "+MAX_COMMENT_AI_PAIRS+" 组";
  for(const p of pairs){
    if(!validImage(p?.oldImage)||!validImage(p?.newImage))return "A/B 页面图像格式无效";
  }
  const diffs=safeArray(body?.deterministic?.textChanges);
  if(diffs.length>MAX_COMMENT_DIFFS)return "精确 Diff 证据过多";
  const evidence=safeArray(body?.deterministic?.commentEvidence);
  if(evidence.length>MAX_COMMENT_ITEMS)return "意见证据映射过多";
  const total=pairs.reduce((n,p)=>n+dataUrlBytes(p.oldImage)+dataUrlBytes(p.newImage),0);
  if(total>34*1024*1024)return "预处理后的页面图像超过 34MB";
  return null;
}

function compactCommentPayload(body){
  return {
    projectName:String(body?.projectName||""),
    notes:String(body?.notes||""),
    comments:safeArray(body?.comments?.items).slice(0,MAX_COMMENT_ITEMS).map(x=>({
      id:String(x.id),text:String(x.text||""),
      targetSheets:safeArray(x.targetSheets).slice(0,12),
      marks:safeArray(x.marks).slice(0,12),
      rooms:safeArray(x.rooms).slice(0,12),
      numbers:safeArray(x.numbers).slice(0,20)
    })),
    pagePairs:safeArray(body?.drawing?.pagePairs).slice(0,80),
    textCoverage:body?.deterministic?.textCoverage||{},
    textChanges:safeArray(body?.deterministic?.textChanges).slice(0,MAX_COMMENT_DIFFS).map(x=>({
      id:x.id,sheetId:x.sheetId,pageA:x.pageA,pageB:x.pageB,type:x.type,
      before:x.before,after:x.after,numeric:x.numeric||null,matchConfidence:x.matchConfidence
    })),
    commentEvidence:safeArray(body?.deterministic?.commentEvidence).slice(0,MAX_COMMENT_ITEMS).map(x=>({
      commentId:x.commentId,targetSheets:x.targetSheets||[],deterministicHint:x.deterministicHint,
      candidateIds:safeArray(x.candidateIds).slice(0,12),
      candidates:safeArray(x.candidates).slice(0,8)
    }))
  };
}

function buildCommentContent(body){
  const content=[];
  const compact=compactCommentPayload(body);
  content.push({type:"text",text:
    "项目："+(body.projectName||"未填写")+
    "\n补充说明："+(body.notes||"无")+
    "\n\n以下 JSON 是程序提取的意见、A/B 精确 Diff 和候选证据。精确数字/文字以 textChanges 为最高优先级事实：\n"+
    JSON.stringify(compact)
  });
  safeArray(body?.drawing?.selectedPairs).forEach((p,i)=>{
    content.push({type:"text",text:
      "关键 A/B 页面组 "+(i+1)+" / "+body.drawing.selectedPairs.length+
      "｜图号 "+(p.sheetId||"未识别")+
      "｜A第 "+p.pageA+" 页 → B第 "+p.pageB+" 页"+
      "\nA文字摘要："+String(p.oldTextDigest||"")+
      "\nB文字摘要："+String(p.newTextDigest||"")
    });
    content.push({type:"image_url",image_url:{url:p.oldImage,detail:"default",max_long_side_pixel:1150}});
    content.push({type:"image_url",image_url:{url:p.newImage,detail:"default",max_long_side_pixel:1150}});
  });
  return content;
}

function modelContentAsText(envelope){
  const content=envelope?.choices?.[0]?.message?.content;
  if(typeof content==="string")return content;
  if(Array.isArray(content))return content.map(x=>typeof x==="string"?x:(x?.text||"")).join("");
  if(content&&typeof content==="object")return JSON.stringify(content);
  return "";
}

function mergeUsage(a,b){
  if(!a)return b||null;
  if(!b)return a||null;
  const keys=new Set([...Object.keys(a),...Object.keys(b)]),out={};
  for(const k of keys){
    const av=a[k],bv=b[k];
    out[k]=(typeof av==="number"||typeof bv==="number")?Number(av||0)+Number(bv||0):(bv??av);
  }
  return out;
}

async function repairCommentJson(env,model,broken){
  const base=(env.MINIMAX_API_BASE||"https://api.minimaxi.com/v1").replace(/\/$/,"");
  const resp=await fetch(base+"/chat/completions",{
    method:"POST",
    headers:{Authorization:"Bearer "+env.MINIMAX_API_KEY,"content-type":"application/json"},
    body:JSON.stringify({
      model,
      messages:[
        {role:"system",content:"你是 JSON 修复器。输入是一段本应为严格 JSON 的总工意见检查结果，但可能存在漏逗号、未转义引号或代码围栏。只修复 JSON 语法，不改变任何字段值、状态、置信度或语义。只输出一个严格 JSON 对象，不要解释。"},
        {role:"user",content:String(broken||"").slice(0,28000)}
      ],
      temperature:0,
      max_completion_tokens:7000
    })
  });
  const raw=await resp.text();
  if(!resp.ok)throw new Error("MiniMax JSON repair API "+resp.status+": "+raw.slice(0,500));
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax JSON repair 返回了非 JSON 响应")}
  return {parsed:parseModelContent(envelope),usage:envelope.usage||null};
}

async function callCommentMiniMax(env,body){
  if(!env.MINIMAX_API_KEY)throw new Error("服务端尚未配置 MINIMAX_API_KEY");
  const base=(env.MINIMAX_API_BASE||"https://api.minimaxi.com/v1").replace(/\/$/,"");
  const model=env.MINIMAX_MODEL||"MiniMax-M3";
  const resp=await fetch(base+"/chat/completions",{
    method:"POST",
    headers:{Authorization:"Bearer "+env.MINIMAX_API_KEY,"content-type":"application/json"},
    body:JSON.stringify({
      model,
      messages:[{role:"system",content:COMMENT_SYSTEM_PROMPT},{role:"user",content:buildCommentContent(body)}],
      temperature:.05,
      max_completion_tokens:9000,
      reasoning_split:true,
      thinking:{type:"adaptive"}
    })
  });
  const raw=await resp.text();
  if(!resp.ok)throw new Error("MiniMax API "+resp.status+": "+raw.slice(0,700));
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax 返回了非 JSON 响应")}
  try{
    return {parsed:parseModelContent(envelope),usage:envelope.usage||null,model,repaired:false};
  }catch(firstError){
    const broken=modelContentAsText(envelope);
    if(!broken)throw new Error("意见闭环结构化结果解析失败："+(firstError?.message||firstError));
    try{
      const repaired=await repairCommentJson(env,model,broken);
      return {parsed:repaired.parsed,usage:mergeUsage(envelope.usage||null,repaired.usage||null),model,repaired:true};
    }catch(repairError){
      throw new Error("意见闭环结构化结果解析失败："+(firstError?.message||firstError)+"；自动 JSON 修复也失败："+(repairError?.message||repairError));
    }
  }
}

function commentStatus(v){
  return ["implemented","partial","not_found","uncertain"].includes(v)?v:"uncertain";
}

function missingTargetScopeOverride(comment,body){
  const targets=safeArray(comment?.targetSheets).filter(Boolean);
  if(!targets.length)return null;
  const available=new Set();
  for(const p of safeArray(body?.drawing?.pagePairs)){
    if(p?.sheetId)available.add(String(p.sheetId));
  }
  const missing=targets.filter(x=>!available.has(String(x)));
  if(!missing.length)return null;
  return {
    status:"uncertain",
    confidence:.99,
    missing,
    reason:"意见明确涉及图号 "+missing.join(", ")+"，但本次 A/B 图纸中未提供对应可配对页面，不能判定为已落实或未落实。"
  };
}

function explicitCoordinationTextOverride(comment,body){
  const text=String(comment?.text||"");
  const targets=safeArray(comment?.targetSheets).map(String).filter(Boolean);
  if(targets.length<2)return null;

  // This override is deliberately narrow: only comments that explicitly demand a note/statement/mark.
  const explicitIntent=/EXPLICIT.{0,30}(NOTE|STATEMENT|MARK)|ADD.{0,30}(NOTE|STATEMENT)|明确.{0,20}(说明|注明|标注|备注)|增加.{0,20}(说明|注明|标注|备注)/i.test(text);
  if(!explicitIntent)return null;

  const available=new Set(safeArray(body?.drawing?.pagePairs).map(x=>String(x?.sheetId||"")).filter(Boolean));
  if(targets.some(x=>!available.has(x)))return null;

  const targetSet=new Set(targets);
  const pairText=new Map();
  for(const p of safeArray(body?.drawing?.selectedPairs)){
    const sid=String(p?.sheetId||"");
    if(targetSet.has(sid))pairText.set(sid,String(p?.newTextDigest||"").toUpperCase());
  }
  // Absence can only be asserted when every target sheet was actually text-visible to the server.
  if(targets.some(x=>!pairText.has(x)))return null;

  const targetRefs=new Set(targets.map(x=>x.toUpperCase()));
  const objectTokens=uniqStrings((text.toUpperCase().match(/\b[A-Z][A-Z0-9]*-\d+[A-Z0-9-]*\b/g)||[])
    .filter(x=>!targetRefs.has(x) && !/^[WD]-?\d/.test(x)));
  if(!objectTokens.length)return null;

  const completion=/COORDINATED|RESOLVED|CONFIRMED|已协调|已落实|已确认|完成/i;
  const satisfied=[];
  for(const sid of targets){
    const pageText=pairText.get(sid)||"";
    const tokenHit=objectTokens.every(tok=>pageText.includes(tok));
    satisfied.push(tokenHit && completion.test(pageText));
  }

  const done=satisfied.filter(Boolean).length;
  if(done===targets.length){
    return {
      status:"implemented",
      confidence:.99,
      reason:"目标图纸均在本次范围内，PDF 文字层已检出 "+objectTokens.join(", ")+" 及明确的已协调/已完成表述。"
    };
  }
  if(done>0){
    return {
      status:"partial",
      confidence:.99,
      reason:"意见要求在多张目标图中形成明确协调说明，但只有部分目标图的 PDF 文字层检出 "+objectTokens.join(", ")+" 及完成表述。",
      missing:targets.filter((_,i)=>!satisfied[i])
    };
  }
  return {
    status:"not_found",
    confidence:.99,
    reason:"意见要求增加明确协调说明；所有目标图均已提供且文字层可读，但新图目标页未检出 "+objectTokens.join(", ")+" 的已协调/已完成表述。",
    missing:targets
  };
}

function safeDeterministicClosureOverride(comment,ev){
  if(!comment||!ev||ev.deterministicHint!=="likely-implemented")return null;
  const text=String(comment.text||"");
  const targets=safeArray(comment.targetSheets).filter(Boolean);
  // Only hard-override narrowly scoped closure/removal comments. Multi-sheet comments still need M3.
  if(targets.length>1)return null;
  const removeIntent=/删除|取消|移除|关闭|清除|REMOVE|DELETE|CLOSE/i.test(text);
  if(!removeIntent)return null;

  const unresolved=/\b(CHECK|VERIFY|TBD|TBC|PENDING|HOLD)\b/i;
  for(const cand of safeArray(ev.candidates)){
    const sheet=String(cand?.sheetId||"");
    if(targets.length===1 && sheet && sheet!==targets[0])continue;
    const before=String(cand?.before||"");
    const after=String(cand?.after||"");
    if(cand?.type==="remove" && before.trim()){
      return {
        status:"implemented",
        confidence:.99,
        deterministicIds:[String(cand.id||"")].filter(Boolean),
        reason:"程序精确 Diff 已确认目标旧内容从新图中删除。"
      };
    }
    if(cand?.type==="replace" && unresolved.test(before) && !unresolved.test(after)){
      return {
        status:"implemented",
        confidence:.99,
        deterministicIds:[String(cand.id||"")].filter(Boolean),
        reason:"程序精确 Diff 已确认旧的未闭环标记被移除或替换为已协调/已解决表述。"
      };
    }
  }
  return null;
}

function normalizeCommentResult(parsed,body){
  const comments=safeArray(body?.comments?.items);
  const validComments=new Map(comments.map(x=>[String(x.id),x]));
  const evidenceMap=new Map(safeArray(body?.deterministic?.commentEvidence).map(x=>[String(x.commentId),x]));
  const validDiffs=new Set(safeArray(body?.deterministic?.textChanges).map(x=>String(x.id)));
  const rawItems=safeArray(parsed?.items);
  const byId=new Map();
  for(const x of rawItems){
    const id=String(x?.commentId||"");
    if(!validComments.has(id)||byId.has(id))continue;
    byId.set(id,x);
  }

  const items=comments.map(comment=>{
    const x=byId.get(String(comment.id))||{};
    const ev=evidenceMap.get(String(comment.id))||{};
    const ids=safeArray(x?.deterministicIds).filter(v=>typeof v==="string"&&validDiffs.has(v)).slice(0,16);
    const scopeOverride=missingTargetScopeOverride(comment,body);
    const explicitTextOverride=scopeOverride?null:explicitCoordinationTextOverride(comment,body);
    const closureOverride=(scopeOverride||explicitTextOverride)?null:safeDeterministicClosureOverride(comment,ev);
    const override=scopeOverride||explicitTextOverride||closureOverride;
    const status=override?.status||commentStatus(x?.status);
    const mergedIds=uniqStrings(ids.concat(safeArray(override?.deterministicIds).filter(v=>validDiffs.has(v)))).slice(0,16);
    return {
      commentId:String(comment.id),
      originalComment:String(comment.text||""),
      status,
      confidence:override?Math.max(confidence(x?.confidence),override.confidence):confidence(x?.confidence),
      impactedSheets:uniqStrings(safeArray(x?.impactedSheets).map(String).concat(safeArray(comment.targetSheets).map(String))).slice(0,16),
      conclusion:override?String(override.reason):String(x?.conclusion||"模型未返回明确结论，需人工复核"),
      oldEvidence:String(x?.oldEvidence||""),
      newEvidence:String(x?.newEvidence||""),
      deterministicIds:mergedIds,
      missingSync:scopeOverride?("缺少目标图纸："+scopeOverride.missing.join(", ")):explicitTextOverride?.missing?.length?("未形成明确协调说明："+explicitTextOverride.missing.join(", ")):closureOverride?"":String(x?.missingSync||""),
      reviewerAction:scopeOverride?"补充缺失目标图纸后重新检查。":explicitTextOverride?"复核目标图纸文字/标注并确认协调说明是否完整。":closureOverride?"抽查对应图纸并确认无其他联动遗漏。":String(x?.reviewerAction||"人工复核该意见及相关图纸"),
      deterministicHint:String(ev?.deterministicHint||""),
      deterministicOverride:Boolean(override),
      overrideType:scopeOverride?"missing-target-scope":explicitTextOverride?"explicit-coordination-text":closureOverride?"deterministic-closure":""
    };
  });

  const counts={total:items.length,implemented:0,partial:0,notFound:0,uncertain:0};
  for(const x of items){
    if(x.status==="implemented")counts.implemented++;
    else if(x.status==="partial")counts.partial++;
    else if(x.status==="not_found")counts.notFound++;
    else counts.uncertain++;
  }

  const unlisted=safeArray(parsed?.unlistedChanges).map((x,i)=>({
    id:"U"+String(i+1).padStart(2,"0"),
    category:String(x?.category||"其他"),
    location:String(x?.location||"位置待确认"),
    change:String(x?.change||x?.issue||"需人工确认"),
    evidence:String(x?.evidence||"证据不足"),
    action:String(x?.action||"确认是否为授权修改"),
    confidence:confidence(x?.confidence)
  })).slice(0,30);

  const limitations=safeArray(parsed?.limitations).map(String);
  const oldSource=Number(body?.drawing?.old?.sourcePages||0),oldScanned=Number(body?.drawing?.old?.scannedPages||0);
  const newSource=Number(body?.drawing?.new?.sourcePages||0),newScanned=Number(body?.drawing?.new?.scannedPages||0);
  if(oldSource>oldScanned||newSource>newScanned)limitations.unshift("A/B 图纸超过前端预扫范围；未扫描页不在本次自动判定范围内。");
  if((body?.deterministic?.textCoverage?.mode||"visual-only")!=="hybrid")limitations.unshift("A/B 图纸文字层不足，精确文字/数字证据较弱，关键意见必须人工复核。");
  if(!safeArray(body?.drawing?.selectedPairs).length)limitations.unshift("未生成可供 M3 查看 A/B 对照的关键页面，视觉类意见只能依据文字证据判断。");

  return {
    summary:String(parsed?.summary||"总工意见落实检查完成"),
    overall:String(parsed?.overall||"请优先复核部分落实、未找到和无法判定项。"),
    analysisMode:body?.deterministic?.textCoverage?.mode||"visual-only",
    closureStatus:(counts.notFound||counts.partial)?"needs-attention":(counts.uncertain?"review":"clear"),
    counts,
    items,
    unlistedChanges:unlisted,
    checklist:uniqStrings(safeArray(parsed?.checklist).map(String)).slice(0,24),
    limitations:uniqStrings(limitations).slice(0,16)
  };
}


const MAX_HISTORY_CANDIDATES=60;

const HISTORY_SYSTEM_PROMPT=[
  "你是 Agent Hong 的历史图纸语义检索重排器。用户已经在浏览器本地做过确定性检索，你只负责在给定候选页中判断哪些最符合查询意图。",
  "",
  "强制规则：",
  "1. 只能返回输入 candidates 中存在的 id，禁止创造项目、图号或页面。",
  "2. 如果查询包含明确图号、门窗号、ROOM编号、年份或精确尺寸，这些硬条件优先级高于语义相似。",
  "3. 项目名、图纸标题和 PDF 文字摘要都可以作为证据。",
  "4. relevance 范围 0.0-1.0；完全无关应低于 0.25。",
  "5. 对自然语言查询，例如‘找以前做过的屋顶花园防水节点’，可以理解同义表达，但不得声称候选文字里不存在的事实。",
  "6. 只输出严格 JSON，不要 Markdown，不要解释。",
  "",
  "输出：",
  "{\"intent\":\"一句话理解查询\",\"ranked\":[{\"id\":\"候选ID\",\"relevance\":0.0,\"reason\":\"为什么匹配\"}]}"
].join("\n");

function validateHistoryPayload(body){
  if(!body||typeof body!=="object")return "请求体无效";
  const query=String(body?.query||"").trim();
  if(!query)return "缺少检索词";
  if(query.length>500)return "检索词过长";
  const candidates=safeArray(body?.candidates);
  if(!candidates.length)return "缺少候选页";
  if(candidates.length>MAX_HISTORY_CANDIDATES)return "候选页最多 "+MAX_HISTORY_CANDIDATES+" 个";
  const ids=new Set();
  for(const x of candidates){
    const id=String(x?.id||"");
    if(!id)return "存在无 ID 候选页";
    if(ids.has(id))return "候选页 ID 重复";
    ids.add(id);
    if(String(x?.text||"").length>1200)return "候选页文字摘要过长";
  }
  return null;
}

async function callHistoryMiniMax(env,body){
  if(!env.MINIMAX_API_KEY)throw new Error("服务端尚未配置 MINIMAX_API_KEY");
  const base=(env.MINIMAX_API_BASE||"https://api.minimaxi.com/v1").replace(/\/$/,"");
  const model=env.MINIMAX_MODEL||"MiniMax-M3";
  const candidates=safeArray(body?.candidates).slice(0,MAX_HISTORY_CANDIDATES).map(x=>({
    id:String(x.id),
    projectName:String(x.projectName||""),
    projectYear:x.projectYear||null,
    fileName:String(x.fileName||""),
    pageNumber:Number(x.pageNumber||0),
    sheetId:x.sheetId||null,
    sheetTitle:String(x.sheetTitle||""),
    role:String(x.role||"other"),
    deterministicScore:Number(x.deterministicScore||0),
    text:String(x.text||"").slice(0,1200)
  }));
  const resp=await fetch(base+"/chat/completions",{
    method:"POST",
    headers:{Authorization:"Bearer "+env.MINIMAX_API_KEY,"content-type":"application/json"},
    body:JSON.stringify({
      model,
      messages:[
        {role:"system",content:HISTORY_SYSTEM_PROMPT},
        {role:"user",content:"查询："+String(body.query)+"\n候选页 JSON：\n"+JSON.stringify(candidates)}
      ],
      temperature:0,
      max_completion_tokens:4500,
      reasoning_split:true,
      thinking:{type:"adaptive"}
    })
  });
  const raw=await resp.text();
  if(!resp.ok)throw new Error("MiniMax API "+resp.status+": "+raw.slice(0,600));
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax 返回了非 JSON 响应")}
  let parsed;try{parsed=parseModelContent(envelope)}catch(e){throw new Error("历史图纸重排结果解析失败："+(e?.message||e))}
  return {parsed,usage:envelope.usage||null,model,candidates};
}

function normalizeHistoryResult(parsed,candidates){
  const valid=new Map(candidates.map(x=>[String(x.id),x]));
  const seen=new Set(),ranked=[];
  for(const x of safeArray(parsed?.ranked)){
    const id=String(x?.id||"");
    if(!valid.has(id)||seen.has(id))continue;
    seen.add(id);
    ranked.push({
      id,
      relevance:confidence(x?.relevance),
      reason:String(x?.reason||"语义相关")
    });
  }
  ranked.sort((a,b)=>b.relevance-a.relevance);
  return {intent:String(parsed?.intent||""),ranked:ranked.slice(0,20)};
}



const GEOTECH_KEYS=["site_class","seismic","groundwater","soil_layers","bearing_capacity","pile_conditions","liquefaction","corrosion","adverse_geology","excavation","dewatering","exploration"];
const MAX_GEOTECH_CANDIDATES=36;

const GEOTECH_SYSTEM_PROMPT=[
  "你是 Agent Hong 的地勘报告设计条件整理引擎。你只能根据程序从地勘报告文字层抽取的 Gxxxx 候选证据工作，不得依靠常识或训练记忆补造报告内容。",
  "",
  "目标：把证据整理成建筑/结构设计前期可读的地勘条件表。不是替代岩土工程师做基础设计。",
  "",
  "强制规则：",
  "1. conditions 必须覆盖指定的 12 个 key，每个 key 恰好一项。",
  "2. found / needs_review 必须至少引用一个输入 candidates 中真实存在的 Gxxxx；没有有效引用必须 not_found。polarity=absent 表示原报告明确说明该类资料/参数未提供，它只能支持 not_found，不能支持 found。",
  "3. 精确数字、单位、标高、埋深、承载力、孔深、桩参数只能来自 citations 所引用的原文，禁止估算、换算、推断或补全。",
  "4. 不要把‘建议’改写成确定的设计值。例如报告说 recommended / 建议，应保留‘建议’属性。",
  "5. 不得自行确定基础形式、桩长、桩径、基坑支护形式或降水方案；只能整理报告已明确写出的条件/建议，并指出设计需复核什么。",
  "6. 报告对液化/腐蚀性/不良地质的判断必须忠实保留否定词和程度词。",
  "7. 若同一条件在不同页有冲突、范围或不同工况，status=needs_review，并在 value 中保留差异。",
  "8. 不得把地勘报告中的抗震参数扩展为建筑抗震合规结论。",
  "9. 只输出严格 JSON，不要 Markdown。",
  "",
  "固定 key：site_class,seismic,groundwater,soil_layers,bearing_capacity,pile_conditions,liquefaction,corrosion,adverse_geology,excavation,dewatering,exploration",
  "",
  "输出：",
  "{\"summary\":\"一句话\",\"overall\":\"2-4句话\",\"conditions\":[{\"key\":\"groundwater\",\"status\":\"found|needs_review|not_found\",\"value\":\"报告条件，精确数字必须来自引用证据\",\"designImplication\":\"设计阶段下一步应关注什么，不自行做专业决定\",\"citations\":[\"G证据ID\"],\"confidence\":0.0}],\"checklist\":[\"人工复核动作\"],\"limitations\":[\"分析边界\"]}"
].join("\n");

function validateGeotechPayload(body){
  if(!body||typeof body!=="object")return "请求体无效";
  const cs=safeArray(body?.candidates);
  if(!cs.length)return "没有抽取到可用于整理的地勘文字证据";
  if(cs.length>MAX_GEOTECH_CANDIDATES)return "地勘候选证据最多 "+MAX_GEOTECH_CANDIDATES+" 条";
  const ids=new Set();
  for(const x of cs){
    const id=String(x?.id||"");if(!id)return "地勘证据缺少 ID";if(ids.has(id))return "地勘证据 ID 重复";ids.add(id);
    if(!GEOTECH_KEYS.includes(String(x?.key||"")))return "地勘证据分类无效";
    if(String(x?.text||"").length>3500)return "单条地勘证据过长";
  }
  return null;
}

async function repairGeotechJson(env,model,broken){
  const base=(env.MINIMAX_API_BASE||"https://api.minimaxi.com/v1").replace(/\/$/,"");
  const resp=await fetch(base+"/chat/completions",{
    method:"POST",
    headers:{Authorization:"Bearer "+env.MINIMAX_API_KEY,"content-type":"application/json"},
    body:JSON.stringify({
      model,
      messages:[
        {role:"system",content:"你是 JSON 修复器。输入是一段本应为严格 JSON 的地勘条件提取结果，但可能存在漏逗号、未转义引号或代码围栏。只修复 JSON 语法，不改变任何字段值、状态、引用、数值、置信度或语义。只输出一个严格 JSON 对象，不要解释。"},
        {role:"user",content:String(broken||"").slice(0,28000)}
      ],
      temperature:0,
      max_completion_tokens:6500
    })
  });
  const raw=await resp.text();
  if(!resp.ok)throw new Error("MiniMax geotech JSON repair API "+resp.status+": "+raw.slice(0,500));
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax geotech JSON repair 返回非 JSON 响应")}
  return {parsed:parseModelContent(envelope),usage:envelope.usage||null};
}

async function callGeotechMiniMax(env,body){
  if(!env.MINIMAX_API_KEY)throw new Error("服务端尚未配置 MINIMAX_API_KEY");
  const base=(env.MINIMAX_API_BASE||"https://api.minimaxi.com/v1").replace(/\/$/,""),model=env.MINIMAX_MODEL||"MiniMax-M3";
  const candidates=safeArray(body.candidates).map(x=>({
    id:String(x.id),key:String(x.key),label:String(x.label||""),documentName:String(x.documentName||""),
    pageNumber:Number(x.pageNumber||0),text:String(x.text||"").slice(0,3500),polarity:String(x.polarity||"positive"),
    numbers:safeArray(x.numbers),depthRange:x.depthRange||null
  }));
  const user={
    projectName:String(body?.projectName||""),
    notes:String(body?.notes||""),
    documents:safeArray(body?.documents),
    deterministicCoverage:body?.coverage||{},
    candidates
  };
  const resp=await fetch(base+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+env.MINIMAX_API_KEY,"content-type":"application/json"},body:JSON.stringify({
    model,messages:[{role:"system",content:GEOTECH_SYSTEM_PROMPT},{role:"user",content:"地勘证据 JSON：\n"+JSON.stringify(user)}],
    temperature:0,max_completion_tokens:7000,reasoning_split:true,thinking:{type:"adaptive"}
  })});
  const raw=await resp.text();if(!resp.ok)throw new Error("MiniMax API "+resp.status+": "+raw.slice(0,600));
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax 返回非 JSON 响应")}
  try{
    return {parsed:parseModelContent(envelope),usage:envelope.usage||null,model,candidates,repaired:false};
  }catch(firstError){
    const broken=modelContentAsText(envelope);
    if(!broken)throw new Error("地勘条件结构化结果解析失败："+(firstError?.message||firstError));
    try{
      const repaired=await repairGeotechJson(env,model,broken);
      return {parsed:repaired.parsed,usage:mergeUsage(envelope.usage||null,repaired.usage||null),model,candidates,repaired:true};
    }catch(repairError){
      throw new Error("地勘条件结构化结果解析失败："+(firstError?.message||firstError)+"；自动 JSON 修复也失败："+(repairError?.message||repairError));
    }
  }
}

function numericTokens(text){
  return (String(text||"").match(/-?\d+(?:\.\d+)?/g)||[]).map(x=>String(Number(x))).filter(x=>x!=="NaN");
}
function unsupportedNumbers(value,evs){
  const output=uniqStrings(numericTokens(value));
  if(!output.length)return [];
  const evidence=new Set();
  for(const e of evs)for(const n of numericTokens(e?.text||""))evidence.add(n);
  return output.filter(n=>!evidence.has(n));
}

function normalizeGeotechResult(parsed,candidates,body){
  const valid=new Map(candidates.map(x=>[String(x.id),x]));
  const rawByKey=new Map(safeArray(parsed?.conditions).map(x=>[String(x?.key||""),x]));
  const conditions=GEOTECH_KEYS.map(key=>{
    const raw=rawByKey.get(key)||{};
    const keyCandidates=candidates.filter(e=>e.key===key);
    const positiveCandidates=keyCandidates.filter(e=>e.polarity!=="absent");
    const absenceCandidates=keyCandidates.filter(e=>e.polarity==="absent");
    const citations=uniqStrings(safeArray(raw?.citations).map(String).filter(id=>valid.has(id))).slice(0,10);
    let evs=citations.map(id=>valid.get(id));
    let status;
    if(!positiveCandidates.length&&absenceCandidates.length){
      status="not_found";
      const absenceIds=absenceCandidates.slice(0,3).map(e=>e.id);
      if(!citations.length){citations.push(...absenceIds);evs=citations.map(id=>valid.get(id));}
    }else if(raw?.status==="not_found"){
      status="not_found";
    }else{
      status=citations.length&&["found","needs_review"].includes(raw?.status)?raw.status:(citations.length?"found":"not_found");
    }
    let value=status==="not_found"
      ?(absenceCandidates.length?"报告明确说明该类资料/参数未提供":"未在当前报告证据中找到")
      :String(raw?.value||"需人工复核");
    let implication=status==="not_found"
      ?(absenceCandidates.length?"原报告明确未提供该类参数；需补充相应地勘资料或由岩土专业确认。":"补充地勘资料或人工复核原报告。")
      :String(raw?.designImplication||"需人工复核");
    const badNums=unsupportedNumbers(value,evs);
    if(status!=="not_found"&&badNums.length){
      status="needs_review";
      implication+="；模型输出包含未在引用原文中找到的数字（"+badNums.join(", ")+"），该数字不得直接采用。";
    }
    return {
      key,status,value,designImplication:implication,citations,
      pages:uniqStrings(evs.map(e=>String(e.pageNumber))).map(Number).sort((a,b)=>a-b),
      confidence:status==="not_found"?0:confidence(raw?.confidence),
      unsupportedNumbers:badNums
    };
  });
  const counts={found:0,needsReview:0,notFound:0};
  for(const x of conditions){if(x.status==="found")counts.found++;else if(x.status==="needs_review")counts.needsReview++;else counts.notFound++}
  const limitations=uniqStrings(safeArray(parsed?.limitations).map(String));
  const docs=safeArray(body?.documents);
  if(docs.some(d=>Number(d.sourcePages||0)>Number(d.scannedPages||0)))limitations.unshift("至少一个地勘文件超过前端扫描上限，未扫描页不在本次证据范围内。");
  return {
    summary:String(parsed?.summary||"地勘设计条件提取完成"),
    overall:String(parsed?.overall||"请按条件表回看原报告并由岩土/结构专业确认。"),
    counts,conditions,
    checklist:uniqStrings(safeArray(parsed?.checklist).map(String)).slice(0,24),
    limitations:uniqStrings(limitations).slice(0,16)
  };
}

async function handleGeotechConditions(request,env){
  const len=Number(request.headers.get("content-length")||"0");if(len>3*1024*1024)return json({error:"地勘条件请求过大"},413);
  let body;try{body=await request.json()}catch{return json({error:"请求 JSON 无效"},400)}
  const error=validateGeotechPayload(body);if(error)return json({error},400);
  try{
    const {parsed,usage,model,candidates,repaired}=await callGeotechMiniMax(env,body);
    return json({ok:true,result:normalizeGeotechResult(parsed,candidates,body),usage,model,structuredRepair:Boolean(repaired)});
  }catch(e){console.error("geotech_conditions_failed",e);return json({error:e?.message||"地勘条件整理失败"},502)}
}

const MAX_REFERENCE_CANDIDATES=12;
const REFERENCE_SYSTEM_PROMPT=[
  "你是 Agent Hong 的规范/院标依据解释器。你绝对不能依靠记忆回答规范要求，只能使用用户当前提供的候选证据。",
  "",
  "强制规则：",
  "1. candidates 是唯一允许使用的事实来源。禁止补充候选里没有的条文号、数值、适用范围、法规名称或结论。",
  "2. citations 只能填写 candidates 中存在的 id。每个实质性结论必须至少有一个有效 citation。",
  "3. 如果候选证据不足以回答问题，status 必须为 not_found，answer 明确说明‘在当前资料库中未找到足够依据’，citations 为空。",
  "4. mode=clause 时，重点解释条文内容、适用对象和原文含义，不扩展到资料之外。",
  "5. mode=issue 时，可以把用户描述的事实与候选条文中的条件做比较；若数值关系明确，可以说‘基于当前上传依据，该条件不满足/满足’，但不得升级为法定合规或违法结论。",
  "6. 不得把院标、甲方要求、项目审查要点误称为国家规范。必须保留 documentType。",
  "7. 对候选之间冲突或版本不明，status=needs_review，并明确冲突来源。",
  "8. 只输出严格 JSON，不要 Markdown。",
  "",
  "输出：",
  "{\"status\":\"supported|needs_review|not_found\",\"title\":\"简短标题\",\"answer\":\"有依据的解释\",\"citations\":[\"候选证据ID\"],\"caveat\":\"边界或需复核项\"}"
].join("\n");

function validateReferencePayload(body){
  if(!body||typeof body!=="object")return "请求体无效";
  const q=String(body?.query||"").trim();if(!q)return "缺少问题";if(q.length>1200)return "问题过长";
  if(!["clause","issue"].includes(String(body?.mode||"")))return "mode 无效";
  const cs=safeArray(body?.candidates);if(!cs.length)return "缺少候选证据";if(cs.length>MAX_REFERENCE_CANDIDATES)return "候选证据最多 "+MAX_REFERENCE_CANDIDATES+" 条";
  const ids=new Set();
  for(const x of cs){const id=String(x?.id||"");if(!id)return "证据缺少 ID";if(ids.has(id))return "证据 ID 重复";ids.add(id);if(String(x?.text||"").length>5000)return "单条证据过长";}
  return null;
}
async function callReferenceMiniMax(env,body){
  if(!env.MINIMAX_API_KEY)throw new Error("服务端尚未配置 MINIMAX_API_KEY");
  const base=(env.MINIMAX_API_BASE||"https://api.minimaxi.com/v1").replace(/\/$/,""),model=env.MINIMAX_MODEL||"MiniMax-M3";
  const candidates=safeArray(body.candidates).map(x=>({
    id:String(x.id),documentName:String(x.documentName||""),documentType:String(x.documentType||""),version:String(x.version||""),
    pageNumber:Number(x.pageNumber||0),clause:x.clause?String(x.clause):null,text:String(x.text||"").slice(0,5000),deterministicScore:Number(x.score||0)
  }));
  const resp=await fetch(base+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+env.MINIMAX_API_KEY,"content-type":"application/json"},body:JSON.stringify({
    model,messages:[{role:"system",content:REFERENCE_SYSTEM_PROMPT},{role:"user",content:"mode="+body.mode+"\n用户问题："+body.query+"\n候选证据 JSON：\n"+JSON.stringify(candidates)}],
    temperature:0,max_completion_tokens:5000,reasoning_split:true,thinking:{type:"adaptive"}
  })});
  const raw=await resp.text();if(!resp.ok)throw new Error("MiniMax API "+resp.status+": "+raw.slice(0,600));
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax 返回非 JSON 响应")}
  let parsed;try{parsed=parseModelContent(envelope)}catch(e){throw new Error("依据解释结构化结果解析失败："+(e?.message||e))}
  return {parsed,usage:envelope.usage||null,model,candidates};
}
function normalizeReferenceAnswer(parsed,candidates){
  const valid=new Set(candidates.map(x=>x.id));
  const citations=uniqStrings(safeArray(parsed?.citations).map(String).filter(x=>valid.has(x))).slice(0,8);
  if(!citations.length)return {status:"not_found",title:"当前资料库未形成可引用结论",answer:"在当前资料库候选证据中未找到足够依据，不能据此形成规范/院标结论。",citations:[],caveat:"可补充相关规范、院标或项目要求后重新检索。",grounded:false};
  const status=["supported","needs_review"].includes(parsed?.status)?parsed.status:"supported";
  return {status,title:String(parsed?.title||"依据解释"),answer:String(parsed?.answer||"请查看引用证据。"),citations,caveat:String(parsed?.caveat||""),grounded:true};
}
async function handleReferenceAnswer(request,env){
  const len=Number(request.headers.get("content-length")||"0");if(len>1024*1024)return json({error:"依据解释请求过大"},413);
  let body;try{body=await request.json()}catch{return json({error:"请求 JSON 无效"},400)}
  const error=validateReferencePayload(body);if(error)return json({error},400);
  try{const {parsed,usage,model,candidates}=await callReferenceMiniMax(env,body);return json({ok:true,answer:normalizeReferenceAnswer(parsed,candidates),usage,model})}
  catch(e){console.error("reference_answer_failed",e);return json({error:e?.message||"依据解释失败"},502)}
}

async function handleHistorySearch(request,env){
  const len=Number(request.headers.get("content-length")||"0");
  if(len>2*1024*1024)return json({error:"历史检索请求过大"},413);
  let body;try{body=await request.json()}catch{return json({error:"请求 JSON 无效"},400)}
  const error=validateHistoryPayload(body);if(error)return json({error},400);
  try{
    const {parsed,usage,model,candidates}=await callHistoryMiniMax(env,body);
    return json({ok:true,...normalizeHistoryResult(parsed,candidates),usage,model});
  }catch(e){console.error("history_search_failed",e);return json({error:e?.message||"历史图纸语义重排失败"},502)}
}

async function handleCommentCheck(request,env){
  const len=Number(request.headers.get("content-length")||"0");
  if(len>MAX_BODY_BYTES)return json({error:"请求过大，最大 38MB"},413);
  let body;try{body=await request.json()}catch{return json({error:"请求 JSON 无效"},400)}
  const error=validateCommentPayload(body);if(error)return json({error},400);
  try{
    const {parsed,usage,model,repaired}=await callCommentMiniMax(env,body);
    return json({ok:true,result:normalizeCommentResult(parsed,body),usage,model,structuredRepair:Boolean(repaired)});
  }catch(e){console.error("comment_check_failed",e);return json({error:e?.message||"意见落实检查失败"},502)}
}

async function handleReview(request,env){
  const len=Number(request.headers.get("content-length")||"0");
  if(len>MAX_BODY_BYTES)return json({error:"请求过大，最大 38MB"},413);
  let body;try{body=await request.json()}catch{return json({error:"请求 JSON 无效"},400)}
  const error=validateReviewPayload(body);if(error)return json({error},400);
  try{
    const {parsed,usage,model}=await callReviewMiniMax(env,body);
    return json({ok:true,result:normalizeReviewResult(parsed,body),usage,model});
  }catch(e){console.error("review_failed",e);return json({error:e?.message||"预审失败"},502)}
}

async function handleCompare(request,env){
  const len=Number(request.headers.get("content-length")||"0");
  if(len>MAX_BODY_BYTES)return json({error:"请求过大，最大 38MB"},413);
  let body;try{body=await request.json()}catch{return json({error:"请求 JSON 无效"},400)}
  const error=validatePayload(body);if(error)return json({error},400);
  try{
    const {parsed,usage,model}=await callMiniMax(env,body);
    return json({ok:true,result:normalizeModelResult(parsed,body),usage,model});
  }catch(e){console.error("compare_failed",e);return json({error:e?.message||"分析失败"},502)}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/smoke"||url.pathname==="/smoke.html"||url.pathname==="/pdf-e2e-test"||url.pathname==="/pdf-e2e-test.html"||url.pathname.startsWith("/testdata/")){
      return new Response("Not found",{status:404,headers:{"content-type":"text/plain; charset=utf-8"}});
    }
    if(url.pathname==="/api/health")return json({ok:true,product:"Agent Hong",feature:"architectural-ai-workbench",engine:"agent-hong-v1.6.2",modules:["version-diff","drawing-review","comment-check","history-search","reference-assistant","geotech-conditions"],moduleVersions:{"version-diff":"hybrid-v1","drawing-review":"precheck-v2","comment-check":"closure-v1","history-search":"local-search-v1","reference-assistant":"grounding-v1","geotech-conditions":"conditions-v1"},model:env.MINIMAX_MODEL||"MiniMax-M3",configured:Boolean(env.MINIMAX_API_KEY)});
    if(url.pathname==="/api/geotech-conditions"&&request.method==="POST")return handleGeotechConditions(request,env);
    if(url.pathname==="/api/reference-answer"&&request.method==="POST")return handleReferenceAnswer(request,env);
    if(url.pathname==="/api/history-search"&&request.method==="POST")return handleHistorySearch(request,env);
    if(url.pathname==="/api/comment-check"&&request.method==="POST")return handleCommentCheck(request,env);
    if(url.pathname==="/api/review"&&request.method==="POST")return handleReview(request,env);
    if(url.pathname==="/api/compare"&&request.method==="POST")return handleCompare(request,env);
    if(url.pathname.startsWith("/api/"))return json({error:"Not found"},404);
    return env.ASSETS.fetch(request);
  }
};
