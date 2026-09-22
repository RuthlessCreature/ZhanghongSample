
const uniq = xs => [...new Set((xs || []).filter(Boolean))];
const norm = v => String(v ?? "").replace(/\s+/g, " ").trim();
const upper = v => norm(v).toUpperCase();

export const BRIEFING_SECTIONS = [
  "scope",
  "key_design",
  "dimensions_levels",
  "rooms_functions",
  "doors_windows_facade",
  "circulation_access",
  "materials_details",
  "coordination_interfaces",
  "open_items"
];

const CATEGORY_RULES = [
  {key:"scope", score:10, terms:["SHEET","DRAWING INDEX","GENERAL NOTES","平面图","立面图","剖面图","详图","门窗表","图号"]},
  {key:"key_design", score:6, terms:["DESIGN INTENT","PROJECT REQUIREMENT","REQUIREMENT","CLIENT","设计要求","设计意图","甲方要求","项目要求"]},
  {key:"dimensions_levels", score:9, terms:["FFL","LEVEL","ELEVATION","HEIGHT","CLR","CLEAR WIDTH","CLEAR HEIGHT","DIMENSION","标高","层高","净高","净宽","尺寸"]},
  {key:"rooms_functions", score:9, terms:["ROOM ","LOBBY","OFFICE","MEETING","CONFERENCE","SERVER ROOM","TOILET","STAIR HALL","房间","大堂","办公室","会议室","机房","卫生间"]},
  {key:"doors_windows_facade", score:9, terms:["WINDOW","DOOR","W01","W02","W03","D01","D02","FACADE","CURTAIN WALL","ELEVATION","门窗","窗","门","幕墙","立面"]},
  {key:"circulation_access", score:9, terms:["STAIR","RAMP","ACCESSIBLE","ELEVATOR","LIFT","CORRIDOR","EGRESS","楼梯","坡道","无障碍","电梯","走道","疏散"]},
  {key:"materials_details", score:8, terms:["DETAIL","MATERIAL","FINISH","FIRESTOP","WATERPROOF","ROOF","WALL TYPE","FLOOR FINISH","节点","材料","饰面","防火封堵","防水","屋面","墙体"]},
  {key:"coordination_interfaces", score:10, terms:["COORDINATE","COORDINATION","MEP","STRUCTURAL","SHAFT","SCHEDULE","REFER TO","REFERENCE","INTERFACE","协调","机电","结构","竖井","门窗表","参见","接口"]},
  {key:"open_items", score:14, terms:["CHECK","VERIFY","TBD","TBC","HOLD","PENDING","TO BE CONFIRMED","待确认","待定","复核","确认后定"]}
];

export function detectBriefSheetId(text=""){
  const t=upper(text);
  const token="(?:A|AR|ARCH|S|ST|M|ME|E|EL|P|PL|L|C)[-. ]?\\d{2,4}(?:\\.\\d+)?";
  for(const re of [
    new RegExp("\\bSHEET(?:\\s+(?:NO|NUMBER))?\\s*[:#-]?\\s*("+token+")\\b","g"),
    new RegExp("(?:图号|圖號)\\s*[:：#-]?\\s*("+token+")\\b","g")
  ]){
    const m=[...t.matchAll(re)];
    if(m.length)return m[m.length-1][1].replace(/\s+/g,"-");
  }
  const m=t.match(new RegExp("\\b"+token+"\\b","g"));
  return m?.length?m[0].replace(/\s+/g,"-"):null;
}

export function inferBriefSheetTitle(lines=[]){
  for(const raw of lines){
    const s=norm(raw);
    if(/FLOOR PLAN|ELEVATION|SECTION|SCHEDULE|DETAIL|GENERAL NOTES|DRAWING INDEX|平面|立面|剖面|门窗表|详图|总说明/i.test(s)){
      if(s.length<=120)return s;
    }
  }
  return norm(lines[0]||"").slice(0,120);
}

export function classifyBriefLine(line="", sourceType="drawing"){
  const u=upper(line), hits=[];
  for(const rule of CATEGORY_RULES){
    let n=0;
    for(const t of rule.terms)if(u.includes(upper(t)))n++;
    if(n)hits.push({key:rule.key,score:rule.score+n});
  }
  if(sourceType!=="drawing"){
    const existing=hits.find(x=>x.key==="key_design");
    if(existing)existing.score+=4;
    else hits.push({key:"key_design",score:9});
  }
  return hits.sort((a,b)=>b.score-a.score);
}

export function extractBriefNumbers(text=""){
  const out=[], re=/(-?\d+(?:\.\d+)?)\s*(MM|CM|M|KPA|MPA|KN|KN\/M2|KN\/M²|%|G)\b/gi;
  let m;while((m=re.exec(String(text||""))))out.push({value:Number(m[1]),unit:m[2].toUpperCase(),raw:m[0]});
  return out;
}

export function extractBriefMarks(text=""){
  const t=upper(text);
  return uniq((t.match(/\b[WD]\s*[-.]?\s*\d{1,4}[A-Z]?\b/g)||[]).map(x=>x.replace(/\s+/g,"").replace(".","-")));
}

export function extractBriefRooms(text=""){
  const t=upper(text),out=[];let m;
  const re=/\bROOM\s*[-:]?\s*(\d{2,4}[A-Z]?)\b/g;
  while((m=re.exec(t)))out.push(m[1]);
  return uniq(out);
}

function meaningful(line=""){
  const s=norm(line);
  return s.length>=4 && !/^(PAGE|第\s*\d+\s*页)\b/i.test(s);
}

