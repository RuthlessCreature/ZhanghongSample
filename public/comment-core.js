import {normalizeText, compactText} from './diff-core.js';

const uniq = arr => [...new Set((arr||[]).filter(Boolean))];

export function extractSheetRefs(text=''){
  const t=String(text||'').toUpperCase();
  const re=/\b(?:A|AR|ARCH|S|ST|M|ME|E|EL|P|PL|L|C)[-. ]?\d{3,4}(?:\.\d+)?\b/g;
  return uniq((t.match(re)||[]).map(x=>x.replace(/\s+/g,'-').replace(/\.-/g,'.')));
}

export function extractMarks(text=''){
  const t=String(text||'').toUpperCase();
  const re=/\b[WD]\s*[-.]?\s*\d{1,4}[A-Z]?\b/g;
  return uniq((t.match(re)||[]).map(x=>x.replace(/\s+/g,'').replace('.', '-')));
}

export function extractRooms(text=''){
  const t=String(text||'').toUpperCase();
  const out=[];
  const re=/\bROOM\s*[-:]?\s*(\d{2,4}[A-Z]?)\b/g;
  let m; while((m=re.exec(t))) out.push(m[1]);
  return uniq(out);
}

export function extractNumbers(text=''){
  return uniq((String(text||'').match(/[-+]?\d+(?:\.\d+)?/g)||[]).map(Number).filter(Number.isFinite));
}

function cleanLine(line=''){
  return normalizeText(String(line||''))
    .replace(/^[•●▪■◆◇→\-–—]\s*/,'')
    .trim();
}

function stripLeadingIndex(line=''){
  return cleanLine(line)
    .replace(/^(?:第?\s*)?(?:C|R|NO\.?|ITEM)?\s*\d{1,3}\s*[\.\)、:：\-]\s*/i,'')
    .replace(/^\d{1,3}\s*[\.\)、:：\-]\s*/,'')
    .trim();
}

function isNewCommentLine(line=''){
  const s=cleanLine(line);
  return /^(?:第?\s*)?(?:C|R|NO\.?|ITEM)?\s*\d{1,3}\s*[\.\)、:：\-]\s*/i.test(s)
    || /^\d{1,3}\s*[\.\)、:：\-]\s*/.test(s)
    || /^[•●▪■◆◇]\s*/.test(String(line||'').trim());
}

export function parseCommentLines(lines=[]){
  const raw=(lines||[]).map(cleanLine).filter(x=>x && x.length>1);
  const groups=[]; let current='';
  const hasIndexed=raw.some(isNewCommentLine);
  let started=!hasIndexed;
  const push=()=>{const s=stripLeadingIndex(current); if(s.length>=3) groups.push(s); current='';};
  for(const line of raw){
    if(isNewCommentLine(line)){
      started=true;
      push(); current=line; continue;
    }
    // Real review sheets commonly contain project title / table headers before item 1.
    // If numbered items exist anywhere, ignore all leading non-item lines.
    if(!started) continue;
    if(!current){ current=line; continue; }
    // Wrapped PDF/Word lines are normally short continuations; explicit punctuation often still belongs to same comment.
    if(current.length<220 && line.length<180) current += ' ' + line;
    else { push(); current=line; }
  }
  push();

  // If no numbering/bullets survived extraction, split obvious semicolon-separated statements.
  const expanded=[];
  for(const g of groups){
    if(groups.length<=2 && /[；;]/.test(g) && g.length>100){
      expanded.push(...g.split(/[；;]/).map(x=>x.trim()).filter(x=>x.length>=5));
    } else expanded.push(g);
  }

  const seen=new Set(), comments=[];
  for(const text of expanded){
    const key=compactText(text);
    if(!key || seen.has(key)) continue;
    seen.add(key);
    comments.push({
      id:'C'+String(comments.length+1).padStart(3,'0'),
      text,
      targetSheets:extractSheetRefs(text),
      marks:extractMarks(text),
      rooms:extractRooms(text),
      numbers:extractNumbers(text)
    });
  }
  return comments.slice(0,80);
}

export function parseCommentsText(text=''){
  return parseCommentLines(String(text||'').split(/\r?\n+/));
}

function meaningfulTokens(text=''){
  const stop=new Set([
    'THE','AND','WITH','FROM','THIS','THAT','SHALL','PLEASE','CHECK','VERIFY','CHANGE','MODIFY','UPDATE','REVISE',
    '调整','修改','改为','变更','请','检查','核对','落实','增加','新增','删除','取消','同步','相关','图纸','意见'
  ]);
  const ascii=(String(text||'').toUpperCase().match(/[A-Z][A-Z0-9_-]{2,}|\d+(?:\.\d+)?/g)||[]);
  const zh=(String(text||'').match(/[\u4e00-\u9fff]{2,6}/g)||[]);
  return uniq([...ascii,...zh].filter(x=>!stop.has(x)));
}

function intersectionCount(a,b){
  const bs=new Set(b||[]); return (a||[]).filter(x=>bs.has(x)).length;
}

function changeText(change){
  return [change?.before,change?.after,change?.sheetId].filter(Boolean).join(' ');
}

