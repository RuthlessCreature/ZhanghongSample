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


const REVIEW_SYSTEM_PROMPT = [
  "你是 Agent Hong 的建筑施工图 AI 预审引擎。你的职责是先帮助设计院发现明显问题和跨图不一致，不替代设计负责人、注册执业人员或法定施工图审查。",
  "",
  "你会收到四类证据：",
  "A. deterministic.alerts：程序从 PDF 文字层和规则引擎得到的硬检查结果，优先级最高。",
  "B. drawing.pages[].textDigest：PDF 文字层摘要；精确编号、文字、尺寸若引用，优先使用这里或 A 类。",
  "C. drawing.pages[].image：完整页面低精度图，用于理解图形、空间、构件和跨图关系。",
  "D. reference.text：用户可选上传的院标、甲方要求或审查要点。只有这里明确存在的依据，才允许说‘不符合用户提供的依据’。",
  "",
  "强制规则：",
  "1. 没有 reference.text 时，禁止声称‘违反规范’‘符合规范’或编造任何条文编号。最多写‘需按适用规范/院标复核’。",
  "2. 程序硬检查结果不得被视觉 OCR 覆盖；编号、图号、门窗号等冲突以程序文字证据优先。",
  "3. 重点检查：图号/图框、门窗编号与门窗表、平立剖一致性、房间名称/编号、详图索引、文字说明、CHECK/VERIFY/TBD 等未闭环项、明显尺寸/标高表达风险。",
  "4. 不要为了凑数量重复 deterministic.alerts；AI issues 应补充工程语义、视觉问题或 deterministic 问题的实际影响。",
  "5. 对跨图问题，要明确指出涉及哪些图号/页、为什么怀疑不一致、下一步怎么复核。",
  "6. 对 CLR、CL、AFF 等多义缩写保持原文；图纸未明确含义时不得自行展开。",
  "7. 看不清或证据不足时必须降低 confidence 并写‘需人工复核’，不得补造尺寸、构件或规范。",
  "8. 只输出严格 JSON，不要 Markdown，不要代码围栏。",
  "",
  "输出 JSON：",
  '{',
  '  "summary":"一句话摘要",',
  '  "overall":"2-4句话整体判断",',
  '  "issues":[{"id":"I01","severity":"high|medium|low","category":"图号/图框|门窗一致性|跨图一致性|尺寸/标高|编号/索引|文字说明|未闭环标记|构件/空间|规范待核|其他","location":"图号/页码/位置","issue":"问题","evidence":"证据","why":"为什么值得看","action":"复核动作","evidenceSource":"pdf_text|mixed|visual|ai|reference","deterministicIds":["P001"],"confidence":0.0}],',
  '  "crossSheetRisks":[{"id":"X01","severity":"high|medium|low","category":"跨图一致性","location":"A-101 ↔ A-601","issue":"风险","evidence":"证据","why":"影响","action":"复核动作","evidenceSource":"mixed|pdf_text|visual|ai|reference","deterministicIds":["P001"],"confidence":0.0}],',
  '  "checklist":["人工复核动作"],',
  '  "limitations":["分析局限"],',
  '  "sheetSummary":[{"sheetId":"A-101","page":1,"role":"plan|elevation|section|schedule|detail|notes|other","note":"该页关键内容/风险"}]',
  '}'
].join("\\n");

function validateReviewPayload(body){
  if(!body||typeof body!=="object")return "请求体无效";
  const d=body.drawing;
  if(!d||!Array.isArray(d.pages)||!d.pages.length)return "缺少施工图页面";
  if(d.pages.length>MAX_PAGES)return "施工图最多支持前 "+MAX_PAGES+" 页";
  for(const p of d.pages)if(!p||!validImage(p.image))return "施工图页面格式无效";
  if(String(body?.reference?.text||"").length>38000)return "参考资料文字过长";
  const alerts=safeArray(body?.deterministic?.alerts);
  if(alerts.length>100)return "程序硬检查结果过多";
  const total=d.pages.reduce((n,p)=>n+dataUrlBytes(p.image),0);
  if(total>34*1024*1024)return "预处理后的施工图图像超过 34MB";
  return null;
}

function reviewEvidenceForPrompt(body){
  const d=body?.deterministic||{};
  return {
    textCoverage:d.textCoverage||{},
    sheets:safeArray(d.sheets).slice(0,MAX_PAGES),
    alerts:safeArray(d.alerts).slice(0,100),
    indices:d.indices||{},
    fullyLoaded:Boolean(d.fullyLoaded)
  };
}

