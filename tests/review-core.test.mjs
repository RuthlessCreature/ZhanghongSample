import assert from 'node:assert/strict';
import {deterministicReview} from '../public/review-core.js';

const pages=[
 {sheetId:'A-101',textRaw:'LEVEL 1 FLOOR PLAN A-101 W01 W02 W03 D01 D02 CHECK W03 WITH ELEVATION',textItemCount:20},
 {sheetId:'A-201',textRaw:'SOUTH ELEVATION A-201 W01 W02 D01',textItemCount:12},
 {sheetId:'A-601',textRaw:'DOOR WINDOW SCHEDULE A-601 W01 W02 D01 D02 VERIFY FINAL WINDOW SCHEDULE',textItemCount:30}
];
const r=deterministicReview(pages,3);
assert.equal(r.textCoverage.mode,'hybrid');
assert.ok(r.alerts.some(x=>x.issue.includes('W03')&&x.category==='门窗一致性'));
assert.ok(r.alerts.some(x=>x.category==='未闭环标记'));
assert.ok(!r.alerts.some(x=>x.issue.includes('D02')&&x.category==='门窗一致性'));

const dup=deterministicReview([
 {sheetId:'A-101',textRaw:'PLAN A-101',textItemCount:5},
 {sheetId:'A-101',textRaw:'PLAN A-101',textItemCount:5}
],2);
assert.ok(dup.alerts.some(x=>x.category==='图号'&&x.severity==='high'));

console.log('review-core tests passed');