function evidenceScore(comment, change){
  let score=0;
  const targetSheets=comment.targetSheets||[], marks=comment.marks||[], rooms=comment.rooms||[], nums=comment.numbers||[];
  if(change.sheetId && targetSheets.includes(change.sheetId)) score += 6;
  const evText=changeText(change);
  score += intersectionCount(marks,extractMarks(evText))*4;
  score += intersectionCount(rooms,extractRooms(evText))*4;

  const evNums=extractNumbers(evText);
  for(const n of nums){
    if(evNums.some(x=>Math.abs(x-n)<1e-9)) score += 1.5;
  }

  const ct=meaningfulTokens(comment.text), et=meaningfulTokens(evText);
  const overlap=intersectionCount(ct,et);
  score += Math.min(5, overlap*1.1);

  if(change.type==='add' && /(新增|增加|补充|ADD|NEW|INSERT)/i.test(comment.text)) score += .8;
  if(change.type==='remove' && /(删除|取消|移除|REMOVE|DELETE)/i.test(comment.text)) score += .8;
  if(change.type==='replace' && /(改为|调整为|修改为|变更为|CHANGE|REVISE|UPDATE|TO\b)/i.test(comment.text)) score += .8;
  return score;
}

function likelyImplemented(comment,candidates){
  const strong=candidates.filter(x=>x.score>=7);
  if(!strong.length) return 'no-evidence';

  const nums=comment.numbers||[];
  if(nums.length>=2){
    for(const c of strong){
      const n=c.change?.numeric;
      if(n && nums.some(x=>x===n.before) && nums.some(x=>x===n.after)) return 'likely-implemented';
    }
  }

  const removeIntent=/删除|取消|移除|关闭|清除|REMOVE|DELETE|CLOSE/i.test(comment.text);
  if(removeIntent){
    const commentTokens=meaningfulTokens(comment.text);
    for(const c of strong){
      const before=String(c.change?.before||''),after=String(c.change?.after||'');
      const beforeTokens=meaningfulTokens(before);
      const targetOverlap=intersectionCount(commentTokens,beforeTokens);
      const unresolvedOld=/\b(CHECK|VERIFY|TBD|TBC|PENDING|HOLD)\b/i.test(before);
      const unresolvedNew=/\b(CHECK|VERIFY|TBD|TBC|PENDING|HOLD)\b/i.test(after);
      if(c.change?.type==='remove' && targetOverlap) return 'likely-implemented';
      if(c.change?.type==='replace' && targetOverlap && unresolvedOld && !unresolvedNew) return 'likely-implemented';
    }
  }

  if(comment.marks?.length){
    const add=/新增|增加|补充|ADD|NEW|INSERT/i.test(comment.text);
    const remove=/删除|取消|移除|REMOVE|DELETE/i.test(comment.text);
    for(const c of strong){
      const marks=extractMarks(changeText(c.change));
      if(intersectionCount(comment.marks,marks)){
        if(add && (c.change.type==='add'||c.change.after)) return 'likely-implemented';
        if(remove && c.change.type==='remove') return 'likely-implemented';
      }
    }
  }

  return strong[0].score>=10 ? 'evidence-found' : 'candidate-found';
}

export function buildCommentEvidence(comments=[],textChanges=[]){
  return (comments||[]).map(comment=>{
    const candidates=(textChanges||[])
      .map(change=>({change,score:evidenceScore(comment,change)}))
      .filter(x=>x.score>=3)
      .sort((a,b)=>b.score-a.score)
      .slice(0,10);
    return {
      commentId:comment.id,
      targetSheets:comment.targetSheets||[],
      deterministicHint:likelyImplemented(comment,candidates),
      candidateIds:candidates.map(x=>x.change.id),
      candidates:candidates.map(x=>({
        id:x.change.id,
        score:Number(x.score.toFixed(2)),
        sheetId:x.change.sheetId||null,
        pageA:x.change.pageA||null,
        pageB:x.change.pageB||null,
        type:x.change.type,
        before:x.change.before||'',
        after:x.change.after||'',
        numeric:x.change.numeric||null
      }))
    };
  });
}

export function scorePagePairsForComments(comments=[],evidence=[],pairs=[],textChanges=[]){
  const scoreByKey=new Map();
  const key=(a,b)=>String(a)+'|'+String(b);
  const add=(a,b,n)=>scoreByKey.set(key(a,b),(scoreByKey.get(key(a,b))||0)+n);

  for(const e of evidence){
    const comment=comments.find(c=>c.id===e.commentId);
    for(const cand of e.candidates||[]){
      const ch=textChanges.find(x=>x.id===cand.id);
      if(!ch) continue;
      const p=pairs.find(x=>x.pageA===ch.pageA-1 && x.pageB===ch.pageB-1);
      if(p) add(p.pageA,p.pageB,Math.max(2,cand.score));
    }
    for(const sheet of comment?.targetSheets||[]){
      for(const p of pairs) if(p.sheetId===sheet) add(p.pageA,p.pageB,6);
    }
  }

  // Always preserve pairs with the most exact changes even when comments are vague.
  for(const p of pairs){
    const cnt=textChanges.filter(x=>x.pageA===p.pageA+1 && x.pageB===p.pageB+1).length;
    if(cnt) add(p.pageA,p.pageB,Math.min(8,cnt*.8));
  }

  return pairs.map(p=>({...p,score:Number((scoreByKey.get(key(p.pageA,p.pageB))||0).toFixed(2))}))
    .sort((a,b)=>b.score-a.score);
}