function buildReviewContent(body){
  const content=[];
  const evidence=reviewEvidenceForPrompt(body);
  const referenceText=String(body?.reference?.text||"");
  content.push({type:"text",text:
    "项目："+(body.projectName||"未填写")+
    "\\n重点关注："+(body.focus||"无")+
    "\\n\\n程序硬检查 JSON：\\n"+JSON.stringify(evidence)+
    "\\n\\n用户参考资料："+(referenceText?("\\n"+referenceText):"未提供。不得输出规范符合/违反结论。")
  });
  safeArray(body?.drawing?.pages).forEach((p,i)=>{
    content.push({type:"text",text:
      "施工图第 "+(i+1)+" 页｜图号 "+(p.sheetId||"未识别")+
      "\\nPDF文字层摘要："+String(p.textDigest||"")+
      (p.textDigestTruncated?"\\n[文字摘要已截断]":"")
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
      temperature:.1,
      max_completion_tokens:7000,
      reasoning_split:true,
      thinking:{type:"adaptive"}
    })
  });
  const raw=await resp.text();
  if(!resp.ok)throw new Error("MiniMax API "+resp.status+": "+raw.slice(0,600));
  let envelope;try{envelope=JSON.parse(raw)}catch{throw new Error("MiniMax 返回了非 JSON 响应")}
  let parsed;try{parsed=parseModelContent(envelope)}catch(e){throw new Error("预审结构化结果解析失败："+(e?.message||e))}
  return {parsed,usage:envelope.usage||null,model};
}

function reviewSource(v,fallback="ai"){return ["pdf_text","mixed","visual","ai","reference"].includes(v)?v:fallback}

function normalizeReviewIssue(x,i,prefix){
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
    deterministicIds:safeArray(x?.deterministicIds).filter(v=>typeof v==="string").slice(0,12),
    confidence:confidence(x?.confidence)
  };
}

function normalizeReviewResult(parsed,body){
  const hard=safeArray(body?.deterministic?.alerts).slice(0,100);
  const issues=safeArray(parsed?.issues).map((x,i)=>normalizeReviewIssue(x,i,"I")).slice(0,60);
  const cross=safeArray(parsed?.crossSheetRisks).map((x,i)=>normalizeReviewIssue(x,i,"X")).slice(0,40);
  const highRisk=[...hard,...issues,...cross].filter(x=>x.severity==="high").length;
  const mode=body?.deterministic?.textCoverage?.mode||"visual-only";
  const limitations=safeArray(parsed?.limitations).map(String).slice(0,12);
  if(body?.drawing?.sourcePages>MAX_PAGES)limitations.unshift("施工图原文件超过 "+MAX_PAGES+" 页，本次只读取前 "+MAX_PAGES+" 页，跨图结论不代表全套图纸。");
  if(mode!=="hybrid")limitations.unshift("未检测到足够 PDF 文字层，本次图号、编号和文字检查主要依赖视觉，关键内容必须人工复核。");
  if(!String(body?.reference?.text||"").trim())limitations.unshift("未提供院标/甲方要求/规范依据，本次不做规范符合性结论。");
  return {
    summary:String(parsed?.summary||"施工图预审完成"),
    overall:String(parsed?.overall||"请查看程序硬检查、AI问题与跨图风险。"),
    analysisMode:mode,
    counts:{hard:hard.length,issues:issues.length,crossSheet:cross.length,highRisk},
    hardAlerts:hard,
    issues,
    crossSheetRisks:cross,
    checklist:safeArray(parsed?.checklist).map(String).slice(0,20),
    limitations,
    sheetSummary:safeArray(parsed?.sheetSummary).slice(0,MAX_PAGES)
  };
}


