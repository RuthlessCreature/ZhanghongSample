
import assert from 'node:assert/strict';
import {buildBriefEvidence,groupBriefEvidence,selectBriefEvidence,summarizeBriefCoverage,validateBriefingOutput} from '../public/briefing-core.js';

const docs=[{
  documentId:'draw',documentName:'Architecture.pdf',sourceType:'drawing',
  pages:[
    {pageNumber:1,lines:['SHEET: A-101','LEVEL 1 FLOOR PLAN','ROOM 102: CONFERENCE ROOM','STAIR CLR 1350 mm','WINDOW W03','CHECK D05 WITH DOOR WINDOW SCHEDULE']},
    {pageNumber:2,lines:['SHEET: A-201','SOUTH ELEVATION','WINDOW W03','CURTAIN WALL CW-01']},
    {pageNumber:3,lines:['SHEET: A-301','BUILDING SECTION A-A','FFL +0.000','ROOF LEVEL +4.200 m','VERIFY FIRESTOP DETAIL']}
  ]
},{
  documentId:'req',documentName:'Client_Requirements.txt',sourceType:'requirement',
  pages:[{pageNumber:1,lines:['PROJECT REQUIREMENT: ROOM 102 shall remain a conference room.','Coordinate MEP shaft S-01 with structural opening.']}]
}];

const ev=buildBriefEvidence(docs),g=groupBriefEvidence(ev),cov=summarizeBriefCoverage(ev);
assert.ok(g.scope.length>=3);
assert.ok(g.rooms_functions.some(x=>x.text.includes('ROOM 102')));
assert.ok(g.dimensions_levels.some(x=>x.text.includes('1350')));
assert.ok(g.open_items.some(x=>x.text.includes('CHECK')));
assert.ok(g.open_items.some(x=>x.text.includes('VERIFY')));
assert.ok(g.coordination_interfaces.length);
assert.ok(cov.covered>=7);
assert.ok(selectBriefEvidence(ev,20).length<=20);

const open=g.open_items[0];
const out=validateBriefingOutput({sections:[
  {key:'open_items',status:'ready',summary:'Two unresolved items',items:[
    {title:'Resolve item',message:'Check it',action:'Close before issue',priority:'high',citations:[open.id,'FAKE']}
  ]}
]},[open]);
const sec=out.find(x=>x.key==='open_items');
assert.equal(sec.items.length,1);
assert.deepEqual(sec.items[0].citations,[open.id]);
assert.equal(out.find(x=>x.key==='materials_details').status,'not_found');
console.log('briefing-core tests passed');
