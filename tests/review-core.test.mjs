import assert from 'node:assert/strict';
import {deterministicReview,rankReviewPages,classifySheet} from '../public/review-core.js';

const pages=[
 {pageNumber:1,sheetId:'A-000',textRaw:'DRAWING INDEX A-000 A-101 A-201 A-301 A-501 A-601 A-502',textItemCount:20},
 {pageNumber:2,sheetId:'A-101',textRaw:'LEVEL 1 FLOOR PLAN A-101 W01 W02 W03 W04 D01 D02 D03 D04 D05 ROOM 102: MEETING ROOM STAIR DETAIL A-502 CHECK D05 VERIFY W03',textItemCount:40},
 {pageNumber:3,sheetId:'A-201',textRaw:'SOUTH ELEVATION A-201 W01 W02 W04 D01 TBD CONFIRM W03',textItemCount:20},
 {pageNumber:4,sheetId:'A-301',textRaw:'BUILDING SECTION A-A A-301 VERIFY DETAIL A-503 HOLD FIRESTOP',textItemCount:20},
 {pageNumber:5,sheetId:'A-501',textRaw:'TOILET DETAIL A-501 ROOM 102: STORAGE PENDING FLOOR FINISH',textItemCount:20},
 {pageNumber:6,sheetId:'A-601',textRaw:'DOOR WINDOW SCHEDULE A-601 D01 D02 D03 D04 D09 W01 W02 W04 VERIFY W03',textItemCount:30},
 {pageNumber:7,sheetId:'A-701',textRaw:'GENERAL NOTES A-701 ALL CHECK / VERIFY / TBD / HOLD NOTES SHALL BE CLOSED BEFORE IFC ISSUE. ROOM 102 SHALL BE MEETING ROOM.',textItemCount:25}
];

assert.equal(classifySheet(pages[0].textRaw),'index');
assert.equal(classifySheet(pages[1].textRaw),'plan');

const r=deterministicReview(pages,7);
assert.equal(r.textCoverage.mode,'hybrid');
assert.ok(r.alerts.some(x=>x.category==='图纸目录'&&x.issue.includes('不存在')&&x.evidence.includes('A-502')));
assert.ok(r.alerts.some(x=>x.category==='图纸目录'&&x.issue.includes('未列入')&&x.evidence.includes('A-701')));
assert.ok(r.alerts.some(x=>x.category==='门窗一致性'&&x.issue.includes('W03')&&x.severity==='high'));
assert.ok(r.alerts.some(x=>x.category==='门窗一致性'&&x.issue.includes('D05')&&x.severity==='high'));
assert.ok(r.alerts.some(x=>x.category==='门窗一致性'&&x.issue.includes('D09')&&x.severity==='medium'));
assert.ok(r.alerts.some(x=>x.category==='房间编号/名称'&&x.issue.includes('ROOM 102')));
assert.ok(r.alerts.some(x=>x.category==='图纸引用'&&x.evidence.includes('A-503')));
assert.ok(r.alerts.some(x=>x.category==='未闭环标记'&&x.location==='A-201'));
assert.ok(!r.alerts.some(x=>x.category==='未闭环标记'&&x.location==='A-701'&&/ALL CHECK/.test(x.evidence)));

const ranked=rankReviewPages(pages,r,4);
assert.equal(ranked.length,4);
assert.ok(ranked.some(x=>x.sheetId==='A-101'));
assert.ok(ranked.some(x=>x.sheetId==='A-601'));

const clean=[
 {pageNumber:1,sheetId:'A-000',textRaw:'DRAWING INDEX A-000 A-101 A-201 A-301 A-501 A-601 A-701',textItemCount:20},
 {pageNumber:2,sheetId:'A-101',textRaw:'LEVEL 1 FLOOR PLAN A-101 W01 W02 W03 W04 D01 D02 D03 D04 D05 ROOM 102: MEETING ROOM A-501 A-201',textItemCount:40},
 {pageNumber:3,sheetId:'A-201',textRaw:'SOUTH ELEVATION A-201 W01 W02 W03 W04 D01',textItemCount:20},
 {pageNumber:4,sheetId:'A-301',textRaw:'BUILDING SECTION A-A A-301 A-501 FIRESTOP DETAIL COORDINATED',textItemCount:20},
 {pageNumber:5,sheetId:'A-501',textRaw:'TOILET DETAIL A-501 ROOM 103: TOILET FLOOR FINISH FL-01',textItemCount:20},
 {pageNumber:6,sheetId:'A-601',textRaw:'DOOR WINDOW SCHEDULE A-601 D01 D02 D03 D04 D05 W01 W02 W03 W04',textItemCount:30},
 {pageNumber:7,sheetId:'A-701',textRaw:'GENERAL NOTES A-701 ALL CHECK / VERIFY / TBD / HOLD NOTES SHALL BE CLOSED BEFORE IFC ISSUE. ROOM 102 SHALL BE MEETING ROOM.',textItemCount:25}
];
const cr=deterministicReview(clean,7);
assert.equal(cr.alerts.filter(x=>x.severity==='high').length,0);
assert.ok(!cr.alerts.some(x=>x.category==='未闭环标记'));

console.log('review-core v2 tests passed');
