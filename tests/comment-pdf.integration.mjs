import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {mergeTextItems,detectSheetId,pairPages,summarizeDeterministicDiff} from '../public/diff-core.js';
import {parseCommentLines,buildCommentEvidence,scorePagePairsForComments} from '../public/comment-core.js';

const PAGE=[842,595];
async function makePdf(pages){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const p of pages){
    const page=pdf.addPage(PAGE);
    let y=550;
    for(const line of p){
      page.drawText(line,{x:42,y,size:12,font,color:rgb(0,0,0)});
      y-=26;
    }
  }
  return new Uint8Array(await pdf.save());
}
async function scanPdf(bytes){
  const doc=await pdfjs.getDocument({data:bytes,disableWorker:true}).promise,pages=[];
  for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i),raw=page.getViewport({scale:1});
    const tc=await page.getTextContent();
    const items=mergeTextItems(tc.items.map(item=>({
      str:String(item.str||'').trim(),
      x:Number(item.transform?.[4]||0)/raw.width,
      y:1-Number(item.transform?.[5]||0)/raw.height,
      w:Number(item.width||0)/raw.width,
      h:Math.abs(Number(item.height||item.transform?.[3]||0))/raw.height
    })).filter(x=>x.str));
    const textRaw=items.map(x=>x.str).join(' | ');
    pages.push({pageNumber:i,sheetId:detectSheetId(textRaw),textItems:items,textRaw});
  }
  return pages;
}
async function commentLines(bytes){
  const doc=await pdfjs.getDocument({data:bytes,disableWorker:true}).promise,lines=[];
  for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i),tc=await page.getTextContent(),rows=[];
    for(const item of tc.items){
      const s=String(item.str||'').trim(); if(!s)continue;
      const y=Number(item.transform?.[5]||0),x=Number(item.transform?.[4]||0);
      let row=rows.find(r=>Math.abs(r.y-y)<=4);
      if(!row){row={y,items:[]};rows.push(row);}
      row.items.push({x,s});
    }
    lines.push(...rows.sort((a,b)=>b.y-a.y).map(r=>r.items.sort((a,b)=>a.x-b.x).map(x=>x.s).join(' ')));
  }
  return lines;
}

const commentsPdf=await makePdf([[
  'CHIEF ENGINEER REVIEW COMMENTS',
  '1. A-101 change ROOM 102 from MEETING ROOM to CONFERENCE ROOM.',
  '2. A-101 change STAIR CLR from 1200 to 1350.',
  '3. Add W03 and coordinate A-101, A-201 and A-601.',
  '4. Delete D09 from A-601.',
  '5. A-101 change overall dimension from 23000 to 23800.',
  '6. Remove CHECK FIRESTOP note from A-301.',
  '7. Coordinate MEP shaft between A-101 and A-301.'
]]);
const oldPdf=await makePdf([
  ['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 102: MEETING ROOM','STAIR CLR 1200','WINDOWS W01 W02','OVERALL 23000'],
  ['SHEET: A-201','SOUTH ELEVATION','WINDOWS W01 W02'],
  ['SHEET: A-301','BUILDING SECTION','CHECK FIRESTOP DETAIL'],
  ['SHEET: A-601','DOOR WINDOW SCHEDULE','W01 WINDOW','W02 WINDOW','D09 DOOR']
]);
const newPdf=await makePdf([
  ['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 102: CONFERENCE ROOM','STAIR CLR 1350','WINDOWS W01 W02 W03','OVERALL 23800'],
  ['SHEET: A-201','SOUTH ELEVATION','WINDOWS W01 W02 W03'],
  ['SHEET: A-301','BUILDING SECTION','CHECK FIRESTOP DETAIL'],
  ['SHEET: A-601','DOOR WINDOW SCHEDULE','W01 WINDOW','W02 WINDOW']
]);

