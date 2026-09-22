const uniq=xs=>[...new Set((xs||[]).filter(Boolean))];
const norm=v=>String(v??"").replace(/\s+/g," ").trim();
const upper=v=>norm(v).toUpperCase();

export const GEOTECH_KEYS=[
  "site_class","seismic","groundwater","soil_layers","bearing_capacity","pile_conditions",
  "liquefaction","corrosion","adverse_geology","excavation","dewatering","exploration"
];

const RULES=[
  {key:"site_class",label:"场地类别",score:9,terms:["SITE CLASS","SITE CATEGORY","场地类别","场地类别为"]},
  {key:"seismic",label:"抗震/地震参数",score:8,terms:["SEISMIC","DESIGN EARTHQUAKE","EARTHQUAKE","抗震设防","地震动","基本地震加速度","设计地震分组"]},
  {key:"groundwater",label:"地下水",score:10,terms:["GROUNDWATER","WATER TABLE","地下水","地下水位","稳定水位","抗浮水位"]},
  {key:"soil_layers",label:"土层/地层",score:7,terms:["SOIL LAYER","STRATUM","STRATA","LAYER","土层","地层","粉质黏土","填土","砂层","风化岩"]},
  {key:"bearing_capacity",label:"承载力",score:10,terms:["BEARING CAPACITY","ALLOWABLE BEARING","CHARACTERISTIC VALUE","FAK","承载力","地基承载力"]},
  {key:"pile_conditions",label:"桩基/持力层",score:10,terms:["PILE","PILE TIP","END BEARING","BEARING STRATUM","桩基","桩端","持力层","单桩","侧阻","端阻"]},
  {key:"liquefaction",label:"液化",score:10,terms:["LIQUEFACTION","液化","不液化"]},
  {key:"corrosion",label:"腐蚀性",score:9,terms:["CORROSION","CORROSIVE","CORROSIVITY","腐蚀性","腐蚀等级"]},
  {key:"adverse_geology",label:"不良地质",score:8,terms:["ADVERSE GEOLOGY","KARST","FAULT","LANDSLIDE","CAVITY","不良地质","岩溶","断层","滑坡","空洞","软弱夹层"]},
  {key:"excavation",label:"基坑/开挖",score:8,terms:["EXCAVATION","FOUNDATION PIT","SLOPE SUPPORT","基坑","开挖","支护","放坡"]},
  {key:"dewatering",label:"降水/抗浮",score:8,terms:["DEWATERING","ANTI-FLOAT","UPLIFT","降水","抗浮","止水"]},
  {key:"exploration",label:"勘探孔/孔深/标高",score:6,terms:["BOREHOLE","BORING","BH-","ZK","DRILLING","勘探孔","钻孔","孔深","孔口标高"]}
];

export function classifyGeotechLine(line=""){
  const u=upper(line),hits=[];
  for(const rule of RULES){
    let n=0;
    for(const t of rule.terms)if(u.includes(upper(t)))n++;
    if(n)hits.push({key:rule.key,label:rule.label,score:rule.score+n});
  }
  return hits.sort((a,b)=>b.score-a.score);
}

export function extractGeotechNumbers(text=""){
  const s=String(text||""),out=[];
  const re=/(-?\d+(?:\.\d+)?)\s*(KPA|MPA|KN\/M2|KN\/M²|KN\/M3|KN\/M³|M|MM|CM|%|G|GAL)\b/gi;
  let m;while((m=re.exec(s)))out.push({value:Number(m[1]),unit:m[2].toUpperCase(),raw:m[0]});
  return out;
}

export function extractDepthRange(text=""){
  const s=String(text||"");
  const m=s.match(/(-?\d+(?:\.\d+)?)\s*(?:M|米)?\s*(?:-|~|TO|至|～)\s*(-?\d+(?:\.\d+)?)\s*(M|米)\b/i);
  return m?{min:Number(m[1]),max:Number(m[2]),unit:"m",raw:m[0]}:null;
}

export function geotechEvidencePolarity(line=""){
  const s=upper(line);
  const absent=[
    /\bNOT\s+(?:PROVIDED|AVAILABLE|INCLUDED|GIVEN|SPECIFIED)\b/,
    /\bDOES\s+NOT\s+PROVIDE\b/,
    /\bNO\s+[^.]{0,80}\b(?:RECOMMENDATION|PARAMETER|DATA|INFORMATION)\b[^.]{0,30}\b(?:IS|ARE|WAS|WERE)?\s*(?:PROVIDED|AVAILABLE|GIVEN)?\b/,
    /未提供|未给出|未包含|暂无.{0,20}(?:资料|参数|建议)|无.{0,20}(?:建议|参数|资料)/
  ];
  return absent.some(re=>re.test(s))?"absent":"positive";
}

