
import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {buildBriefEvidence,selectBriefEvidence,summarizeBriefCoverage,groupBriefEvidence,BRIEFING_SECTIONS} from '../public/briefing-core.js';

async function makePdf(pages){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const lines of pages){
    const page=pdf.addPage([842,595]);let y=545;
    for(const line of lines){page.drawText(line,{x:40,y,size:11,font,color:rgb(0,0,0)});y-=24;}
  }
  return new Uint8Array(await pdf.save());
}
async function extractPages(bytes){
  const doc=await pdfjs.getDocument({data:bytes,disableWorker:true}).promise,out=[];
  for(let i=1;i<=doc.numPages;i++){
    const p=await doc.getPage(i),tc=await p.getTextContent(),rows=[];
    for(const item of tc.items){
      const s=String(item.str||'').trim();if(!s)continue;
      const y=Number(item.transform?.[5]||0),x=Number(item.transform?.[4]||0);
      let r=rows.find(z=>Math.abs(z.y-y)<=4);if(!r){r={y,items:[]};rows.push(r)}r.items.push({x,s});
    }
    out.push({pageNumber:i,lines:rows.sort((a,b)=>b.y-a.y).map(r=>r.items.sort((a,b)=>a.x-b.x).map(x=>x.s).join(' '))});
  }
  return out;
}

const fullBytes=await makePdf([
  ['SHEET: A-000','GENERAL NOTES','PROJECT DESIGN INTENT: office building with public lobby and conference functions.','CHECK final wall finish selection with client.'],
  ['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 101: LOBBY','ROOM 102: CONFERENCE ROOM','STAIR CLR 1350 mm','WINDOW W03','DOOR D05','COORDINATE MEP SHAFT S-01 WITH STRUCTURAL OPENING.'],
  ['SHEET: A-201','SOUTH ELEVATION','WINDOW W03','CURTAIN WALL CW-01','REFER TO A-601 DOOR WINDOW SCHEDULE.'],
  ['SHEET: A-301','BUILDING SECTION A-A','FFL +0.000 m','ROOF LEVEL +4.200 m','VERIFY FIRESTOP DETAIL AT SHAFT S-01.'],
  ['SHEET: A-601','DOOR WINDOW SCHEDULE','W03 WINDOW 1500 mm x 1200 mm','D05 DOOR 900 mm x 2100 mm'],
  ['SHEET: A-701','MATERIAL AND FINISH NOTES','LOBBY FLOOR FINISH ST-01','TOILET FLOOR WATERPROOF MEMBRANE','FIRESTOP DETAIL SHALL BE COORDINATED WITH MEP.']
]);
const reqBytes=await makePdf([[
  'PROJECT REQUIREMENT',
  'ROOM 102 shall remain a CONFERENCE ROOM.',
  'CLIENT REQUIREMENT: lobby floor finish shall use ST-01.',
  'COORDINATE MEP shaft S-01 before IFC issue.'
]]);
const limitedBytes=await makePdf([[
  'SHEET: A-101',
  'LEVEL 1 FLOOR PLAN',
  'ROOM 101: LOBBY'
]]);

const fullDocs=[
  {documentId:'draw',documentName:'Full_Drawings.pdf',sourceType:'drawing',pages:await extractPages(fullBytes)},
  {documentId:'req',documentName:'Project_Requirements.pdf',sourceType:'requirement',pages:await extractPages(reqBytes)}
];
const limitedDocs=[{documentId:'draw',documentName:'Limited_Drawings.pdf',sourceType:'drawing',pages:await extractPages(limitedBytes)}];