const comments=parseCommentLines(await commentLines(commentsPdf));
assert.equal(comments.length,7);
const [oldPages,newPages]=await Promise.all([scanPdf(oldPdf),scanPdf(newPdf)]);
assert.deepEqual(oldPages.map(x=>x.sheetId),['A-101','A-201','A-301','A-601']);
assert.deepEqual(newPages.map(x=>x.sheetId),['A-101','A-201','A-301','A-601']);

const pairs=pairPages(oldPages,newPages),det=summarizeDeterministicDiff(oldPages,newPages,pairs);
const ev=buildCommentEvidence(comments,det.textChanges);
assert.ok(ev.find(x=>x.commentId==='C001')?.candidateIds.length);
assert.equal(ev.find(x=>x.commentId==='C002')?.deterministicHint,'likely-implemented');
assert.ok(ev.find(x=>x.commentId==='C003')?.candidateIds.length);
assert.equal(ev.find(x=>x.commentId==='C004')?.deterministicHint,'likely-implemented');
assert.ok(ev.find(x=>x.commentId==='C005')?.candidateIds.length);
assert.equal(ev.find(x=>x.commentId==='C006')?.deterministicHint,'no-evidence');

const scored=scorePagePairsForComments(comments,ev,pairs,det.textChanges);
assert.equal(scored[0].sheetId,'A-101');

console.log(JSON.stringify({
  ok:true,
  comments:comments.length,
  sheets:pairs.map(x=>x.sheetId),
  exactChanges:det.textChanges.length,
  hints:Object.fromEntries(ev.map(x=>[x.commentId,x.deterministicHint]))
},null,2));

if(process.env.COMMENT_API_URL){
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAkElEQVR4nO3aSwqAMAwAUSPe/8px0W39QNQhMm9bkA4Ruklk5tLZSl+gygCaATQDaNvRQUR8eY87pk/Wfycw1N/pMcnid05+h/YTMIBmAM0AmgE0A2gG0AygGUAzgGYAzQCaATQDaAbQDKAZQDOAZgDNAJoBNANo7QMulj2eWrp5b3mn/QTCxVeYATQDaO0DdmrWD4URKp9YAAAAAElFTkSuQmCC';
  const selected=scored.filter(x=>x.pageA!==null&&x.pageB!==null).slice(0,4).map(p=>({
    sheetId:p.sheetId,pageA:p.pageA+1,pageB:p.pageB+1,score:p.score,
    oldImage:png,newImage:png,
    oldTextDigest:oldPages[p.pageA].textRaw,
    newTextDigest:newPages[p.pageB].textRaw
  }));
  const payload={
    projectName:'Agent Hong Module 03 CI Regression',
    notes:'Use exact PDF text evidence first.',
    comments:{name:'chief-comments.pdf',items:comments},
    drawing:{
      old:{name:'before.pdf',sourcePages:oldPages.length,scannedPages:oldPages.length},
      new:{name:'after.pdf',sourcePages:newPages.length,scannedPages:newPages.length},
      pagePairs:pairs,
      selectedPairs:selected
    },
    deterministic:{textCoverage:det.textCoverage,textChanges:det.textChanges.slice(0,220),commentEvidence:ev}
  };
  const resp=await fetch(process.env.COMMENT_API_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const body=await resp.json();
  if(!resp.ok)throw new Error('production comment regression HTTP '+resp.status+': '+JSON.stringify(body));
  const map=new Map((body.result?.items||[]).map(x=>[x.commentId,x.status]));
  const expected={
    C001:'implemented',
    C002:'implemented',
    C003:'partial',
    C004:'implemented',
    C005:'implemented',
    C006:'not_found',
    C007:'uncertain'
  };
  for(const [id,status] of Object.entries(expected)){
    if(map.get(id)!==status)throw new Error('status mismatch '+id+': expected '+status+' got '+map.get(id));
  }
  if(body.result?.counts?.total!==7)throw new Error('comment count mismatch');
  console.log('Module 03 production regression passed',Object.fromEntries(map));
}