function meaningfulLine(line=""){
  const s=norm(line);
  if(s.length<5)return false;
  if(/^(PAGE|第\s*\d+\s*页)\b/i.test(s))return false;
  return true;
}

export function buildGeotechEvidence(pages=[],meta={}){
  const evidence=[];let seq=1;
  for(const page of pages||[]){
    const pageNo=Number(page.pageNumber||1);
    const lines=(page.lines||String(page.text||"").split(/\r?\n+/)).map(norm).filter(meaningfulLine);
    for(let i=0;i<lines.length;i++){
      const line=lines[i],hits=classifyGeotechLine(line);
      if(!hits.length)continue;
      let text=line;
      const next=lines[i+1]||"";
      if(next && next.length<220 && !classifyGeotechLine(next).length && !/^\d+(?:\.\d+){1,3}\s/.test(next))text+=" "+next;
      const nums=extractGeotechNumbers(text),range=extractDepthRange(text);
      for(const hit of hits.slice(0,3)){
        evidence.push({
          id:String(meta.documentId||"doc")+":G"+String(seq++).padStart(4,"0"),
          key:hit.key,label:hit.label,
          pageNumber:pageNo,
          documentName:String(meta.documentName||"geotech.pdf"),
          text,score:hit.score,
          polarity:geotechEvidencePolarity(text),
          numbers:nums,depthRange:range
        });
      }
    }
  }
  return dedupeEvidence(evidence);
}

function dedupeEvidence(xs){
  const seen=new Set(),out=[];
  for(const x of xs){
    const k=x.key+"|"+x.pageNumber+"|"+upper(x.text);
    if(seen.has(k))continue;seen.add(k);out.push(x);
  }
  return out;
}

export function groupGeotechEvidence(evidence=[]){
  const groups={};for(const k of GEOTECH_KEYS)groups[k]=[];
  for(const e of evidence||[]){if(groups[e.key])groups[e.key].push(e)}
  for(const k of GEOTECH_KEYS)groups[k].sort((a,b)=>{
    const ap=a.polarity==="absent"?1:0,bp=b.polarity==="absent"?1:0;
    return ap-bp||b.score-a.score||a.pageNumber-b.pageNumber;
  });
  return groups;
}

export function selectGeotechEvidence(evidence=[],max=36){
  const groups=groupGeotechEvidence(evidence),out=[],seen=new Set();
  for(const k of GEOTECH_KEYS){
    const positives=groups[k].filter(e=>e.polarity!=="absent").slice(0,3);
    const absences=groups[k].filter(e=>e.polarity==="absent").slice(0,1);
    for(const e of [...positives,...(positives.length?[]:absences)]){
      if(!seen.has(e.id)){seen.add(e.id);out.push(e)}
    }
  }
  if(out.length<max){
    for(const e of [...evidence].sort((a,b)=>b.score-a.score)){
      if(out.length>=max)break;if(!seen.has(e.id)){seen.add(e.id);out.push(e)}
    }
  }
  return out.slice(0,max);
}

export function summarizeGeotechCoverage(evidence=[]){
  const groups=groupGeotechEvidence(evidence),found={},absent={},missing=[];
  for(const k of GEOTECH_KEYS){
    found[k]=groups[k].filter(e=>e.polarity!=="absent").length;
    absent[k]=groups[k].filter(e=>e.polarity==="absent").length;
    if(!found[k])missing.push(k);
  }
  return {total:evidence.length,found,absent,missing,covered:GEOTECH_KEYS.length-missing.length,totalKeys:GEOTECH_KEYS.length};
}

export function normalizeConditionSet(result={},candidateEvidence=[]){
  const valid=new Map((candidateEvidence||[]).map(x=>[x.id,x]));
  const byKey=new Map((Array.isArray(result.conditions)?result.conditions:[]).map(x=>[String(x.key||""),x]));
  const conditions=GEOTECH_KEYS.map(key=>{
    const raw=byKey.get(key)||{},citations=uniq((Array.isArray(raw.citations)?raw.citations:[]).map(String).filter(id=>valid.has(id)));
    const ev=citations.map(id=>valid.get(id));
    const status=citations.length?(["found","needs_review"].includes(raw.status)?raw.status:"found"):"not_found";
    return {
      key,status,
      value:status==="not_found"?"未在当前报告证据中找到":String(raw.value||"需人工复核"),
      designImplication:status==="not_found"?"补充地勘资料或人工复核原报告。":String(raw.designImplication||"需人工复核"),
      citations,
      pages:uniq(ev.map(x=>x.pageNumber)).sort((a,b)=>a-b),
      confidence:status==="not_found"?0:Math.max(0,Math.min(1,Number(raw.confidence)||.5))
    };
  });
  return conditions;
}
