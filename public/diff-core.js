export function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[，。；：]/g, m => ({"，":",","。":".","；":";","：":":"}[m]))
    .trim();
}

export function compactText(value) {
  return normalizeText(value).toUpperCase().replace(/\s+/g, "");
}

export function clamp(n, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

function levenshtein(a, b) {
  a = compactText(a); b = compactText(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = next;
  }
  return prev[b.length];
}

export function textSimilarity(a, b) {
  const aa = compactText(a), bb = compactText(b);
  const maxLen = Math.max(aa.length, bb.length);
  if (!maxLen) return 1;
  return clamp(1 - levenshtein(aa, bb) / maxLen);
}

export function positionDistance(a, b) {
  const dx = Number(a?.x ?? .5) - Number(b?.x ?? .5);
  const dy = Number(a?.y ?? .5) - Number(b?.y ?? .5);
  return Math.sqrt(dx * dx + dy * dy);
}

export function parseSingleNumber(text) {
  const s = normalizeText(text).replace(/,/g, "");
  const matches = s.match(/[-+]?\d+(?:\.\d+)?/g) || [];
  if (matches.length !== 1) return null;
  const value = Number(matches[0]);
  return Number.isFinite(value) ? value : null;
}

function surroundingSignature(text) {
  return compactText(text).replace(/[-+]?\d+(?:\.\d+)?/g, "#");
}

function replacementScore(a, b) {
  const dist = positionDistance(a, b);
  if (dist > 0.10) return -1;
  const sim = textSimilarity(a.str, b.str);
  const na = parseSingleNumber(a.str), nb = parseSingleNumber(b.str);
  const sameNumericShell = na !== null && nb !== null && surroundingSignature(a.str) === surroundingSignature(b.str);
  const proximity = clamp(1 - dist / 0.10);
  const lengthCompat = 1 - Math.min(1, Math.abs(normalizeText(a.str).length - normalizeText(b.str).length) / 24);
  if (sameNumericShell) return .62 * proximity + .28 * lengthCompat + .10;
  if (na !== null && nb !== null && surroundingSignature(a.str) !== surroundingSignature(b.str)) return -1;
  // Never pair unrelated nearby labels just because their coordinates overlap.
  // Large revision-note rewrites should become add/remove evidence, not bogus replacements.
  if (sim < 0.28) return -1;
  return .55 * proximity + .35 * sim + .10 * lengthCompat;
}

function exactKey(item) {
  return compactText(item?.str);
}

function normalizeItem(item, index) {
  return {
    index,
    str: normalizeText(item?.str),
    x: clamp(Number(item?.x ?? 0)),
    y: clamp(Number(item?.y ?? 0)),
    w: clamp(Number(item?.w ?? 0)),
    h: clamp(Number(item?.h ?? 0))
  };
}


export function mergeTextItems(items = [], opts = {}) {
  const yTolerance = opts.yTolerance ?? 0.008;
  const gapTolerance = opts.gapTolerance ?? 0.018;
  const normalized = items.map(normalizeItem).filter(x => x.str).sort((a,b)=>(a.y-b.y)||(a.x-b.x));
  const rows=[];
  for(const item of normalized){
    let row=null;
    for(let i=rows.length-1;i>=0;i--){
      const r=rows[i];
      const tol=Math.max(yTolerance, Math.max(item.h||0,r.h||0)*0.65);
      if(Math.abs(item.y-r.y)<=tol){row=r;break;}
      if(item.y-r.y>tol*2) break;
    }
    if(!row){row={y:item.y,h:item.h,items:[]};rows.push(row);}
    row.items.push(item);
    row.y=(row.y*(row.items.length-1)+item.y)/row.items.length;
    row.h=Math.max(row.h||0,item.h||0);
  }
  const merged=[];
  for(const row of rows){
    const list=row.items.sort((a,b)=>a.x-b.x);
    let cur=null;
    for(const item of list){
      if(!cur){cur={...item};continue;}
      const gap=item.x-(cur.x+cur.w);
      if(gap<=gapTolerance && gap>=-0.01){
        cur.str=(cur.str+' '+item.str).replace(/\s+/g,' ').trim();
        const right=Math.max(cur.x+cur.w,item.x+item.w);
        cur.w=right-cur.x; cur.h=Math.max(cur.h,item.h);
      }else{merged.push(cur);cur={...item};}
    }
    if(cur)merged.push(cur);
  }
  return merged.map(({index,...x})=>x);
}

export function diffTextItems(itemsA = [], itemsB = [], opts = {}) {
  const a = itemsA.map(normalizeItem).filter(x => x.str);
  const b = itemsB.map(normalizeItem).filter(x => x.str);
  const usedA = new Set(), usedB = new Set();
  const exactBuckets = new Map();
  b.forEach((item, i) => {
    const k = exactKey(item);
    if (!exactBuckets.has(k)) exactBuckets.set(k, []);
    exactBuckets.get(k).push(i);
  });

  a.forEach((item, ai) => {
    const candidates = (exactBuckets.get(exactKey(item)) || []).filter(bi => !usedB.has(bi));
    if (!candidates.length) return;
    candidates.sort((x, y) => positionDistance(item, b[x]) - positionDistance(item, b[y]));
    const bi = candidates[0];
    if (positionDistance(item, b[bi]) <= (opts.exactMoveTolerance ?? .065)) {
      usedA.add(ai); usedB.add(bi);
    }
  });

  const remainingA = a.map((x, i) => ({...x, _i:i})).filter(x => !usedA.has(x._i));
  const remainingB = b.map((x, i) => ({...x, _i:i})).filter(x => !usedB.has(x._i));
  const candidatePairs = [];
  for (const aa of remainingA) {
    for (const bb of remainingB) {
      const score = replacementScore(aa, bb);
      if (score >= (opts.replaceThreshold ?? .48)) candidatePairs.push({aa, bb, score});
    }
  }
  candidatePairs.sort((x,y) => y.score - x.score);
  const pairedA = new Set(), pairedB = new Set();
  for (const p of candidatePairs) {
    if (pairedA.has(p.aa._i) || pairedB.has(p.bb._i)) continue;
    pairedA.add(p.aa._i); pairedB.add(p.bb._i);
  }

  const changes = [];
  for (const p of candidatePairs) {
    if (!pairedA.has(p.aa._i) || !pairedB.has(p.bb._i)) continue;
    if (changes.some(x => x._ai === p.aa._i || x._bi === p.bb._i)) continue;
    const na = parseSingleNumber(p.aa.str), nb = parseSingleNumber(p.bb.str);
    const numericCompatible = na !== null && nb !== null && surroundingSignature(p.aa.str) === surroundingSignature(p.bb.str);
    changes.push({
      _ai:p.aa._i,_bi:p.bb._i,
      type: "replace",
      before: p.aa.str,
      after: p.bb.str,
      position: {x:(p.aa.x+p.bb.x)/2, y:(p.aa.y+p.bb.y)/2},
      beforeBox: {x:p.aa.x,y:p.aa.y,w:p.aa.w,h:p.aa.h},
      afterBox: {x:p.bb.x,y:p.bb.y,w:p.bb.w,h:p.bb.h},
      matchConfidence: clamp(p.score),
      numeric: numericCompatible ? {before:na, after:nb, delta:nb-na} : null
    });
  }

  for (const aa of remainingA) {
    if (pairedA.has(aa._i)) continue;
    changes.push({
      type:"remove", before:aa.str, after:"", position:{x:aa.x,y:aa.y},
      beforeBox:{x:aa.x,y:aa.y,w:aa.w,h:aa.h}, afterBox:null,
      matchConfidence:1, numeric:null
    });
  }
  for (const bb of remainingB) {
    if (pairedB.has(bb._i)) continue;
    changes.push({
      type:"add", before:"", after:bb.str, position:{x:bb.x,y:bb.y},
      beforeBox:null, afterBox:{x:bb.x,y:bb.y,w:bb.w,h:bb.h},
      matchConfidence:1, numeric:null
    });
  }

  return changes.map(({_ai,_bi,...x})=>x).sort((x,y) => (x.position.y-y.position.y) || (x.position.x-y.position.x));
}

export function detectSheetId(text = "") {
  const t = normalizeText(text).toUpperCase();
  const token = "(?:A|AR|ARCH|S|ST|M|ME|E|EL|P|PL|L|C)[-. ]?\\d{2,4}(?:\\.\\d+)?";
  const explicit = [
    new RegExp("\\bSHEET(?:\\s+(?:NO|NUMBER))?\\s*[:#-]?\\s*(" + token + ")\\b", "g"),
    new RegExp("(?:图号|圖號)\\s*[:：#-]?\\s*(" + token + ")\\b", "g")
  ];
  for (const re of explicit) {
    const matches=[...t.matchAll(re)];
    if (matches.length) return matches[matches.length - 1][1].replace(/\s+/g, "-");
  }
  const patterns = [
    new RegExp("\\b" + token + "\\b", "g"),
    /\b[A-Z]{1,3}[-.]\d{2,4}\b/g
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.length) return m[m.length - 1].replace(/\s+/g, "-");
  }
  return null;
}

