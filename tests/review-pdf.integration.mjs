import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {detectSheetId} from '../public/diff-core.js';
import {deterministicReview} from '../public/review-core.js';

const BAD=[
'DRAWING INDEX SHEET A-000 A-000 DRAWING INDEX A-101 LEVEL 1 FLOOR PLAN A-201 SOUTH ELEVATION A-301 BUILDING SECTION A-A A-501 TOILET DETAIL A-601 DOOR & WINDOW SCHEDULE A-502 STAIR DETAIL',
'LEVEL 1 FLOOR PLAN SHEET A-101 W01 W02 W03 W04 D01 D02 D03 D04 D05 ROOM 101: OPEN OFFICE ROOM 102: MEETING ROOM ROOM 100: LOBBY ROOM 103: TOILET STAIR CLR 1350 TOILET DETAIL A-501 STAIR DETAIL A-502 SOUTH ELEVATION A-201 CHECK D05 WITH DOOR SCHEDULE VERIFY W03 IN ELEVATION',
'SOUTH ELEVATION SHEET A-201 W04 W02 W01 D01 TBD: CONFIRM W03 ON SOUTH ELEVATION',
'BUILDING SECTION A-A SHEET A-301 ROOF +4.200 FFL +0.000 VERIFY PARAPET BUILD-UP WITH DETAIL A-503 HOLD: FIRESTOP DETAIL TO BE CONFIRMED',
'TOILET DETAIL SHEET A-501 ROOM 102: STORAGE PENDING: FLOOR FINISH CODE',
'DOOR & WINDOW SCHEDULE SHEET A-601 D01 DOOR D02 DOOR D03 DOOR D04 DOOR D09 DOOR W01 WINDOW W02 WINDOW W04 WINDOW VERIFY: W03 AND D05 BEFORE IFC ISSUE',
'GENERAL NOTES SHEET A-701 ALL CHECK / VERIFY / TBD / HOLD NOTES SHALL BE CLOSED BEFORE IFC ISSUE. ROOM 102 SHALL BE MEETING ROOM. CHECK: CLIENT TO CONFIRM WALL FINISH.'
];

const CLEAN=[
'DRAWING INDEX SHEET A-000 A-000 DRAWING INDEX A-101 LEVEL 1 FLOOR PLAN A-201 SOUTH ELEVATION A-301 BUILDING SECTION A-A A-501 TOILET DETAIL A-601 DOOR & WINDOW SCHEDULE A-701 GENERAL NOTES',
'LEVEL 1 FLOOR PLAN SHEET A-101 W01 W02 W03 W04 D01 D02 D03 D04 D05 ROOM 101: OPEN OFFICE ROOM 102: MEETING ROOM ROOM 100: LOBBY ROOM 103: TOILET STAIR CLR 1350 TOILET DETAIL A-501 SOUTH ELEVATION A-201 ALL DOORS WINDOWS COORDINATED',
'SOUTH ELEVATION SHEET A-201 W04 W02 W03 W01 D01 W03 COORDINATED WITH A-101 A-601',
'BUILDING SECTION A-A SHEET A-301 ROOF +4.200 FFL +0.000 PARAPET BUILD-UP PER A-501 FIRESTOP DETAIL COORDINATED',
'TOILET DETAIL SHEET A-501 ROOM 103: TOILET FLOOR FINISH: FL-01',
'DOOR & WINDOW SCHEDULE SHEET A-601 D01 DOOR D02 DOOR D03 DOOR D04 DOOR D05 DOOR W01 WINDOW W02 WINDOW W03 WINDOW W04 WINDOW SCHEDULE COORDINATED WITH A-101',
'GENERAL NOTES SHEET A-701 ALL CHECK / VERIFY / TBD / HOLD NOTES SHALL BE CLOSED BEFORE IFC ISSUE. ROOM 102 SHALL BE MEETING ROOM. WALL FINISH CONFIRMED: WF-01.'
];

async function buildPdf(texts){
  const pdf=await PDFDocument.create();
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const text of texts){
    const page=pdf.addPage([1190,842]);
    const words=text.split(/\s+/);
    let line='',y=800;
    for(const word of words){
      if((line+' '+word).length>115){
        page.drawText(line.trim(),{x:35,y,size:8,font});y-=13;line='';
      }
      line+=' '+word;
    }
    if(line.trim())page.drawText(line.trim(),{x:35,y,size:8,font});
  }
  return new Uint8Array(await pdf.save());
}

async function extract(bytes){
  const doc=await pdfjsLib.getDocument({data:bytes,disableFontFace:true}).promise;
  const pages=[];
  for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i);
    const tc=await page.getTextContent();
    const parts=tc.items.map(x=>String(x.str||'').trim()).filter(Boolean);
    const textRaw=parts.join(' ');
    pages.push({pageNumber:i,sheetId:detectSheetId(textRaw),textRaw,textItemCount:parts.length});
  }
  return pages;
}

const badPages=await extract(await buildPdf(BAD));
assert.equal(badPages.length,7);
assert.deepEqual(badPages.map(x=>x.sheetId),['A-000','A-101','A-201','A-301','A-501','A-601','A-701']);

const bad=deterministicReview(badPages,7);
const has=(cat,s)=>bad.alerts.some(x=>x.category===cat&&(x.issue+x.evidence).includes(s));
assert.ok(has('图纸目录','A-502'));
assert.ok(has('图纸目录','A-701'));
assert.ok(has('门窗一致性','W03'));
assert.ok(has('门窗一致性','D05'));
assert.ok(has('门窗一致性','D09'));
assert.ok(has('房间编号/名称','ROOM 102'));
assert.ok(has('图纸引用','A-503'));
for(const sheet of ['A-101','A-201','A-301','A-501','A-601','A-701']){
  assert.ok(bad.alerts.some(x=>x.category==='未闭环标记'&&x.location===sheet),'missing unresolved marker on '+sheet);
}

const cleanPages=await extract(await buildPdf(CLEAN));
const clean=deterministicReview(cleanPages,7);
assert.equal(clean.alerts.filter(x=>x.severity==='high').length,0);
assert.equal(clean.alerts.filter(x=>x.category==='未闭环标记').length,0);
assert.equal(clean.alerts.filter(x=>x.category==='图纸目录').length,0);

console.log(JSON.stringify({
  bad:{alerts:bad.alerts.length,high:bad.alerts.filter(x=>x.severity==='high').length,categories:[...new Set(bad.alerts.map(x=>x.category))]},
  clean:{alerts:clean.alerts.length,high:0}
},null,2));
console.log('review PDF integration passed');
