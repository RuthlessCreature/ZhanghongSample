import {detectSheetId} from './diff-core.js';

const norm = v => String(v ?? '').replace(/\s+/g,' ').trim();
const upper = v => norm(v).toUpperCase();
const uniq = arr => [...new Set(arr.filter(Boolean))];

export function classifySheet(text=''){
  const t=upper(text);
  if(/DRAWING\s+(INDEX|LIST)|SHEET\s+(INDEX|LIST)|图纸目录|图纸清单/.test(t)) return 'index';
  if(/DOOR.*WINDOW.*SCHEDULE|WINDOW.*SCHEDULE|DOOR.*SCHEDULE|门窗表|门窗明细/.test(t)) return 'schedule';
  if(/FLOOR PLAN|GROUND FLOOR PLAN|LEVEL\s*\d+[^|]{0,40}PLAN|平面图|首层平面|平面布置/.test(t)) return 'plan';
  if(/ELEVATION|立面图|南立面|北立面|东立面|西立面/.test(t)) return 'elevation';
  if(/SECTION|剖面图|剖面/.test(t)) return 'section';
  if(/DETAIL|详图|大样/.test(t)) return 'detail';
  if(/GENERAL NOTES|DESIGN NOTES|设计说明|总说明/.test(t)) return 'notes';
  if(/\bPLAN\b|平面/.test(t)) return 'plan';
  return 'other';
}

function marks(text='', prefix){
  const t=upper(text);
  const re = prefix==='W'
    ? /\bW\s*[-.]?\s*\d{1,4}[A-Z]?\b/g
    : /\bD\s*[-.]?\s*\d{1,4}[A-Z]?\b/g;
  return uniq((t.match(re)||[]).map(x=>x.replace(/\s+/g,'').replace('.', '-')));
}

export function referencedSheets(text=''){
  const t=upper(text);
  return uniq((t.match(/\b(?:A|AR|ARCH|S|ST|M|ME|E|EL|P|PL|L|C)[-. ]?\d{2,4}(?:\.\d+)?\b/g)||[])
    .map(x=>x.replace(/\s+/g,'')));
}

function rooms(text=''){
  const t=upper(text);
  const out=[];
  const re=/\bROOM\s+(\d{2,4}[A-Z]?)\s*[:\-]?\s*([A-Z][A-Z0-9 &/()\-]{2,45}?)(?=\s{2,}|\s(?:ROOM|SHEET|REV|CHECK|VERIFY|TBD|PENDING|HOLD|DOOR|WINDOW|STAIR|REFERENCES)\b|$)/g;
  let m;
  while((m=re.exec(t))){
    let name=norm(m[2]).replace(/\s+(SHEET|REV|ISSUE)$/,'').trim();
    if(name) out.push({id:m[1],name});
  }
  return out;
}

