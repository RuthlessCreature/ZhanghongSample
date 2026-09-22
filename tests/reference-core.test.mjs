import assert from 'node:assert/strict';
import {chunkReferencePages,searchReference,validateGroundedAnswer} from '../public/reference-core.js';

const chunks=chunkReferencePages([
  {pageNumber:1,lines:[
    '3.2.1 ACCESSIBLE TOILET shall provide a clear turning diameter of not less than 1500 mm.',
    '3.4.2 STAIR CLEAR WIDTH shall not be less than 1200 mm.',
    '4.1.3 DOOR AND WINDOW MARKS shown on plans shall match the DOOR WINDOW SCHEDULE.'
  ]},
  {pageNumber:2,lines:[
    '5.2.4 ROOF GARDEN waterproof membrane upturn shall be not less than 300 mm above finished surface.',
    '6.1.2 CHECK, VERIFY, TBD and HOLD notes shall be closed before IFC issue.'
  ]}
],{libraryId:'lib1',documentId:'std1',documentName:'Internal_Standard_2026.pdf',documentType:'院标',version:'2026'});

assert.equal(chunks.length,5);
let h=searchReference(chunks,'3.4.2');
assert.equal(h[0].clause,'3.4.2');
h=searchReference(chunks,'楼梯净宽 1100 是否符合院标');
assert.equal(h[0].clause,'3.4.2');
h=searchReference(chunks,'屋顶花园防水上翻多少');
assert.equal(h[0].clause,'5.2.4');
h=searchReference(chunks,'未闭环 CHECK');
assert.equal(h[0].clause,'6.1.2');

const g=validateGroundedAnswer({status:'supported',citations:['E0002','FAKE']},['E0002','E0003']);
assert.deepEqual(g.citations,['E0002']);
assert.equal(g.grounded,true);
const ng=validateGroundedAnswer({status:'supported',citations:['FAKE']},['E0002']);
assert.equal(ng.status,'not_found');
console.log('reference-core tests passed');
