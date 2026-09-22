const uniq = xs => [...new Set((xs||[]).filter(Boolean))];
const norm = v => String(v??"").replace(/\s+/g," ").trim();
const upper = v => norm(v).toUpperCase();

export function detectHistorySheetId(text=""){
  const t=upper(text);
  const token="(?:A|AR|ARCH|S|ST|M|ME|E|EL|P|PL|L|C)[-. ]?\\d{2,4}(?:\\.\\d+)?";
  const explicit=[
    new RegExp("\\bSHEET(?:\\s+(?:NO|NUMBER))?\\s*[:#-]?\\s*("+token+")\\b","g"),
    new RegExp("(?:图号|圖號)\\s*[:：#-]?\\s*("+token+")\\b","g")
  ];
  for(const re of explicit){
    const m=[...t.matchAll(re)];
    if(m.length)return m[m.length-1][1].replace(/\s+/g,"-");
  }
  const loose=t.match(new RegExp("\\b"+token+"\\b","g"));
  return loose?.length?loose[loose.length-1].replace(/\s+/g,"-"):null;
}

export function classifyHistorySheet(text=""){
  const t=upper(text);
  if(/DOOR.*WINDOW.*SCHEDULE|WINDOW.*SCHEDULE|门窗表|门窗明细/.test(t))return "schedule";
  if(/FLOOR PLAN|GROUND FLOOR PLAN|LEVEL\s*\d+[^|]{0,50}PLAN|平面图|首层平面|平面布置/.test(t))return "plan";
  if(/ELEVATION|立面图|南立面|北立面|东立面|西立面/.test(t))return "elevation";
  if(/SECTION|剖面图|剖面/.test(t))return "section";
  if(/DETAIL|详图|大样|节点/.test(t))return "detail";
  if(/GENERAL NOTES|DESIGN NOTES|设计说明|总说明/.test(t))return "notes";
  if(/\bPLAN\b|平面/.test(t))return "plan";
  return "other";
}

export function inferSheetTitle(text="",sheetId=null){
  const chunks=norm(text).split(/\s*[|]\s*|\s{2,}/).map(x=>x.trim()).filter(Boolean);
  const bad=/^(SHEET|图号|REV|VERSION|ISSUE|PROJECT)\b/i;
  for(const c of chunks){
    const u=c.toUpperCase();
    if(sheetId && u===String(sheetId).toUpperCase())continue;
    if(sheetId && u.includes(String(sheetId).toUpperCase()) && u.length<28)continue;
    if(bad.test(c))continue;
    if(/FLOOR PLAN|ELEVATION|SECTION|SCHEDULE|DETAIL|GENERAL NOTES|平面|立面|剖面|门窗表|详图|总说明/i.test(c))return c.slice(0,120);
  }
  return chunks.find(x=>!bad.test(x))?.slice(0,120)||"";
}

export function extractHistoryMarks(text=""){
  const t=upper(text);
  const re=/\b[WD]\s*[-.]?\s*\d{1,4}[A-Z]?\b/g;
  return uniq((t.match(re)||[]).map(x=>x.replace(/\s+/g,"").replace(".","-")));
}

export function extractHistoryRooms(text=""){
  const t=upper(text),out=[];
  let m;
  const re=/\bROOM\s*[-:]?\s*(\d{2,4}[A-Z]?)\b/g;
  while((m=re.exec(t)))out.push(m[1]);
  return uniq(out);
}

export function extractYears(text=""){
  const years=(String(text||"").match(/\b(?:19|20)\d{2}\b/g)||[]).map(Number);
  return uniq(years.filter(y=>y>=1980&&y<=2100));
}

function latinTokens(text=""){
  return (upper(text).match(/[A-Z0-9]+(?:[-_.][A-Z0-9]+)*/g)||[])
    .filter(x=>x.length>=2);
}

function cjkTokens(text=""){
  const chunks=String(text||"").match(/[\u3400-\u9fff]{2,}/g)||[],out=[];
  for(const chunk of chunks){
    if(chunk.length<=4)out.push(chunk);
    for(let n=2;n<=Math.min(4,chunk.length);n++){
      for(let i=0;i<=chunk.length-n;i++)out.push(chunk.slice(i,i+n));
    }
  }
  return out;
}

export function tokenizeHistory(text=""){
  return uniq([...latinTokens(text),...cjkTokens(text)]);
}

export function parseHistoryQuery(query=""){
  const q=norm(query);
  const up=upper(q);
  const sheetRefs=uniq((up.match(/\b(?:A|AR|ARCH|S|ST|M|ME|E|EL|P|PL|L|C)[-. ]?\d{2,4}(?:\.\d+)?\b/g)||[]).map(x=>x.replace(/\s+/g,"-")));
  const marks=extractHistoryMarks(q);
  const rooms=extractHistoryRooms(q);
  const years=extractYears(q);
  const roleHints=[];
  if(/平面|PLAN/i.test(q))roleHints.push("plan");
  if(/立面|ELEVATION/i.test(q))roleHints.push("elevation");
  if(/剖面|SECTION/i.test(q))roleHints.push("section");
  if(/详图|节点|大样|DETAIL/i.test(q))roleHints.push("detail");
  if(/门窗表|SCHEDULE/i.test(q))roleHints.push("schedule");
  if(/说明|NOTES?/i.test(q))roleHints.push("notes");
  return {raw:q,sheetRefs,marks,rooms,years,roleHints:uniq(roleHints),tokens:tokenizeHistory(q)};
}