export function pairPages(pagesA = [], pagesB = []) {
  const usedB = new Set();
  const pairs = [];
  const bBySheet = new Map();
  pagesB.forEach((p,i) => {
    const sid = p.sheetId || detectSheetId(p.textRaw || "");
    if (sid) {
      if (!bBySheet.has(sid)) bBySheet.set(sid, []);
      bBySheet.get(sid).push(i);
    }
  });

  pagesA.forEach((pa, ai) => {
    const sid = pa.sheetId || detectSheetId(pa.textRaw || "");
    let bi = null;
    if (sid && bBySheet.has(sid)) bi = bBySheet.get(sid).find(i => !usedB.has(i)) ?? null;
    if (bi === null && ai < pagesB.length && !usedB.has(ai)) bi = ai;
    if (bi === null) bi = pagesB.findIndex((_,i) => !usedB.has(i));
    if (bi >= 0) {
      usedB.add(bi);
      pairs.push({pageA: ai, pageB: bi, sheetId: sid || pagesB[bi]?.sheetId || null, method: sid ? "sheet-id" : "index"});
    } else pairs.push({pageA: ai, pageB: null, sheetId:sid, method:"unmatched"});
  });
  pagesB.forEach((pb, bi) => {
    if (!usedB.has(bi)) pairs.push({pageA:null,pageB:bi,sheetId:pb.sheetId || null,method:"unmatched"});
  });
  return pairs;
}

