import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {buildHistoryRecord,searchHistory,summarizeLibrary} from '../public/history-core.js';

async function makePdf(pages){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const lines of pages){
    const page=pdf.addPage([842,595]);let y=545;
    for(const line of lines){page.drawText(line,{x:42,y,size:12,font,color:rgb(0,0,0)});y-=24;}
  }
  return new Uint8Array(await pdf.save());
}
async function scan(bytes,meta){
  const doc=await pdfjs.getDocument({data:bytes,disableWorker:true}).promise,out=[];
  for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i),tc=await page.getTextContent();
    const text=tc.items.map(x=>String(x.str||'').trim()).filter(Boolean).join(' | ');
    out.push(buildHistoryRecord({...meta,id:meta.projectId+'|'+meta.fileName+'|'+i,pageNumber:i,text,thumbnail:null,importedAt:1700000000000+i}));
  }
  return out;
}

const projects=[
  {
    projectId:'p-office',projectName:'2024 Yibin Riverside Office',projectYear:2024,fileName:'Yibin_Office_Architecture.pdf',
    pages:[
      ['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 205: SERVER ROOM','WINDOWS W01 W03','OFFICE LOBBY'],
      ['SHEET: A-501','ROOF GARDEN DETAIL','ROOF GARDEN DETAIL WATERPROOF MEMBRANE','PARAPET','DRAINAGE'],
      ['SHEET: A-601','DOOR WINDOW SCHEDULE','W03 WINDOW 1500 1200']
    ]
  },
  {
    projectId:'p-hotel',projectName:'2022 Chengdu Boutique Hotel',projectYear:2022,fileName:'Hotel_Architecture.pdf',
    pages:[
      ['SHEET: A-111','TYPICAL GUESTROOM PLAN','ROOM 305: GUEST ROOM'],
      ['SHEET: A-521','ACCESSIBLE TOILET DETAIL','ACCESSIBLE TOILET DETAIL','GRAB BAR','TURNING RADIUS 1500']
    ]
  },
  {
    projectId:'p-lab',projectName:'2023 Shenzhen R&D Center',projectYear:2023,fileName:'RND_Architecture.pdf',
    pages:[
      ['SHEET: A-102','LEVEL 2 FLOOR PLAN','ROOM 205: LAB SUPPORT','EQUIPMENT ROOM'],
      ['SHEET: A-541','CURTAIN WALL DETAIL','CURTAIN WALL DETAIL','ALUMINIUM MULLION']
    ]
  },
  {
    projectId:'p-retail',projectName:'2021 Chongqing Retail Center',projectYear:2021,fileName:'Retail_Architecture.pdf',
    pages:[
      ['SHEET: A-201','SOUTH ELEVATION','CURTAIN WALL','SIGNAGE ZONE'],
      ['SHEET: A-531','STAIR DETAIL','STAIR DETAIL','RAILING','TREAD 300 RISER 150']
    ]
  }
];

let records=[];
for(const p of projects){
  const bytes=await makePdf(p.pages);
  records.push(...await scan(bytes,p));
}
assert.equal(records.length,9);
assert.equal(summarizeLibrary(records).projects,4);

let hits=searchHistory(records,'A-501');
assert.equal(hits[0].sheetId,'A-501');

hits=searchHistory(records,'W03');
assert.ok(hits[0].marks.includes('W03'));

hits=searchHistory(records,'ROOM 205 SERVER ROOM');
assert.equal(hits[0].projectId,'p-office');

hits=searchHistory(records,'找以前做过的屋顶花园防水节点');
assert.equal(hits[0].sheetId,'A-501');

hits=searchHistory(records,'accessible toilet detail');
assert.equal(hits[0].sheetId,'A-521');

hits=searchHistory(records,'无障碍卫生间节点');
assert.equal(hits[0].sheetId,'A-521');

hits=searchHistory(records,'2021 楼梯节点');
assert.equal(hits[0].projectId,'p-retail');

hits=searchHistory(records,'MRI SHIELDING BUNKER');
assert.equal(hits.length,0);

console.log(JSON.stringify({ok:true,records:records.length,projects:4,queriesPassed:8},null,2));

if(process.env.HISTORY_API_URL){
  const candidates=records.map(r=>({
    id:r.id,projectName:r.projectName,projectYear:r.projectYear,fileName:r.fileName,pageNumber:r.pageNumber,
    sheetId:r.sheetId,sheetTitle:r.sheetTitle,role:r.role,deterministicScore:0,text:r.text.slice(0,900)
  }));
  async function ask(query){
    const resp=await fetch(process.env.HISTORY_API_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,candidates})});
    const body=await resp.json();
    if(!resp.ok)throw new Error('history production regression '+resp.status+': '+JSON.stringify(body));
    return body;
  }
  const semantic=await ask('找以前做过的屋顶花园防水节点');
  if(semantic.ranked?.[0]?.id!=='p-office|Yibin_Office_Architecture.pdf|2')throw new Error('semantic roof garden top mismatch: '+JSON.stringify(semantic.ranked?.slice(0,3)));
  const accessible=await ask('我想找酒店以前做过的无障碍卫生间详图');
  if(accessible.ranked?.[0]?.id!=='p-hotel|Hotel_Architecture.pdf|2')throw new Error('semantic accessible toilet top mismatch: '+JSON.stringify(accessible.ranked?.slice(0,3)));
  const exact=await ask('A-501');
  if(exact.ranked?.[0]?.id!=='p-office|Yibin_Office_Architecture.pdf|2')throw new Error('exact A-501 top mismatch: '+JSON.stringify(exact.ranked?.slice(0,3)));
  console.log('Module 04 production rerank passed',{
    roofGarden:semantic.ranked[0],
    accessibleToilet:accessible.ranked[0],
    exactA501:exact.ranked[0],
    usage:[semantic.usage,accessible.usage,exact.usage]
  });
}
