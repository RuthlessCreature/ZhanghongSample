import assert from 'node:assert/strict';
import {parseCommentLines,buildCommentEvidence,scorePagePairsForComments} from '../public/comment-core.js';

const comments=parseCommentLines([
  '1. A-101 房间 ROOM 102 改为 CONFERENCE ROOM。',
  '2. 楼梯 CLR 由 1200 调整为 1350。',
  '3. 新增 W03，并同步 A-201、A-601。',
  '4. 删除 D09。'
]);
assert.equal(comments.length,4);
assert.equal(comments[0].id,'C001');
assert.ok(comments[0].targetSheets.includes('A-101'));
assert.ok(comments[2].marks.includes('W03'));
assert.deepEqual(comments[0].targetSheets,['A-101']);
const shaftComment=parseCommentLines(['1. Coordinate MEP shaft S-01 between A-101 and A-301 and add an explicit coordinated note.'])[0];
assert.deepEqual(shaftComment.targetSheets,['A-101','A-301']);
assert.ok(!shaftComment.targetSheets.includes('S-01'));

const changes=[
 {id:'T001',sheetId:'A-101',pageA:1,pageB:1,type:'replace',before:'ROOM 102: MEETING ROOM',after:'ROOM 102: CONFERENCE ROOM'},
 {id:'T002',sheetId:'A-101',pageA:1,pageB:1,type:'replace',before:'STAIR CLR 1200',after:'STAIR CLR 1350',numeric:{before:1200,after:1350,delta:150}},
 {id:'T003',sheetId:'A-101',pageA:1,pageB:1,type:'add',before:'',after:'W03'},
 {id:'T004',sheetId:'A-601',pageA:3,pageB:3,type:'remove',before:'D09',after:''}
];
const ev=buildCommentEvidence(comments,changes);
assert.ok(ev[0].candidateIds.includes('T001'));
assert.equal(ev[1].deterministicHint,'likely-implemented');
assert.ok(ev[2].candidateIds.includes('T003'));
assert.equal(ev[3].deterministicHint,'likely-implemented');

const pairs=[{pageA:0,pageB:0,sheetId:'A-101'},{pageA:1,pageB:1,sheetId:'A-201'},{pageA:2,pageB:2,sheetId:'A-601'}];
const scored=scorePagePairsForComments(comments,ev,pairs,changes);
assert.equal(scored[0].sheetId,'A-101');
console.log('comment-core tests passed');
