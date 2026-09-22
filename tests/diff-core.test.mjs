import assert from 'node:assert/strict';
import {diffTextItems, pairPages, summarizeDeterministicDiff, detectSheetId, mergeTextItems} from '../public/diff-core.js';

const item=(str,x,y,w=.08,h=.02)=>({str,x,y,w,h});

{
  const changes=diffTextItems([
    item('23000',.30,.10), item('12000',.40,.10), item('ROOM 102',.55,.45), item('UNCHANGED',.2,.8)
  ],[
    item('23800',.30,.10), item('12800',.40,.10), item('CONFERENCE ROOM 102',.55,.45), item('UNCHANGED',.2,.8)
  ]);
  assert.ok(changes.some(x=>x.before==='23000' && x.after==='23800' && x.numeric?.delta===800));
  assert.ok(changes.some(x=>x.before==='12000' && x.after==='12800' && x.numeric?.delta===800));
  assert.ok(changes.some(x=>x.before==='ROOM 102' && x.type==='remove'));
  assert.ok(changes.some(x=>x.after==='CONFERENCE ROOM 102' && x.type==='add'));
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

{
  const changes=diffTextItems([item('coordination.',.78,.15)],[item('CONFERENCE',.79,.16)]);
  assert.ok(!changes.some(x=>x.type==='replace'), 'unrelated nearby labels must not be paired as replacement');
}

{
  const changes=diffTextItems([item('A-101.',.78,.15)],[item('W03.',.79,.16)]);
  assert.ok(!changes.some(x=>x.type==='replace'), 'different numeric shells must not produce a numeric replacement');
  assert.ok(!changes.some(x=>x.numeric), 'different numeric shells must not produce numeric delta');
}

{
  const merged=mergeTextItems([
    item('Grid/partition',.70,.10,.08),
    item('adjusted',.785,.10,.05),
    item('+800.',.84,.10,.04),
    item('23000',.30,.10,.02)
  ]);
  assert.ok(merged.some(x=>x.str.includes('Grid/partition adjusted +800.')));
  assert.ok(merged.some(x=>x.str==='23000'));
}

console.log('diff-core tests passed');
