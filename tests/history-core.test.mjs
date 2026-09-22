import assert from 'node:assert/strict';
import {buildHistoryRecord,parseHistoryQuery,searchHistory,summarizeLibrary} from '../public/history-core.js';

const records=[
  buildHistoryRecord({id:'r1',projectId:'p1',projectName:'2024 宜宾滨江办公楼',projectYear:2024,fileName:'A建筑施工图.pdf',pageNumber:3,text:'SHEET: A-101 LEVEL 1 FLOOR PLAN ROOM 205: SERVER ROOM WINDOWS W01 W03'}),
  buildHistoryRecord({id:'r2',projectId:'p1',projectName:'2024 宜宾滨江办公楼',projectYear:2024,fileName:'A建筑施工图.pdf',pageNumber:8,text:'SHEET: A-501 ROOF GARDEN DETAIL 屋顶花园节点 防水构造 女儿墙'}),
  buildHistoryRecord({id:'r3',projectId:'p2',projectName:'2021 成都商业中心',projectYear:2021,fileName:'arch.pdf',pageNumber:5,text:'SHEET: A-201 SOUTH ELEVATION WINDOWS W01 W02'}),
  buildHistoryRecord({id:'r4',projectId:'p3',projectName:'2023 深圳研发中心',projectYear:2023,fileName:'arch.pdf',pageNumber:11,text:'SHEET: A-601 DOOR WINDOW SCHEDULE W03 WINDOW 1500 1200'})
];

const q=parseHistoryQuery('找 2024 项目 A-501 屋顶花园节点');
assert.ok(q.sheetRefs.includes('A-501'));
assert.ok(q.years.includes(2024));
assert.ok(q.roleHints.includes('detail'));
const s=searchHistory(records,'找 2024 项目 A-501 屋顶花园节点');
assert.equal(s[0].id,'r2');

const w=searchHistory(records,'W03');
assert.ok(['r1','r4'].includes(w[0].id));
assert.ok(w.some(x=>x.id==='r1')&&w.some(x=>x.id==='r4'));

const room=searchHistory(records,'ROOM 205 server');
assert.equal(room[0].id,'r1');

const stats=summarizeLibrary(records);
assert.equal(stats.projects,3);
assert.equal(stats.pages,4);
console.log('history-core tests passed');
