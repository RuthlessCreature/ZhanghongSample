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
8. 只输出严格 JSON，不要 Markdown，不要代码围栏。

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

function regressionFixture() {
  const pixel="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACvUlEQVR4nO3TMQEAIAzAMMC/5yFjRxMFfXpn5kDV2w6ATQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQNoHq+gE/QPNMGIAAAAASUVORK5CYII=";
  const page=(sheetId,text)=>({pageNumber:1,image:pixel,sheetId,textItemCount:20,textDigest:text,textDigestTruncated:false});
  return {
    projectName:"Agent Hong production regression",
    notes:"仅按确定性文字证据校核。特别检查精确数值和 W03 跨图同步，不得用视觉覆盖程序证据。",
    versionA:{
      name:"Regression-A.pdf",sourcePages:3,
      pages:[
        page("A-101","SHEET A-101 | 23000 | 12000 | MEETING ROOM | STAIR CLR 1200 | W01 | W02 | W04"),
        page("A-201","SHEET A-201 | SOUTH ELEVATION | W04 | D01 | W02 | W01"),
        page("A-601","SHEET A-601 | DOOR WINDOW SCHEDULE | D01 | D02 | D03 | D04 | W01 | W02 | W04")
      ]
    },
    versionB:{
      name:"Regression-B.pdf",sourcePages:3,
      pages:[
        page("A-101","SHEET A-101 | 23800 | 12800 | CONFERENCE ROOM | STAIR CLR 1350 | W01 | W02 | W03 | W04"),
        page("A-201","SHEET A-201 | SOUTH ELEVATION | W04 | D01 | W02 | W01"),
        page("A-601","SHEET A-601 | DOOR WINDOW SCHEDULE | D01 | D02 | D03 | D04 | W01 | W02 | W04")
      ]
    },
    deterministic:{
      pagePairs:[
        {pageA:0,pageB:0,sheetId:"A-101",method:"sheet-id"},
        {pageA:1,pageB:1,sheetId:"A-201",method:"sheet-id"},
        {pageA:2,pageB:2,sheetId:"A-601",method:"sheet-id"}
      ],
      textCoverage:{itemsA:60,itemsB:64,mode:"hybrid"},
      textChanges:[
        {id:"T001",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"23000",after:"23800",numeric:{before:23000,after:23800,delta:800},position:{x:.4,y:.2},matchConfidence:1},
        {id:"T002",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"12000",after:"12800",numeric:{before:12000,after:12800,delta:800},position:{x:.3,y:.25},matchConfidence:.98},
        {id:"T003",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"MEETING ROOM",after:"CONFERENCE ROOM",numeric:null,position:{x:.55,y:.45},matchConfidence:.91},
        {id:"T004",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"STAIR CLR 1200",after:"STAIR CLR 1350",numeric:{before:1200,after:1350,delta:150},position:{x:.45,y:.6},matchConfidence:.92},
        {id:"T005",sheetId:"A-101",pageA:1,pageB:1,type:"add",before:"",after:"W03",numeric:null,position:{x:.65,y:.77},matchConfidence:1}
      ],
      visualRegions:[]
    }
  };
}

async function handleRegression(env){
  const body=regressionFixture();
  try{
    const {parsed,usage,model}=await callMiniMax(env,body);
    const result=normalizeModelResult(parsed,body);
    const dump=JSON.stringify(result);
    const checks={
      exact800:dump.includes("23800")&&dump.includes("12800")&&!dump.includes("+500")&&!dump.includes("12500"),
      stair1350:dump.includes("1350")&&!dump.includes("1300"),
      w03ElevationRisk:result.syncRisks.some(x=>/W03/i.test(x.issue+x.evidence)&&/A-201|立面/i.test(x.location+x.issue+x.evidence)),
      w03ScheduleRisk:result.syncRisks.some(x=>/W03/i.test(x.issue+x.evidence)&&/A-601|门窗表|SCHEDULE/i.test(x.location+x.issue+x.evidence))
    };
    return json({ok:Object.values(checks).every(Boolean),checks,result,usage,model});
  }catch(e){
    return json({ok:false,error:e?.message||"regression failed",stage:"production-regression"});
  }
}

