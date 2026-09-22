import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {buildGeotechEvidence,selectGeotechEvidence,summarizeGeotechCoverage,groupGeotechEvidence} from '../public/geotech-core.js';

async function makePdf(pages){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const lines of pages){
    const page=pdf.addPage([595,842]);let y=790;
    for(const line of lines){page.drawText(line,{x:40,y,size:10,font,color:rgb(0,0,0)});y-=24;}
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
const fullPages=[
  [
    'SYNTHETIC GEOTECHNICAL REPORT - DESIGN PARAMETERS',
    'SITE CLASS is II.',
    'SEISMIC design basic ground acceleration is 0.10g.',
    'GROUNDWATER stable water table is 2.3-3.1 m below ground surface.',
    'Anti-float design water level is 1.2 m below ground surface.'
  ],
  [
    'SOIL LAYER 1 miscellaneous fill thickness 0.0-1.2 m.',
    'SOIL LAYER 2 silty clay depth 1.2-8.5 m.',
    'Layer 2 silty clay characteristic BEARING CAPACITY fak = 180 kPa.',
    'Layer 3 medium sand characteristic BEARING CAPACITY fak = 220 kPa.',
    'PILE foundation recommendation: bored piles may be considered.',
    'Recommended PILE TIP BEARING STRATUM is moderately weathered sandstone.'
  ],
  [
    'LIQUEFACTION assessment: the site is non-liquefiable.',
    'GROUNDWATER has weak CORROSIVITY to reinforced concrete structures.',
    'ADVERSE GEOLOGY assessment: no karst, landslide or fault was identified within the investigated area.',
    'FOUNDATION PIT EXCAVATION depth is about 5.5 m; temporary support shall be designed.',
    'DEWATERING is recommended when excavation proceeds below the groundwater level.'
  ],
  [
    'BOREHOLE BH-01 final depth 28.0 m.',
    'BOREHOLE BH-02 final depth 30.0 m.',
    'BOREHOLE BH-03 final depth 32.0 m.'
  ]
];
const incompletePages=[
  [
    'SYNTHETIC GEOTECHNICAL REPORT - LIMITED DATA',
    'GROUNDWATER stable water table is 3.0-3.8 m below ground surface.'
  ],
  [
    'SOIL LAYER silty clay characteristic BEARING CAPACITY fak = 160 kPa.',
    'LIQUEFACTION assessment: non-liquefiable.',
    'GROUNDWATER has slight CORROSIVITY to concrete.'
  ],
  [
    'FOUNDATION PIT EXCAVATION depth is about 4.0 m.',
    'BOREHOLE BH-01 final depth 20.0 m.'
  ]
];

const fullBytes=await makePdf(fullPages),incompleteBytes=await makePdf(incompletePages);
const fullEv=buildGeotechEvidence(await extractPages(fullBytes),{documentId:'full',documentName:'Synthetic_Full_Geotech.pdf'});
const incompleteEv=buildGeotechEvidence(await extractPages(incompleteBytes),{documentId:'limited',documentName:'Synthetic_Limited_Geotech.pdf'});
const fg=groupGeotechEvidence(fullEv),fc=summarizeGeotechCoverage(fullEv),ic=summarizeGeotechCoverage(incompleteEv);

assert.ok(fg.site_class.length);
assert.ok(fg.seismic.length);
assert.ok(fg.groundwater.length);
assert.ok(fg.soil_layers.length);
assert.ok(fg.bearing_capacity.some(x=>x.numbers.some(n=>n.value===180&&n.unit==='KPA')));
assert.ok(fg.pile_conditions.length);
assert.ok(fg.liquefaction.length);
assert.ok(fg.corrosion.length);
assert.ok(fg.adverse_geology.length);
assert.ok(fg.excavation.length);
assert.ok(fg.dewatering.length);
assert.ok(fg.exploration.length);
assert.equal(fc.covered,12);
assert.ok(ic.missing.includes('seismic'));
assert.ok(ic.missing.includes('pile_conditions'));
console.log(JSON.stringify({ok:true,fullEvidence:fullEv.length,fullCovered:fc.covered,incompleteMissing:ic.missing},null,2));

if(process.env.GEOTECH_API_URL){
  async function run(name,evidence,coverage,sourcePages){
    const candidates=selectGeotechEvidence(evidence,36);
    const r=await fetch(process.env.GEOTECH_API_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      projectName:'Agent Hong Module 06 Regression',notes:'Use exact report evidence only.',
      documents:[{documentId:name,name:name+'.pdf',sourcePages,scannedPages:sourcePages}],coverage,candidates
    })});
    const b=await r.json();if(!r.ok)throw new Error('geotech regression '+r.status+': '+JSON.stringify(b));return {b,candidates};
  }
  const full=await run('full',fullEv,fc,4);
  const map=new Map(full.b.result.conditions.map(x=>[x.key,x]));
  for(const k of ['groundwater','bearing_capacity','pile_conditions','liquefaction','corrosion']){
    const x=map.get(k);if(!x||x.status==='not_found'||!x.citations?.length)throw new Error('full missing grounded '+k+': '+JSON.stringify(x));
  }
  const bearing=map.get('bearing_capacity');
  if(!bearing.citations.some(id=>full.candidates.find(x=>x.id===id)?.text.includes('180 kPa')))throw new Error('bearing 180kPa evidence missing: '+JSON.stringify(bearing));
  const pile=map.get('pile_conditions');
  if(!pile.citations.some(id=>/moderately weathered sandstone/i.test(full.candidates.find(x=>x.id===id)?.text||'')))throw new Error('pile bearing stratum evidence missing: '+JSON.stringify(pile));

  const limited=await run('limited',incompleteEv,ic,3);
  const lm=new Map(limited.b.result.conditions.map(x=>[x.key,x]));
  if(lm.get('seismic')?.status!=='not_found')throw new Error('limited seismic must be not_found: '+JSON.stringify(lm.get('seismic')));
  if(lm.get('pile_conditions')?.status!=='not_found')throw new Error('limited pile must be not_found: '+JSON.stringify(lm.get('pile_conditions')));
  console.log('Module 06 production geotech regression passed',{
    fullCounts:full.b.result.counts,limitedCounts:limited.b.result.counts,
    fullUsage:full.b.usage,limitedUsage:limited.b.usage
  });
}