const fullEv=buildBriefEvidence(fullDocs),fg=groupBriefEvidence(fullEv),fc=summarizeBriefCoverage(fullEv);
assert.ok(fg.scope.length>=6);
assert.ok(fg.rooms_functions.some(x=>/ROOM 102/.test(x.text)));
assert.ok(fg.dimensions_levels.some(x=>/1350/.test(x.text)));
assert.ok(fg.doors_windows_facade.some(x=>/W03/.test(x.text)));
assert.ok(fg.coordination_interfaces.some(x=>/S-01/.test(x.text)));
assert.ok(fg.open_items.some(x=>/CHECK/.test(x.text)));
assert.ok(fg.open_items.some(x=>/VERIFY/.test(x.text)));
assert.ok(fg.materials_details.some(x=>/ST-01|WATERPROOF|FIRESTOP/.test(x.text)));
assert.ok(fc.covered>=8);

const limitedEv=buildBriefEvidence(limitedDocs),lc=summarizeBriefCoverage(limitedEv);
assert.ok(lc.found.scope>0);
assert.ok(lc.found.rooms_functions>0);
assert.equal(lc.found.open_items,0);
assert.equal(lc.found.materials_details,0);

console.log(JSON.stringify({
  ok:true,fullEvidence:fullEv.length,fullCoverage:fc.covered,
  limitedEvidence:limitedEv.length,limitedMissing:lc.missing
},null,2));

if(process.env.BRIEFING_API_URL){
  async function run(name,docs,evidence,coverage){
    const candidates=selectBriefEvidence(evidence,42);
    const r=await fetch(process.env.BRIEFING_API_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      projectName:'Agent Hong Module 07 Regression',audience:'施工单位 / 项目部',notes:'Evidence only.',
      documents:docs.map(d=>({documentId:d.documentId,name:d.documentName,sourceType:d.sourceType,sourcePages:d.pages.length,scannedPages:d.pages.length})),
      coverage,candidates
    })});
    const b=await r.json();if(!r.ok)throw new Error('briefing regression '+r.status+': '+JSON.stringify(b));
    return {b,candidates};
  }

  const full=await run('full',fullDocs,fullEv,fc);
  const sections=full.b.result.sections||[];
  if(sections.length!==BRIEFING_SECTIONS.length)throw new Error('section count mismatch '+sections.length);
  for(const s of sections){
    for(const item of s.items||[]){
      if(!item.citations?.length)throw new Error('ungrounded item '+s.key);
      for(const id of item.citations){
        const e=full.candidates.find(x=>x.id===id);
        if(!e)throw new Error('unknown citation '+id);
        if(e.category!==s.key)throw new Error('wrong-category citation '+s.key+' <- '+e.category);
      }
    }
  }
  const openCandidates=full.candidates.filter(x=>x.category==='open_items');
  if(openCandidates.length<2)throw new Error('fixture missing open candidates');
  const citedOpen=new Set((full.b.result.openItems||[]).flatMap(x=>x.citations||[]));
  for(const e of openCandidates)if(!citedOpen.has(e.id))throw new Error('open item dropped '+e.id);
  const roomSec=sections.find(x=>x.key==='rooms_functions');
  if(!roomSec?.items?.some(x=>x.citations.some(id=>/ROOM 102/.test(full.candidates.find(e=>e.id===id)?.text||''))))throw new Error('ROOM 102 briefing evidence missing');
  const coord=sections.find(x=>x.key==='coordination_interfaces');
  if(!coord?.items?.some(x=>x.citations.some(id=>/S-01/.test(full.candidates.find(e=>e.id===id)?.text||''))))throw new Error('S-01 coordination evidence missing');

  const limited=await run('limited',limitedDocs,limitedEv,lc);
  const lm=new Map((limited.b.result.sections||[]).map(x=>[x.key,x]));
  for(const k of ['materials_details','open_items']){
    if(lm.get(k)?.status!=='not_found')throw new Error('limited '+k+' must be not_found: '+JSON.stringify(lm.get(k)));
  }

  console.log('Module 07 production briefing regression passed',{
    fullCounts:full.b.result.counts,limitedCounts:limited.b.result.counts,
    fullUsage:full.b.usage,limitedUsage:limited.b.usage,
    fullRepair:full.b.structuredRepair,limitedRepair:limited.b.structuredRepair
  });
}