function reviewRegressionFixture(){
  const px="data:image/png;base64,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";
  return {
    projectName:"Agent Hong Module 02 Regression",
    focus:"重点检查 W03 在平面、南立面、门窗表之间是否闭环；检查 CHECK/VERIFY 未闭环标记。",
    drawing:{
      name:"Regression-B.pdf",type:"pdf",sourcePages:3,
      pages:[
        {pageNumber:1,image:px,sheetId:"A-101",textDigest:"LEVEL 1 FLOOR PLAN A-101 | W01 W02 W03 W04 | D01 D02 D03 D04 | CONFERENCE ROOM 102 | STAIR CLR 1350",textDigestTruncated:false,textItemCount:40},
        {pageNumber:2,image:px,sheetId:"A-201",textDigest:"SOUTH ELEVATION A-201 | W01 W02 W04 | D01 | NOTE: PLAN A-101 ADDS WINDOW W03. CHECK IF SOUTH ELEVATION REQUIRES UPDATE.",textDigestTruncated:false,textItemCount:28},
        {pageNumber:3,image:px,sheetId:"A-601",textDigest:"DOOR WINDOW SCHEDULE A-601 | D01 D02 D03 D04 | W01 W02 W04 | REV B NOTE: VERIFY NEW WINDOW W03 IS ADDED TO THIS SCHEDULE.",textDigestTruncated:false,textItemCount:42}
      ]
    },
    reference:{name:null,text:"",mode:"none",truncated:false},
    deterministic:{
      textCoverage:{mode:"hybrid",totalTextItems:110,pagesWithSheetId:3,totalPages:3},
      sheets:[
        {page:1,sheetId:"A-101",role:"plan",windows:["W01","W02","W03","W04"],doors:["D01","D02","D03","D04"],refs:["A-101"]},
        {page:2,sheetId:"A-201",role:"elevation",windows:["W01","W02","W04"],doors:["D01"],refs:["A-201","A-101"]},
        {page:3,sheetId:"A-601",role:"schedule",windows:["W01","W02","W04"],doors:["D01","D02","D03","D04"],refs:["A-601"]}
      ],
      alerts:[
        {id:"P001",severity:"high",category:"门窗一致性",location:"A-101",issue:"平面出现窗号 W03，但当前门窗表文字层未检出该编号",evidence:"A-101 含 W03；A-601 门窗表仅含 W01/W02/W04。",source:"pdf_text"},
        {id:"P002",severity:"medium",category:"未闭环标记",location:"A-201",issue:"发现 CHECK 待确认文字",evidence:"NOTE: PLAN A-101 ADDS WINDOW W03. CHECK IF SOUTH ELEVATION REQUIRES UPDATE.",source:"pdf_text"},
        {id:"P003",severity:"medium",category:"未闭环标记",location:"A-601",issue:"发现 VERIFY 待确认文字",evidence:"REV B NOTE: VERIFY NEW WINDOW W03 IS ADDED TO THIS SCHEDULE.",source:"pdf_text"}
      ],
      indices:{planWindows:["W01","W02","W03","W04"],planDoors:["D01","D02","D03","D04"],scheduleWindows:["W01","W02","W04"],scheduleDoors:["D01","D02","D03","D04"]},
      fullyLoaded:true
    }
  };
}

async function handleReviewRegression(env){
  const body=reviewRegressionFixture();
  try{
    const {parsed,usage,model}=await callReviewMiniMax(env,body);
    const result=normalizeReviewResult(parsed,body);
    const dump=JSON.stringify(result);
    const checks={
      hardW03:result.hardAlerts.some(x=>x.id==="P001"&&/W03/.test(x.issue+x.evidence)),
      crossElevation:/W03/.test(dump)&&/A-201|立面/.test(dump),
      crossSchedule:/W03/.test(dump)&&/A-601|门窗表|SCHEDULE/i.test(dump),
      noFakeCompliance:!/违反.{0,10}规范|符合.{0,10}规范/.test(dump)
    };
    return json({ok:Object.values(checks).every(Boolean),checks,result,usage,model});
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
    if(url.pathname==="/api/health")return json({ok:true,product:"Agent Hong",feature:"drawing-version-diff",engine:"hybrid-diff-v1",modules:["version-diff","drawing-review"],model:env.MINIMAX_MODEL||"MiniMax-M3",configured:Boolean(env.MINIMAX_API_KEY)});
    if(url.pathname==="/api/__review_regression_8f31"&&request.method==="GET")return handleReviewRegression(env);
    if(url.pathname==="/api/review"&&request.method==="POST")return handleReview(request,env);
    if(url.pathname==="/api/compare"&&request.method==="POST")return handleCompare(request,env);
    if(url.pathname.startsWith("/api/"))return json({error:"Not found"},404);
    return env.ASSETS.fetch(request);
  }
};