export function buildHistoryRecord(input={}){
  const text=norm(input.text||"");
  const sheetId=input.sheetId||detectHistorySheetId(text);
  const sheetTitle=input.sheetTitle||inferSheetTitle(text,sheetId);
  const role=input.role||classifyHistorySheet(text);
  const projectName=norm(input.projectName||"未命名项目");
  const fileName=norm(input.fileName||"drawing.pdf");
  const projectYear=Number(input.projectYear)||extractYears(projectName+" "+fileName+" "+text)[0]||null;
  return {
    id:String(input.id||cryptoRandomId()),
    projectId:String(input.projectId||""),
    projectName,fileName,
    projectYear,
    pageNumber:Number(input.pageNumber||1),
    sheetId:sheetId||null,
    sheetTitle,
    role,
    text,
    marks:extractHistoryMarks(text),
    rooms:extractHistoryRooms(text),
    years:extractYears(projectName+" "+fileName+" "+text),
    tokens:tokenizeHistory(projectName+" "+fileName+" "+sheetId+" "+sheetTitle+" "+text),
    thumbnail:input.thumbnail||null,
    importedAt:Number(input.importedAt||Date.now())
  };
}

function cryptoRandomId(){
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  return "h_"+Math.random().toString(36).slice(2)+Date.now().toString(36);
}

function intersectCount(a=[],b=[]){
  const set=new Set(b);return a.filter(x=>set.has(x)).length;
}

function scoreHistoryRecord(parsed,rec,filters={}){
  let score=0;const reasons=[];
  const textU=upper(rec.text),projU=upper(rec.projectName),fileU=upper(rec.fileName),titleU=upper(rec.sheetTitle||"");
  const allU=projU+" "+fileU+" "+String(rec.sheetId||"")+" "+titleU+" "+textU;

  if(filters.projectId&&rec.projectId!==filters.projectId)return {score:-1,reasons:[]};
  if(filters.role&&filters.role!=="all"&&rec.role!==filters.role)return {score:-1,reasons:[]};
  if(filters.year&&Number(filters.year)!==Number(rec.projectYear))return {score:-1,reasons:[]};

  for(const sid of parsed.sheetRefs){
    if(String(rec.sheetId||"").toUpperCase()===sid){score+=55;reasons.push("图号 "+sid);}
    else if(allU.includes(sid)){score+=16;reasons.push("引用 "+sid);}
  }
  for(const m of parsed.marks){
    if(rec.marks.includes(m)){score+=30;reasons.push("编号 "+m);}
    else if(allU.includes(m)){score+=12;reasons.push("文字 "+m);}
  }
  for(const room of parsed.rooms){
    if(rec.rooms.includes(room)){score+=30;reasons.push("房间 "+room);}
  }
  for(const y of parsed.years){
    if(Number(rec.projectYear)===y||rec.years.includes(y)){score+=20;reasons.push("年份 "+y);}
  }
  for(const role of parsed.roleHints){
    if(rec.role===role){score+=11;reasons.push("图种 "+role);}
  }

  if(parsed.raw&&allU.includes(upper(parsed.raw))){score+=24;reasons.push("完整短语");}
  const overlap=intersectCount(parsed.tokens,rec.tokens||[]);
  if(overlap){
    score+=Math.min(30,overlap*2.2);
    reasons.push("关键词 "+overlap+" 项");
  }

  // project / title hits are especially valuable for natural-language history search.
  for(const tok of parsed.tokens){
    if(tok.length<2)continue;
    if(projU.includes(tok)){score+=3.5;}
    if(titleU.includes(tok)){score+=3;}
  }

  return {score,reasons:uniq(reasons).slice(0,8)};
}

export function makeHistorySnippet(text="",parsed,maxLen=260){
  const s=norm(text);
  if(!s)return "";
  const needles=[...(parsed?.sheetRefs||[]),...(parsed?.marks||[]),...(parsed?.rooms||[]),...(parsed?.tokens||[])].filter(x=>String(x).length>=2);
  const u=upper(s);let pos=-1;
  for(const n of needles){const p=u.indexOf(upper(n));if(p>=0&&(pos<0||p<pos))pos=p;}
  if(pos<0)return s.slice(0,maxLen)+(s.length>maxLen?"…":"");
  const start=Math.max(0,pos-Math.floor(maxLen*.35)),end=Math.min(s.length,start+maxLen);
  return (start?"…":"")+s.slice(start,end)+(end<s.length?"…":"");
}

export function searchHistory(records=[],query="",filters={},limit=30){
  const parsed=parseHistoryQuery(query);
  if(!parsed.raw)return [];
  return (records||[]).map(rec=>{
    const r=scoreHistoryRecord(parsed,rec,filters);
    return {...rec,searchScore:Number(r.score.toFixed(2)),matchReasons:r.reasons,snippet:makeHistorySnippet(rec.text,parsed)};
  }).filter(x=>x.searchScore>0)
    .sort((a,b)=>b.searchScore-a.searchScore || Number(b.importedAt||0)-Number(a.importedAt||0))
    .slice(0,limit);
}

export function summarizeLibrary(records=[]){
  const projects=new Set(),files=new Set(),roles={};
  let oldest=null,newest=null;
  for(const r of records||[]){
    if(r.projectId||r.projectName)projects.add(r.projectId||r.projectName);
    files.add((r.projectId||r.projectName)+"|"+r.fileName);
    roles[r.role]=(roles[r.role]||0)+1;
    if(r.projectYear){oldest=oldest===null?Number(r.projectYear):Math.min(oldest,Number(r.projectYear));newest=newest===null?Number(r.projectYear):Math.max(newest,Number(r.projectYear));}
  }
  return {projects:projects.size,files:files.size,pages:(records||[]).length,roles,oldestYear:oldest,newestYear:newest};
}