async function runHybridSelfTest(env){
  const px="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAkElEQVR4nO3aSwqAMAwAUSPe/8px0W39QNQhMm9bkA4Ruklk5tLZSl+gygCaATQDaNvRQUR8eY87pk/Wfycw1N/pMcnid05+h/YTMIBmAM0AmgE0A2gG0AygGUAzgGYAzQCaATQDaAbQDKAZQDOAZgDNAJoBNANo7QMulj2eWrp5b3mn/QTCxVeYATQDaO0DdmrWD4URKp9YAAAAAElFTkSuQmCC";
  const mkPages=()=>[
    {pageNumber:1,image:px,sheetId:"A-101",textItemCount:30},
    {pageNumber:2,image:px,sheetId:"A-201",textItemCount:20},
    {pageNumber:3,image:px,sheetId:"A-601",textItemCount:40}
  ];
  const textChanges=[
    {id:"T001",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"23000",after:"23800",numeric:{before:23000,after:23800,delta:800},position:{x:.5,y:.1},matchConfidence:.99},
    {id:"T002",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"12000",after:"12800",numeric:{before:12000,after:12800,delta:800},position:{x:.4,y:.13},matchConfidence:.99},
    {id:"T003",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"MEETING ROOM 102",after:"CONFERENCE ROOM 102",numeric:null,position:{x:.65,y:.42},matchConfidence:.99},
    {id:"T004",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"STAIR CLR 1200",after:"STAIR CLR 1350",numeric:{before:1200,after:1350,delta:150},position:{x:.58,y:.65},matchConfidence:.99},
    {id:"T005",sheetId:"A-101",pageA:1,pageB:1,type:"replace",before:"1. Grid/partition adjusted +800.",after:"1. Grid/partition adjusted +800.",numeric:null,position:{x:.8,y:.15},matchConfidence:1},
    {id:"T006",sheetId:"A-101",pageA:1,pageB:1,type:"add",before:"",after:"W03",numeric:null,position:{x:.75,y:.82},matchConfidence:1},
    {id:"T007",sheetId:"A-201",pageA:2,pageB:2,type:"add",before:"",after:"NOTE: PLAN A-101 ADDS WINDOW W03. CHECK IF SOUTH ELEVATION REQUIRES UPDATE.",numeric:null,position:{x:.58,y:.2},matchConfidence:1},
    {id:"T008",sheetId:"A-601",pageA:3,pageB:3,type:"add",before:"",after:"REV B NOTE: VERIFY NEW WINDOW W03 IS ADDED TO THIS SCHEDULE.",numeric:null,position:{x:.4,y:.78},matchConfidence:1}
  ];
  const body={
    projectName:"Agent Hong Hybrid Self Test",
    notes:"验证确定性证据优先级：严禁把 +800 误读成 +500；检查 W03 跨图同步。",
    versionA:{name:"A.pdf",type:"pdf",sourcePages:3,pages:mkPages()},
    versionB:{name:"B.pdf",type:"pdf",sourcePages:3,pages:mkPages()},
    deterministic:{
      pagePairs:[
        {pageA:0,pageB:0,sheetId:"A-101",method:"sheet-id"},
        {pageA:1,pageB:1,sheetId:"A-201",method:"sheet-id"},
        {pageA:2,pageB:2,sheetId:"A-601",method:"sheet-id"}
      ],
      textCoverage:{itemsA:90,itemsB:98,mode:"hybrid"},
      textChanges,
      visualRegions:[]
    }
  };
  const {parsed,usage,model}=await callMiniMax(env,body);
  return {ok:true,result:normalizeModelResult(parsed,body),usage,model};
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
    if(url.pathname==="/api/health")return json({ok:true,product:"Agent Hong",feature:"drawing-version-diff",engine:"hybrid-diff-v1",model:env.MINIMAX_MODEL||"MiniMax-M3",configured:Boolean(env.MINIMAX_API_KEY)});
    if(url.pathname==="/api/selftest-hybrid"&&request.method==="GET"){
      try{return json(await runHybridSelfTest(env));}catch(e){return json({ok:false,error:e?.message||"selftest failed",stack:String(e?.stack||"").slice(0,1200)})}
    }
    if(url.pathname==="/api/__agent_hong_regression_1c7b"&&request.method==="GET")return handleRegression(env);
    if(url.pathname==="/api/compare"&&request.method==="POST")return handleCompare(request,env);
    if(url.pathname.startsWith("/api/"))return json({error:"Not found"},404);
    return env.ASSETS.fetch(request);
  }
};
