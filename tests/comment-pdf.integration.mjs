import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {mergeTextItems,detectSheetId,pairPages,summarizeDeterministicDiff} from '../public/diff-core.js';
import {parseCommentLines,buildCommentEvidence,scorePagePairsForComments} from '../public/comment-core.js';

const PAGE=[842,595];
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAkElEQVR4nO3aSwqAMAwAUSPe/8px0W39QNQhMm9bkA4Ruklk5tLZSl+gygCaATQDaNvRQUR8eY87pk/Wfycw1N/pMcnid05+h/YTMIBmAM0AmgE0A2gG0AygGUAzgGYAzQCaATQDaAbQDKAZQDOAZgDNAJoBNANo7QMulj2eWrp5b3mn/QTCxVeYATQDaO0DdmrWD4URKp9YAAAAAElFTkSuQmCC';

async function makePdf(pages){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const p of pages){
    const page=pdf.addPage(PAGE); let y=550;
    for(const line of p){page.drawText(line,{x:42,y,size:12,font,color:rgb(0,0,0)});y-=26;}
  }
  return new Uint8Array(await pdf.save());
}
async function scanPdf(bytes){
  const doc=await pdfjs.getDocument({data:bytes,disableWorker:true}).promise,pages=[];
  for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i),raw=page.getViewport({scale:1}),tc=await page.getTextContent();
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
      const s=String(item.str||'').trim();if(!s)continue;
      const y=Number(item.transform?.[5]||0),x=Number(item.transform?.[4]||0);
      let row=rows.find(r=>Math.abs(r.y-y)<=4);
      if(!row){row={y,items:[]};rows.push(row);}
      row.items.push({x,s});
    }
    lines.push(...rows.sort((a,b)=>b.y-a.y).map(r=>r.items.sort((a,b)=>a.x-b.x).map(x=>x.s).join(' ')));
  }
  return lines;
}
async function buildCase(oldPdf,newPdf,comments){
  const [oldPages,newPages]=await Promise.all([scanPdf(oldPdf),scanPdf(newPdf)]);
  const pairs=pairPages(oldPages,newPages),det=summarizeDeterministicDiff(oldPages,newPages,pairs);
  const ev=buildCommentEvidence(comments,det.textChanges);
  const scored=scorePagePairsForComments(comments,ev,pairs,det.textChanges);
  return {oldPages,newPages,pairs,det,ev,scored};
}
function payloadFor(caseData,comments,name){
  const selected=caseData.scored.filter(x=>x.pageA!==null&&x.pageB!==null).slice(0,8).map(p=>({
    sheetId:p.sheetId,pageA:p.pageA+1,pageB:p.pageB+1,score:p.score,
    oldImage:PNG,newImage:PNG,
    oldTextDigest:caseData.oldPages[p.pageA].textRaw,
    newTextDigest:caseData.newPages[p.pageB].textRaw
  }));
  return {
    projectName:name,
    notes:'Use exact PDF text evidence first. Every comment must have one result.',
    comments:{name:'chief-comments.pdf',items:comments},
    drawing:{
      old:{name:'before.pdf',sourcePages:caseData.oldPages.length,scannedPages:caseData.oldPages.length},
      new:{name:'after.pdf',sourcePages:caseData.newPages.length,scannedPages:caseData.newPages.length},
      pagePairs:caseData.pairs,
      selectedPairs:selected
    },
    deterministic:{textCoverage:caseData.det.textCoverage,textChanges:caseData.det.textChanges.slice(0,220),commentEvidence:caseData.ev}
  };
}
async function callProduction(payload){
  const resp=await fetch(process.env.COMMENT_API_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const body=await resp.json();
  if(!resp.ok)throw new Error('production comment regression HTTP '+resp.status+': '+JSON.stringify(body));
  return body;
}
function assertStatuses(body,expected,label){
  const items=body.result?.items||[],map=new Map(items.map(x=>[x.commentId,x.status]));
  assert.equal(items.length,Object.keys(expected).length,label+' result count');
  for(const [id,status] of Object.entries(expected)){
    if(map.get(id)!==status)throw new Error(label+' status mismatch '+id+': expected '+status+' got '+map.get(id));
  }
  return Object.fromEntries(map);
}

const commentsPdf=await makePdf([[
  'CHIEF ENGINEER REVIEW COMMENTS',
  '1. A-101 change ROOM 102 from MEETING ROOM to CONFERENCE ROOM.',
  '2. A-101 change STAIR CLR from 1200 to 1350.',
  '3. Add W03 and coordinate A-101, A-201 and A-601.',
  '4. Delete D09 from A-601.',
  '5. A-101 change overall dimension from 23000 to 23800.',
  '6. Remove CHECK FIRESTOP note from A-301.',
  '7. Coordinate MEP shaft S-01 between A-101 and A-301 and add an explicit coordinated note.',
  '8. Coordinate shaft S-02 between A-101 and external M-101.'
]]);
const comments=parseCommentLines(await commentLines(commentsPdf));
assert.equal(comments.length,8);

const mixedOld=await makePdf([
  ['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 102: MEETING ROOM','STAIR CLR 1200','WINDOWS W01 W02','OVERALL 23000'],
  ['SHEET: A-201','SOUTH ELEVATION','WINDOWS W01 W02'],
  ['SHEET: A-301','BUILDING SECTION','CHECK FIRESTOP DETAIL'],
  ['SHEET: A-601','DOOR WINDOW SCHEDULE','W01 WINDOW','W02 WINDOW','D09 DOOR']
]);
const mixedNew=await makePdf([
  ['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 102: CONFERENCE ROOM','STAIR CLR 1350','WINDOWS W01 W02 W03','OVERALL 23800'],
  ['SHEET: A-201','SOUTH ELEVATION','WINDOWS W01 W02 W03'],
  ['SHEET: A-301','BUILDING SECTION','CHECK FIRESTOP DETAIL'],
  ['SHEET: A-601','DOOR WINDOW SCHEDULE','W01 WINDOW','W02 WINDOW']
]);
const mixed=await buildCase(mixedOld,mixedNew,comments);
assert.deepEqual(mixed.oldPages.map(x=>x.sheetId),['A-101','A-201','A-301','A-601']);
assert.deepEqual(mixed.newPages.map(x=>x.sheetId),['A-101','A-201','A-301','A-601']);
assert.ok(mixed.ev.find(x=>x.commentId==='C001')?.candidateIds.length);
assert.equal(mixed.ev.find(x=>x.commentId==='C002')?.deterministicHint,'likely-implemented');
assert.ok(mixed.ev.find(x=>x.commentId==='C003')?.candidateIds.length);
assert.equal(mixed.ev.find(x=>x.commentId==='C004')?.deterministicHint,'likely-implemented');
assert.ok(mixed.ev.find(x=>x.commentId==='C005')?.candidateIds.length);
assert.equal(mixed.ev.find(x=>x.commentId==='C006')?.deterministicHint,'no-evidence');
assert.equal(mixed.scored[0].sheetId,'A-101');

console.log(JSON.stringify({
  ok:true,
  case:'mixed',
  comments:comments.length,
  sheets:mixed.pairs.map(x=>x.sheetId),
  exactChanges:mixed.det.textChanges.length,
  hints:Object.fromEntries(mixed.ev.map(x=>[x.commentId,x.deterministicHint]))
},null,2));

const fullOld=await makePdf([
  ['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 102: MEETING ROOM','STAIR CLR 1200','WINDOWS W01 W02','OVERALL 23000','SHAFT S-01 PENDING','SHAFT S-02 PENDING'],
  ['SHEET: A-201','SOUTH ELEVATION','WINDOWS W01 W02'],
  ['SHEET: A-301','BUILDING SECTION','CHECK FIRESTOP DETAIL','SHAFT S-01 PENDING'],
  ['SHEET: A-601','DOOR WINDOW SCHEDULE','W01 WINDOW','W02 WINDOW','D09 DOOR'],
  ['SHEET: M-101','MECHANICAL PLAN','SHAFT S-02 PENDING']
]);
const fullNew=await makePdf([
  ['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 102: CONFERENCE ROOM','STAIR CLR 1350','WINDOWS W01 W02 W03','OVERALL 23800','SHAFT S-01 COORDINATED WITH A-301','SHAFT S-02 COORDINATED WITH M-101'],
  ['SHEET: A-201','SOUTH ELEVATION','WINDOWS W01 W02 W03'],
  ['SHEET: A-301','BUILDING SECTION','FIRESTOP DETAIL COORDINATED','SHAFT S-01 COORDINATED WITH A-101'],
  ['SHEET: A-601','DOOR WINDOW SCHEDULE','W01 WINDOW','W02 WINDOW','W03 WINDOW'],
  ['SHEET: M-101','MECHANICAL PLAN','SHAFT S-02 COORDINATED WITH A-101']
]);
const full=await buildCase(fullOld,fullNew,comments);
assert.ok(full.pairs.some(x=>x.sheetId==='M-101'));

if(process.env.COMMENT_API_URL){
  const mixedBody=await callProduction(payloadFor(mixed,comments,'Agent Hong Module 03 Mixed Regression'));
  const mixedMap=assertStatuses(mixedBody,{
    C001:'implemented',C002:'implemented',C003:'partial',C004:'implemented',
    C005:'implemented',C006:'not_found',C007:'not_found',C008:'uncertain'
  },'mixed');
  console.log('Module 03 mixed production regression passed',mixedMap,'usage',mixedBody.usage||{});

  const fullBody=await callProduction(payloadFor(full,comments,'Agent Hong Module 03 Full Closure Regression'));
  const fullExpected=Object.fromEntries(comments.map(x=>[x.id,'implemented']));
  const fullMap=assertStatuses(fullBody,fullExpected,'full');
  console.log('Module 03 full-closure production regression passed',fullMap,'usage',fullBody.usage||{});
}
