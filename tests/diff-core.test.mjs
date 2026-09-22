import assert from 'node:assert/strict';
import {diffTextItems, pairPages, summarizeDeterministicDiff, detectSheetId} from '../public/diff-core.js';

const item=(str,x,y,w=.08,h=.02)=>({str,x,y,w,h});

{
  const changes=diffTextItems([
    item('23000',.30,.10), item('12000',.40,.10), item('ROOM 102',.55,.45), item('UNCHANGED',.2,.8)
  ],[
    item('23800',.30,.10), item('12800',.40,.10), item('CONFERENCE ROOM 102',.55,.45), item('UNCHANGED',.2,.8)
  ]);
  assert.ok(changes.some(x=>x.before==='23000' && x.after==='23800' && x.numeric?.delta===800));
  assert.ok(changes.some(x=>x.before==='12000' && x.after==='12800' && x.numeric?.delta===800));
  assert.ok(changes.some(x=>x.before==='ROOM 102' && x.after==='CONFERENCE ROOM 102'));
  assert.ok(!changes.some(x=>x.before==='UNCHANGED' || x.after==='UNCHANGED'));
}

{
  assert.equal(detectSheetId('SHEET: A-101 LEVEL 1 FLOOR PLAN'),'A-101');
  const A=[{sheetId:'A-101'},{sheetId:'A-201'}];
  const B=[{sheetId:'A-201'},{sheetId:'A-101'}];
  const pairs=pairPages(A,B);
  assert.deepEqual(pairs.map(x=>[x.pageA,x.pageB,x.sheetId]),[[0,1,'A-101'],[1,0,'A-201']]);
}

{
  const A=[{sheetId:'A-101',textItems:[item('12000',.2,.2)],textRaw:'A-101 12000'}];
  const B=[{sheetId:'A-101',textItems:[item('12800',.2,.2)],textRaw:'A-101 12800'}];
  const d=summarizeDeterministicDiff(A,B);
  assert.equal(d.textCoverage.mode,'visual-only');
  assert.equal(d.textChanges[0].numeric.delta,800);
}
console.log('diff-core tests passed');