export function summarizeDeterministicDiff(pagesA = [], pagesB = [], pairs = pairPages(pagesA,pagesB)) {
  const textChanges = [];
  let seq = 1;
  for (const pair of pairs) {
    if (pair.pageA === null || pair.pageB === null) continue;
    const pa = pagesA[pair.pageA], pb = pagesB[pair.pageB];
    const changes = diffTextItems(pa.textItems || [], pb.textItems || []);
    for (const c of changes) {
      const material = compactText(c.before) || compactText(c.after);
      if (!material || /^[\W_]+$/.test(material)) continue;
      textChanges.push({
        id:`T${String(seq++).padStart(3,"0")}`,
        sheetId:pair.sheetId,
        pageA:pair.pageA+1,
        pageB:pair.pageB+1,
        ...c,
        source:"pdf_text"
      });
    }
  }
  const textItemsA = pagesA.reduce((n,p)=>n+(p.textItems?.length||0),0);
  const textItemsB = pagesB.reduce((n,p)=>n+(p.textItems?.length||0),0);
  return {
    pagePairs:pairs,
    textChanges,
    textCoverage:{
      itemsA:textItemsA, itemsB:textItemsB,
      mode:(textItemsA+textItemsB)>=8 ? "hybrid" : "visual-only"
    }
  };
}
