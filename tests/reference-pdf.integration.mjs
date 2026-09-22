import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {chunkReferencePages,searchReference} from '../public/reference-core.js';

async function makePdf(pages){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const lines of pages){
    const page=pdf.addPage([595,842]);let y=790;
    for(const line of lines){page.drawText(line,{x:42,y,size:10.5,font,color:rgb(0,0,0)});y-=25;}
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

const stdBytes=await makePdf([
  [
    'AGENT HONG SYNTHETIC INTERNAL ARCHITECTURAL STANDARD 2026',
    '3.2.1 ACCESSIBLE TOILET shall provide a clear turning diameter of not less than 1500 mm.',
    '3.4.2 STAIR CLEAR WIDTH shall not be less than 1200 mm.',
    '4.1.3 DOOR AND WINDOW MARKS shown on plans shall match the DOOR WINDOW SCHEDULE.'
  ],
  [
    '5.2.4 ROOF GARDEN waterproof membrane upturn shall be not less than 300 mm above finished surface.',
    '6.1.2 CHECK, VERIFY, TBD and HOLD notes shall be closed before IFC issue.'
  ]
]);
const briefBytes=await makePdf([[
  'AGENT HONG SYNTHETIC CLIENT DESIGN BRIEF',
  '2.1.1 ROOM 205 shall be used as SERVER ROOM.',
  '2.1.2 SERVER ROOM clear area shall be not less than 12 square meters.',
  '2.2.1 Project stair clear width target is 1300 mm.'
]]);

const std=chunkReferencePages(await extractPages(stdBytes),{libraryId:'test',documentId:'std2026',documentName:'Synthetic_Internal_Standard_2026.pdf',documentType:'院标',version:'2026'});
const brief=chunkReferencePages(await extractPages(briefBytes),{libraryId:'test',documentId:'client',documentName:'Synthetic_Client_Brief.pdf',documentType:'甲方要求',version:'R1'});
const chunks=[...std,...brief];

assert.equal(searchReference(chunks,'3.4.2')[0].clause,'3.4.2');
assert.equal(searchReference(chunks,'楼梯净宽')[0].clause,'3.4.2');
assert.equal(searchReference(chunks,'屋顶花园防水上翻')[0].clause,'5.2.4');
assert.equal(searchReference(chunks,'ROOM 205 server room')[0].clause,'2.1.1');
assert.equal(searchReference(chunks,'未闭环 CHECK VERIFY')[0].clause,'6.1.2');
assert.equal(searchReference(chunks,'MRI shielding bunker').length,0);

console.log(JSON.stringify({ok:true,chunks:chunks.length,localQueriesPassed:6},null,2));

if(process.env.REFERENCE_API_URL){
  async function ask(mode,query,cands){
    const candidates=cands.slice(0,12).map(x=>({id:x.id,documentName:x.documentName,documentType:x.documentType,version:x.version,pageNumber:x.pageNumber,clause:x.clause,text:x.text,score:x.score||0}));
    const r=await fetch(process.env.REFERENCE_API_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode,query,candidates})});
    const b=await r.json();if(!r.ok)throw new Error('reference regression '+r.status+': '+JSON.stringify(b));return b;
  }

  const stairHits=searchReference(chunks,'楼梯净宽只有1100，我们院标怎么要求',{},6);
  const stair=await ask('issue','A stair clear width is 1100 mm. Based only on uploaded evidence, what does the internal standard require?',stairHits);
  if(!stair.answer?.grounded||!stair.answer.citations?.some(id=>stairHits.find(x=>x.id===id)?.clause==='3.4.2'))throw new Error('stair citation missing: '+JSON.stringify(stair.answer));

  const roofHits=searchReference(chunks,'屋顶花园防水上翻多少',{},6);
  const roof=await ask('clause','What does the uploaded evidence require for roof garden waterproof membrane upturn?',roofHits);
  if(!roof.answer?.grounded||!roof.answer.citations?.some(id=>roofHits.find(x=>x.id===id)?.clause==='5.2.4'))throw new Error('roof citation missing: '+JSON.stringify(roof.answer));

  const unrelated=chunks.filter(x=>['3.2.1','3.4.2','4.1.3'].includes(x.clause)).slice(0,3);
  const no=await ask('issue','What is the MRI shielding thickness requirement?',unrelated);
  if(no.answer?.status!=='not_found'||no.answer?.citations?.length)throw new Error('negative grounding failed: '+JSON.stringify(no.answer));

  console.log('Module 05 production grounding passed',{
    stair:stair.answer,roof:roof.answer,negative:no.answer,
    usage:[stair.usage,roof.usage,no.usage]
  });
}
