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


function module02RegressionFixture(kind){
  const ref=[
    {id:"R001",page:null,text:"All door and window marks shown on floor plans shall be included in the Door & Window Schedule before IFC issue."},
    {id:"R002",page:null,text:"Room 102 shall be named MEETING ROOM throughout the architectural drawing set."},
    {id:"R003",page:null,text:"No CHECK, VERIFY, TBD, TBC, PENDING or HOLD note may remain in the final IFC drawing issue."},
    {id:"R004",page:null,text:"The Drawing Index shall list every issued architectural sheet and shall not list non-issued sheets."},
    {id:"R005",page:null,text:"Cross-sheet references shall resolve to an issued drawing in the same architectural set unless explicitly identified as another discipline."},
    {id:"R006",page:null,text:"Window W03 shall appear consistently on the Level 1 Floor Plan, South Elevation and Door & Window Schedule."}
  ];
  const bad=kind==="bad";
  const pages=bad?[
    ["A-000","DRAWING INDEX A-000 A-101 A-201 A-301 A-501 A-601 A-502"],
    ["A-101","LEVEL 1 FLOOR PLAN A-101 W01 W02 W03 W04 D01 D02 D03 D04 D05 ROOM 102: MEETING ROOM A-501 A-502 A-201 CHECK D05 WITH DOOR SCHEDULE VERIFY W03 IN ELEVATION"],
    ["A-201","SOUTH ELEVATION A-201 W01 W02 W04 D01 TBD CONFIRM W03 ON SOUTH ELEVATION"],
    ["A-301","BUILDING SECTION A-A A-301 VERIFY PARAPET BUILD-UP WITH DETAIL A-503 HOLD FIRESTOP DETAIL TO BE CONFIRMED"],
    ["A-501","TOILET DETAIL A-501 ROOM 102: STORAGE PENDING FLOOR FINISH CODE"],
    ["A-601","DOOR WINDOW SCHEDULE A-601 D01 DOOR D02 DOOR D03 DOOR D04 DOOR D09 DOOR W01 WINDOW W02 WINDOW W04 WINDOW VERIFY W03 AND D05 BEFORE IFC ISSUE"],
    ["A-701","GENERAL NOTES A-701 ROOM 102 SHALL BE MEETING ROOM CHECK CLIENT TO CONFIRM WALL FINISH"]
  ]:[
    ["A-000","DRAWING INDEX A-000 A-101 A-201 A-301 A-501 A-601 A-701"],
    ["A-101","LEVEL 1 FLOOR PLAN A-101 W01 W02 W03 W04 D01 D02 D03 D04 D05 ROOM 102: MEETING ROOM A-501 A-201"],
    ["A-201","SOUTH ELEVATION A-201 W01 W02 W03 W04 D01 W03 COORDINATED WITH A-101 A-601"],
    ["A-301","BUILDING SECTION A-A A-301 A-501 FIRESTOP DETAIL COORDINATED"],
    ["A-501","TOILET DETAIL A-501 ROOM 103: TOILET FLOOR FINISH FL-01"],
    ["A-601","DOOR WINDOW SCHEDULE A-601 D01 DOOR D02 DOOR D03 DOOR D04 DOOR D05 DOOR W01 WINDOW W02 WINDOW W03 WINDOW W04 WINDOW"],
    ["A-701","GENERAL NOTES A-701 ROOM 102 SHALL BE MEETING ROOM WALL FINISH CONFIRMED WF-01"]
  ];
  const drawingPages=pages.map((p,i)=>({pageNumber:i+1,sheetId:p[0],textDigest:p[1],textDigestTruncated:false,textItemCount:30,image:"data:image/png;base64,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"}));
  const hard=bad?[
    {id:"P001",severity:"high",category:"图纸目录",location:"A-000",issue:"图纸目录列出当前套图中不存在的图号",evidence:"目录列出 A-502"},
    {id:"P002",severity:"medium",category:"图纸目录",location:"A-000",issue:"当前套图存在未列入图纸目录的已发行图号",evidence:"未列入目录 A-701"},
    {id:"P003",severity:"high",category:"门窗一致性",location:"A-101",issue:"平面出现窗号 W03，但门窗表未检出",evidence:"A-601 无 W03"},
    {id:"P004",severity:"high",category:"门窗一致性",location:"A-101",issue:"平面出现门号 D05，但门窗表未检出",evidence:"A-601 无 D05"},
    {id:"P005",severity:"medium",category:"门窗一致性",location:"A-601",issue:"门窗表存在孤立门号 D09",evidence:"平面未检出 D09"},
    {id:"P006",severity:"high",category:"房间编号/名称",location:"A-101, A-501",issue:"同一房间编号 ROOM 102 出现多个名称",evidence:"MEETING ROOM ↔ STORAGE"},
    {id:"P007",severity:"medium",category:"图纸引用",location:"A-301",issue:"检测到当前套图中未找到的图号引用",evidence:"A-503"},
    {id:"P008",severity:"medium",category:"未闭环标记",location:"A-101",issue:"发现待确认类文字",evidence:"CHECK D05; VERIFY W03"},
    {id:"P009",severity:"medium",category:"未闭环标记",location:"A-201",issue:"发现待确认类文字",evidence:"TBD W03"},
    {id:"P010",severity:"medium",category:"未闭环标记",location:"A-301",issue:"发现待确认类文字",evidence:"VERIFY A-503; HOLD FIRESTOP"},
    {id:"P011",severity:"medium",category:"未闭环标记",location:"A-501",issue:"发现待确认类文字",evidence:"PENDING FLOOR FINISH"},
    {id:"P012",severity:"medium",category:"未闭环标记",location:"A-601",issue:"发现待确认类文字",evidence:"VERIFY W03 D05"},
    {id:"P013",severity:"medium",category:"未闭环标记",location:"A-701",issue:"发现待确认类文字",evidence:"CHECK CLIENT"}
  ]:[];
  return {
    projectName:"Agent Hong Module 02 "+kind+" sample",focus:"施工图预审双样品回归",
    drawing:{name:kind+".pdf",type:"pdf",sourcePages:7,scannedPages:7,selectedPageNumbers:[1,2,3,4,5,6,7],selection:[],pages:drawingPages},
    reference:{name:"ProjectRequirements.txt",mode:"text",truncated:false,pagesRead:1,chunks:ref,text:ref.map(x=>x.id+": "+x.text).join("\n")},
    deterministic:{textCoverage:{mode:"hybrid",totalTextItems:210,pagesWithText:7,pagesWithSheetId:7,scannedPages:7,sourcePages:7},sheets:[],alerts:hard,indices:{},fullyLoaded:true}
  };
}
async function runModule02Regression(env,kind){
  const body=module02RegressionFixture(kind);
  const {parsed,usage,model}=await callReviewMiniMax(env,body);
  const result=normalizeReviewResult(parsed,body);
  const dump=JSON.stringify(result);
  const bad=kind==="bad";
  const checks=bad?{
    hardCount:result.hardAlerts.length>=10,
    w03:/W03/.test(dump)&&/A-201|立面/.test(dump)&&/A-601|门窗表|SCHEDULE/i.test(dump),
    room102:/ROOM 102/.test(dump)&&/MEETING ROOM/.test(dump)&&/STORAGE/.test(dump),
    a503:/A-503/.test(dump),
    unresolved:/CHECK|VERIFY|TBD|PENDING|HOLD/.test(dump),
    refUsed:(result.counts?.referenceBased||0)>=2
  }:{
    noHardHigh:result.hardAlerts.filter(x=>x.severity==="high").length===0,
    lowFalsePositive:(result.counts?.highRisk||0)===0,
    noFakeConflict:!/STORAGE|A-503|D09/.test(dump)
  };
  return {ok:Object.values(checks).every(Boolean),kind,checks,result,usage,model};
}
async function handleModule02Regression(env){
  try{
    const bad=await runModule02Regression(env,"bad");
    const clean=await runModule02Regression(env,"clean");
    return json({ok:bad.ok&&clean.ok,bad,clean});
  }catch(e){return json({ok:false,error:e?.message||"module02 regression failed"});}
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
    if(url.pathname==="/api/health")return json({ok:true,product:"Agent Hong",feature:"drawing-version-diff",engine:"agent-hong-v1.2",modules:["version-diff","drawing-review"],moduleVersions:{"version-diff":"hybrid-v1","drawing-review":"precheck-v2"},model:env.MINIMAX_MODEL||"MiniMax-M3",configured:Boolean(env.MINIMAX_API_KEY)});
    if(url.pathname==="/api/__module02_v2_regression"&&request.method==="GET")return handleModule02Regression(env);
    if(url.pathname==="/api/review"&&request.method==="POST")return handleReview(request,env);
    if(url.pathname==="/api/compare"&&request.method==="POST")return handleCompare(request,env);
    if(url.pathname.startsWith("/api/"))return json({error:"Not found"},404);
    return env.ASSETS.fetch(request);
  }
};