function contextLine(lines,i){
  const base=norm(lines[i]||"");
  const next=norm(lines[i+1]||"");
  if(next && next.length<180 && !/^(SHEET|图号)\b/i.test(next))return base+" "+next;
  return base;
}

export function buildBriefEvidence(documents=[]){
  const out=[];
  for(const doc of documents||[]){
    let seq=1;
    const documentId=String(doc.documentId||"doc");
    const documentName=String(doc.documentName||doc.name||"document.pdf");
    const sourceType=String(doc.sourceType||"drawing");
    for(const page of doc.pages||[]){
      const lines=(page.lines||String(page.text||"").split(/\r?\n+/)).map(norm).filter(meaningful);
      const pageText=lines.join(" | ");
      const sheetId=sourceType==="drawing"?(page.sheetId||detectBriefSheetId(pageText)):null;
      const sheetTitle=sourceType==="drawing"?inferBriefSheetTitle(lines):"";
      // Always emit one sheet-scope evidence for traceability.
      if(sourceType==="drawing" && (sheetId||sheetTitle)){
        out.push({
          id:documentId+":D"+String(seq++).padStart(4,"0"),
          category:"scope",pageNumber:Number(page.pageNumber||1),documentId,documentName,sourceType,
          sheetId:sheetId||null,sheetTitle,
          text:[sheetId?"SHEET "+sheetId:"",sheetTitle].filter(Boolean).join(" | "),
          score:15,numbers:[],marks:[],rooms:[]
        });
      }
      for(let i=0;i<lines.length;i++){
        const text=contextLine(lines,i),hits=classifyBriefLine(text,sourceType);
        if(!hits.length)continue;
        const numbers=extractBriefNumbers(text),marks=extractBriefMarks(text),rooms=extractBriefRooms(text);
        for(const hit of hits.slice(0,3)){
          out.push({
            id:documentId+":D"+String(seq++).padStart(4,"0"),
            category:hit.key,pageNumber:Number(page.pageNumber||1),documentId,documentName,sourceType,
            sheetId:sheetId||null,sheetTitle,text,score:hit.score,numbers,marks,rooms
          });
        }
      }
    }
  }
  return dedupe(out);
}

function dedupe(xs){
  const seen=new Set(),out=[];
  for(const x of xs){
    const k=[x.documentId,x.pageNumber,x.category,upper(x.text)].join("|");
    if(seen.has(k))continue;
    seen.add(k);out.push(x);
  }
  return out;
}

export function groupBriefEvidence(evidence=[]){
  const groups={};for(const k of BRIEFING_SECTIONS)groups[k]=[];
  for(const e of evidence||[])if(groups[e.category])groups[e.category].push(e);
  for(const k of BRIEFING_SECTIONS)groups[k].sort((a,b)=>b.score-a.score||a.pageNumber-b.pageNumber);
  return groups;
}

export function selectBriefEvidence(evidence=[],max=42){
  const groups=groupBriefEvidence(evidence),out=[],seen=new Set();
  const quotas={scope:8,key_design:6,dimensions_levels:6,rooms_functions:6,doors_windows_facade:6,circulation_access:5,materials_details:5,coordination_interfaces:7,open_items:8};
  // Open items and coordination first because they are most important in a briefing.
  const order=["open_items","coordination_interfaces","scope","key_design","dimensions_levels","rooms_functions","doors_windows_facade","circulation_access","materials_details"];
  for(const k of order){
    for(const e of groups[k].slice(0,quotas[k])){
      if(out.length>=max)break;
      if(!seen.has(e.id)){seen.add(e.id);out.push(e);}
    }
  }
  return out.slice(0,max);
}

export function summarizeBriefCoverage(evidence=[]){
  const groups=groupBriefEvidence(evidence),found={},missing=[];
  for(const k of BRIEFING_SECTIONS){found[k]=groups[k].length;if(!groups[k].length)missing.push(k);}
  return {total:evidence.length,found,missing,covered:BRIEFING_SECTIONS.length-missing.length,totalSections:BRIEFING_SECTIONS.length};
}

export function validateBriefingOutput(result={},candidateEvidence=[]){
  const valid=new Map((candidateEvidence||[]).map(x=>[x.id,x]));
  const sections=[];
  const rawByKey=new Map((Array.isArray(result.sections)?result.sections:[]).map(x=>[String(x.key||""),x]));
  for(const key of BRIEFING_SECTIONS){
    const raw=rawByKey.get(key)||{},items=[];
    for(const item of Array.isArray(raw.items)?raw.items:[]){
      const citations=uniq((Array.isArray(item.citations)?item.citations:[]).map(String).filter(id=>valid.has(id)));
      if(!citations.length)continue;
      const evs=citations.map(id=>valid.get(id));
      items.push({
        title:String(item.title||"交底事项"),
        message:String(item.message||""),
        action:String(item.action||""),
        priority:["high","medium","low"].includes(item.priority)?item.priority:"medium",
        citations,
        sheets:uniq(evs.map(e=>e.sheetId).filter(Boolean)),
        pages:uniq(evs.map(e=>e.pageNumber)).sort((a,b)=>a-b)
      });
    }
    sections.push({
      key,
      status:items.length?(raw.status==="needs_review"?"needs_review":"ready"):"not_found",
      summary:items.length?String(raw.summary||""): "当前证据中未找到可形成该部分交底的内容。",
      items
    });
  }
  return sections;
}
