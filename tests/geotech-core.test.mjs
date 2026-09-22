import assert from 'node:assert/strict';
import {buildGeotechEvidence,groupGeotechEvidence,summarizeGeotechCoverage,normalizeConditionSet} from '../public/geotech-core.js';

const pages=[
 {pageNumber:2,lines:[
  'SITE CLASS is II. Design basic ground acceleration is 0.10g.',
  'GROUNDWATER stable level is 2.3-3.1 m below ground surface.',
  'Layer 2 silty clay characteristic bearing capacity fak = 180 kPa.'
 ]},
 {pageNumber:3,lines:[
  'Pile foundation: recommended pile tip bearing stratum is moderately weathered sandstone.',
  'Liquefaction assessment: the site is non-liquefiable.',
  'Groundwater has weak corrosivity to reinforced concrete structures.'
 ]},
 {pageNumber:4,lines:[
  'Foundation pit excavation depth is about 5.5 m; provide temporary support and dewatering.',
  'Borehole BH-03 final depth 30.0 m.'
 ]}
];
const ev=buildGeotechEvidence(pages,{documentName:'report.pdf'});
const g=groupGeotechEvidence(ev);
assert.ok(g.groundwater.length);
assert.ok(g.bearing_capacity.some(x=>x.numbers.some(n=>n.value===180&&n.unit==='KPA')));
assert.ok(g.pile_conditions.length);
assert.ok(g.liquefaction.length);
assert.ok(g.corrosion.length);
assert.ok(g.excavation.length);
assert.ok(g.dewatering.length);
assert.ok(g.exploration.length);
const cov=summarizeGeotechCoverage(ev);
assert.ok(cov.covered>=8);
const one=g.groundwater[0];
const cs=normalizeConditionSet({conditions:[{key:'groundwater',status:'found',value:'2.3-3.1m',designImplication:'review waterproofing',citations:[one.id,'FAKE'],confidence:.9}]},[one]);
const water=cs.find(x=>x.key==='groundwater');
assert.deepEqual(water.citations,[one.id]);
assert.equal(cs.find(x=>x.key==='seismic').status,'not_found');
console.log('geotech-core tests passed');