function unresolvedMentions(text=''){
  const src=norm(text);
  const up=src.toUpperCase();
  const re=/\b(TBD|TBC|VERIFY|CHECK|PENDING|HOLD)\b|待定|待确认|需确认|复核|核对/g;
  const out=[];
  let m;
  while((m=re.exec(up))){
    const start=Math.max(0,m.index-55), end=Math.min(src.length,m.index+m[0].length+85);
    const excerpt=src.slice(start,end).trim();
    const e=excerpt.toUpperCase();
    // Do not flag policy/general-note statements that only prohibit unresolved markers.
    if(/ALL\s+CHECK.{0,60}SHALL\s+BE\s+CLOSED/.test(e)) continue;
    if(/NO\s+(CHECK|VERIFY|TBD|TBC|PENDING|HOLD).{0,50}(MAY|SHALL)/.test(e)) continue;
    if(/(CHECK|VERIFY|TBD|TBC|PENDING|HOLD).{0,50}(NOT\s+PERMITTED|PROHIBITED)/.test(e)) continue;
    out.push({keyword:m[0].toUpperCase(),excerpt});
  }
  const seen=new Set();
  return out.filter(x=>{
    const k=x.keyword+'|'+x.excerpt;
    if(seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0,12);
}

function revisionPlaceholders(text=''){
  const t=upper(text);
  const hits=[];
  const re=/\bREV(?:ISION)?\s*[:\-]?\s*(TBD|TBC|PENDING|XX|\?+)\b/g;
  let m; while((m=re.exec(t))) hits.push(m[0]);
  return uniq(hits);
}

function alert(id,severity,category,location,issue,evidence,source='pdf_text',meta={}){
  return {id,severity,category,location,issue,evidence,source,...meta};
}

function pageLocation(p){ return p.sheetId || ('P'+p.page); }

export function deterministicReview(pages=[], sourcePages=pages.length){
  const normalized=pages.map((p,i)=>{
    const text=norm(p.textRaw||p.textDigest||'');
    const sheetId=p.sheetId||detectSheetId(text);
    return {
      page:Number(p.pageNumber||i+1),
      sheetId,
      text,
      role:classifySheet(text),
      windows:marks(text,'W'),
      doors:marks(text,'D'),
      refs:referencedSheets(text),
      rooms:rooms(text),
      unresolved:unresolvedMentions(text),
      revisionPlaceholders:revisionPlaceholders(text),
      textItemCount:Number(p.textItemCount ?? p.textItems?.length ?? 0)
    };
  });

  const alerts=[]; let seq=1;
  const aid=()=> 'P'+String(seq++).padStart(3,'0');

  // Sheet number integrity.
  normalized.forEach(p=>{
    if(!p.sheetId){
      alerts.push(alert(aid(),'medium','图号/图框','第 '+p.page+' 页','未识别到明确图号','PDF 文字层未识别到 A-101 / A-201 等图号；建议人工确认图框。'));
    }
  });
  const bySheet=new Map();
  normalized.forEach(p=>{
    if(!p.sheetId) return;
    if(!bySheet.has(p.sheetId)) bySheet.set(p.sheetId,[]);
    bySheet.get(p.sheetId).push(p.page);
  });
  for(const [sid,pagesFound] of bySheet){
    if(pagesFound.length>1){
      alerts.push(alert(aid(),'high','图号/图框',sid,'图号 '+sid+' 在当前文件中重复出现','出现页码：'+pagesFound.join(', ')));
    }
  }

  const fullyLoaded=sourcePages<=pages.length;
  const actualSheets=uniq(normalized.map(p=>p.sheetId));
  const loadedSet=new Set(actualSheets);

  // Drawing index vs actual files.
  const indexPages=normalized.filter(p=>p.role==='index');
  if(indexPages.length){
    const listed=uniq(indexPages.flatMap(p=>p.refs).filter(x=>x!=='A-000'));
    const actualNonIndex=actualSheets.filter(x=>x!=='A-000');
    const listedMissing=listed.filter(x=>!loadedSet.has(x));
    const actualOmitted=fullyLoaded ? actualNonIndex.filter(x=>!listed.includes(x)) : [];
    if(listedMissing.length){
      alerts.push(alert(aid(),'high','图纸目录',indexPages.map(pageLocation).join(', '),'图纸目录列出当前套图中不存在的图号','目录列出：'+listedMissing.join(', ')+'；需确认是否漏页、误列或未发行。'));
    }
    if(actualOmitted.length){
      alerts.push(alert(aid(),'medium','图纸目录',indexPages.map(pageLocation).join(', '),'当前套图存在未列入图纸目录的已发行图号','未列入目录：'+actualOmitted.join(', ')+'。'));
    }
  }

  // Door/window schedule consistency.
  const schedulePages=normalized.filter(p=>p.role==='schedule');
  const planPages=normalized.filter(p=>p.role==='plan');
  const scheduleWindows=uniq(schedulePages.flatMap(p=>p.windows));
  const scheduleDoors=uniq(schedulePages.flatMap(p=>p.doors));
  const planWindows=uniq(planPages.flatMap(p=>p.windows));
  const planDoors=uniq(planPages.flatMap(p=>p.doors));

  if((planWindows.length||planDoors.length) && !schedulePages.length){
    alerts.push(alert(aid(),'high','门窗一致性',planPages.map(pageLocation).join(', '),'平面存在门窗编号，但当前套图未识别到门窗表','平面门号：'+planDoors.join(', ')+'；窗号：'+planWindows.join(', ')+'。'));
  }
  if(schedulePages.length){
    for(const m of planWindows.filter(x=>!scheduleWindows.includes(x))){
      const loc=planPages.filter(p=>p.windows.includes(m)).map(pageLocation);
      alerts.push(alert(aid(),'high','门窗一致性',loc.join(', '),'平面出现窗号 '+m+'，但门窗表文字层未检出该编号','门窗表：'+schedulePages.map(pageLocation).join(', ')+'；需核查是否漏登记。',{},{mark:m,kind:'window',direction:'plan-to-schedule'}));
    }
    for(const m of planDoors.filter(x=>!scheduleDoors.includes(x))){
      const loc=planPages.filter(p=>p.doors.includes(m)).map(pageLocation);
      alerts.push(alert(aid(),'high','门窗一致性',loc.join(', '),'平面出现门号 '+m+'，但门窗表文字层未检出该编号','门窗表：'+schedulePages.map(pageLocation).join(', ')+'；需核查是否漏登记。',{},{mark:m,kind:'door',direction:'plan-to-schedule'}));
    }
    if(fullyLoaded){
      for(const m of scheduleWindows.filter(x=>!planWindows.includes(x))){
        alerts.push(alert(aid(),'medium','门窗一致性',schedulePages.map(pageLocation).join(', '),'门窗表存在窗号 '+m+'，但当前已扫描平面未检出该编号','可能是表内孤立编号、其他未扫描楼层或图面文字提取遗漏；需人工确认。',{},{mark:m,kind:'window',direction:'schedule-to-plan'}));
      }
      for(const m of scheduleDoors.filter(x=>!planDoors.includes(x))){
        alerts.push(alert(aid(),'medium','门窗一致性',schedulePages.map(pageLocation).join(', '),'门窗表存在门号 '+m+'，但当前已扫描平面未检出该编号','可能是表内孤立编号、其他未扫描楼层或图面文字提取遗漏；需人工确认。',{},{mark:m,kind:'door',direction:'schedule-to-plan'}));
      }
    }
  }

  // Room number/name conflicts.
  const roomMap=new Map();
  normalized.forEach(p=>{
    for(const r of p.rooms){
      if(!roomMap.has(r.id)) roomMap.set(r.id,[]);
      roomMap.get(r.id).push({name:r.name,sheetId:p.sheetId,page:p.page});
    }
  });
  for(const [roomId, refs] of roomMap){
    const names=uniq(refs.map(x=>x.name));
    if(names.length>1){
      alerts.push(alert(aid(),'high','房间编号/名称',refs.map(x=>x.sheetId||('P'+x.page)).join(', '),'同一房间编号 ROOM '+roomId+' 出现多个名称','检测到：'+names.join(' ↔ ')+'。',{},{roomId,names}));
    }
  }

  // Unresolved markers and revision placeholders.
  normalized.forEach(p=>{
    if(p.unresolved.length){
      alerts.push(alert(aid(),'medium','未闭环标记',pageLocation(p),'发现待确认/待定类文字，正式出图前应闭环',p.unresolved.map(x=>x.keyword+': '+x.excerpt).join(' | ').slice(0,1200), 'pdf_text',{keywords:uniq(p.unresolved.map(x=>x.keyword))}));
    }
    if(p.revisionPlaceholders.length){
      alerts.push(alert(aid(),'medium','图号/图框',pageLocation(p),'修订栏存在占位符或未确认版本号','命中：'+p.revisionPlaceholders.join(', ')));
    }
  });

  // Missing internal cross-sheet references.
  if(fullyLoaded){
    normalized.filter(p=>p.role!=='index').forEach(p=>{
      const missing=p.refs.filter(ref=>ref!==p.sheetId&&!loadedSet.has(ref));
      if(missing.length){
        alerts.push(alert(aid(),'medium','图纸引用',pageLocation(p),'检测到当前套图中未找到的图号引用','引用：'+missing.slice(0,12).join(', ')+'。可能是漏页、未发行图纸或其他专业引用，需人工确认。',{},{missingRefs:missing}));
      }
    });
  }

  const itemCount=normalized.reduce((n,p)=>n+p.textItemCount,0);
  const textPages=normalized.filter(p=>p.textItemCount>0).length;
  const coverageMode=itemCount>=10 && textPages>=Math.max(1,Math.ceil(normalized.length*.4)) ? 'hybrid' : 'visual-only';

  return {
    textCoverage:{
      mode:coverageMode,
      totalTextItems:itemCount,
      pagesWithText:textPages,
      pagesWithSheetId:normalized.filter(p=>p.sheetId).length,
      scannedPages:normalized.length,
      sourcePages
    },
    sheets:normalized.map(({text,...x})=>x),
    alerts,
    indices:{
      planWindows,planDoors,scheduleWindows,scheduleDoors,
      roomIds:[...roomMap.keys()],
      actualSheets,
      indexSheets:indexPages.length?uniq(indexPages.flatMap(p=>p.refs)):[]
    },
    fullyLoaded
  };
}

export function rankReviewPages(pages=[],deterministic,maxPages=10){
  const roleWeight={plan:45,schedule:45,index:35,elevation:32,section:30,notes:26,detail:24,other:10};
  const alertText=(deterministic?.alerts||[]).map(a=>(a.location||'')+' '+(a.evidence||'')+' '+(a.issue||'')).join(' ');
  const scored=pages.map((p,i)=>{
    const sheetId=p.sheetId||detectSheetId(p.textRaw||p.textDigest||'');
    const role=classifySheet(p.textRaw||p.textDigest||'');
    let score=roleWeight[role]||10;
    if(sheetId && alertText.includes(sheetId)) score+=75;
    const txt=upper(p.textRaw||p.textDigest||'');
    if(/\b(CHECK|VERIFY|TBD|TBC|PENDING|HOLD)\b/.test(txt)) score+=25;
    if(/DOOR|WINDOW|门|窗/.test(txt)) score+=8;
    return {index:i,pageNumber:Number(p.pageNumber||i+1),sheetId,role,score};
  });
  return scored.sort((a,b)=>b.score-a.score||a.pageNumber-b.pageNumber).slice(0,maxPages);
}
