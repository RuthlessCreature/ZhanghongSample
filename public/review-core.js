import {detectSheetId} from './diff-core.js';

const norm = v => String(v ?? '').replace(/\s+/g,' ').trim();
const uniq = arr => [...new Set(arr)];

function classifySheet(text=''){
  const t=norm(text).toUpperCase();
  if(/DOOR.*WINDOW.*SCHEDULE|WINDOW.*SCHEDULE|门窗表|门窗明细/.test(t)) return 'schedule';
  if(/ELEVATION|立面/.test(t)) return 'elevation';
  if(/SECTION|剖面/.test(t)) return 'section';
  if(/DETAIL|详图|大样/.test(t)) return 'detail';
  if(/GENERAL NOTES|DESIGN NOTES|设计说明|总说明|说明/.test(t)) return 'notes';
  if(/FLOOR PLAN|PLAN|平面/.test(t)) return 'plan';
  return 'other';
}

function marks(text='', prefix){
  const t=norm(text).toUpperCase();
  const re = prefix==='W' ? /\bW\s*[-.]?\s*\d{1,4}[A-Z]?\b/g : /\bD\s*[-.]?\s*\d{1,4}[A-Z]?\b/g;
  return uniq((t.match(re)||[]).map(x=>x.replace(/\s+/g,'').replace('.', '-')));
}

function referencedSheets(text=''){
  const t=norm(text).toUpperCase();
  return uniq((t.match(/\b(?:A|AR|ARCH|S|ST|M|ME|E|EL|P|PL|L|C)[-. ]?\d{2,4}(?:\.\d+)?\b/g)||[])
    .map(x=>x.replace(/\s+/g,'')));
}

function alert(id,severity,category,location,issue,evidence,source='pdf_text'){
  return {id,severity,category,location,issue,evidence,source};
}

export function deterministicReview(pages=[], sourcePages=pages.length){
  const normalized=pages.map((p,i)=>{
    const text=norm(p.textRaw||p.textDigest||'');
    const sheetId=p.sheetId||detectSheetId(text);
    return {
      page:i+1,
      sheetId,
      text,
      role:classifySheet(text),
      windows:marks(text,'W'),
      doors:marks(text,'D'),
      refs:referencedSheets(text),
      textItemCount:Number(p.textItemCount ?? p.textItems?.length ?? 0)
    };
  });

  const alerts=[]; let seq=1;
  const aid=()=> 'P'+String(seq++).padStart(3,'0');

  normalized.forEach(p=>{
    if(!p.sheetId) alerts.push(alert(aid(),'medium','图号','第 '+p.page+' 页','未识别到明确图号','PDF 文字层未识别到 A-101 / A-201 等图号；建议人工确认图框。'));
  });

  const bySheet=new Map();
  normalized.forEach(p=>{if(p.sheetId){if(!bySheet.has(p.sheetId))bySheet.set(p.sheetId,[]);bySheet.get(p.sheetId).push(p.page)}});
  for(const [sid,pagesFound] of bySheet){
    if(pagesFound.length>1) alerts.push(alert(aid(),'high','图号',sid,'图号 '+sid+' 在当前文件中重复出现','出现页码：'+pagesFound.join(', ')));
  }

  const schedulePages=normalized.filter(p=>p.role==='schedule');
  const planPages=normalized.filter(p=>p.role==='plan');
  const scheduleWindows=uniq(schedulePages.flatMap(p=>p.windows));
  const scheduleDoors=uniq(schedulePages.flatMap(p=>p.doors));
  const planWindows=uniq(planPages.flatMap(p=>p.windows));
  const planDoors=uniq(planPages.flatMap(p=>p.doors));

  if(schedulePages.length){
    for(const m of planWindows.filter(x=>!scheduleWindows.includes(x))){
      const locations=planPages.filter(p=>p.windows.includes(m)).map(p=>p.sheetId||('P'+p.page));
      alerts.push(alert(aid(),'high','门窗一致性',locations.join(', '),'平面出现窗号 '+m+'，但当前门窗表文字层未检出该编号','门窗表页：'+schedulePages.map(p=>p.sheetId||('P'+p.page)).join(', ')+'；需核查是否漏登记。'));
    }
    for(const m of planDoors.filter(x=>!scheduleDoors.includes(x))){
      const locations=planPages.filter(p=>p.doors.includes(m)).map(p=>p.sheetId||('P'+p.page));
      alerts.push(alert(aid(),'high','门窗一致性',locations.join(', '),'平面出现门号 '+m+'，但当前门窗表文字层未检出该编号','门窗表页：'+schedulePages.map(p=>p.sheetId||('P'+p.page)).join(', ')+'；需核查是否漏登记。'));
    }
  }

  const unresolvedRe=/\b(TBD|TBC|VERIFY|CHECK|PENDING|HOLD)\b|待定|待确认|需确认|复核|核对/g;
  normalized.forEach(p=>{
    const hits=uniq((p.text.match(unresolvedRe)||[]).map(x=>x.toUpperCase())).slice(0,8);
    if(hits.length) alerts.push(alert(aid(),'medium','未闭环标记',p.sheetId||('P'+p.page),'发现 CHECK / VERIFY / TBD 等待确认文字','命中：'+hits.join(', ')+'。应确认这些项目是否已在最终出图前闭环。'));
  });

  const loadedSheets=new Set(normalized.map(p=>p.sheetId).filter(Boolean));
  const fullyLoaded=sourcePages<=pages.length;
  if(fullyLoaded){
    normalized.forEach(p=>{
      const missing=p.refs.filter(ref=>ref!==p.sheetId&&!loadedSheets.has(ref));
      if(missing.length){
        alerts.push(alert(aid(),'low','图纸引用',p.sheetId||('P'+p.page),'检测到当前文件中未找到的图号引用','引用：'+missing.slice(0,8).join(', ')+'。可能是外部专业/未包含图纸，需人工确认。'));
      }
    });
  }

  const itemCount=normalized.reduce((n,p)=>n+p.textItemCount,0);
  const coverageMode=itemCount>=10?'hybrid':'visual-only';
  return {
    textCoverage:{mode:coverageMode,totalTextItems:itemCount,pagesWithSheetId:normalized.filter(p=>p.sheetId).length,totalPages:normalized.length},
    sheets:normalized.map(({text,...x})=>x),
    alerts,
    indices:{planWindows,planDoors,scheduleWindows,scheduleDoors},
    fullyLoaded
  };
}
