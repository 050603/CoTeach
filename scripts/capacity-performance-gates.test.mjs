import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityBudgets, capacityPerformanceFailures } from './capacity-performance-gates.mjs';
const passing = () => new Map(Object.keys(capacityBudgets({ soak: true, realAi: true })).map(k => [k, { times: [100] }]));
test('a large volume of fast polling cannot hide slow uploads or showcase reads', () => {
  const values = passing(); values.set('ordinary-reads', { times: Array(10000).fill(10) });
  values.set('external-artifact-upload', { times: [2819] }); values.set('showcase-read', { times: [1027] });
  assert.equal(capacityPerformanceFailures(values, {soak:true,realAi:true}).length, 2);
});
test('required missing categories and invalid samples fail closed', () => {
  const values = passing(); values.delete('archive'); values.set('quiz', {times:[NaN]});
  assert.equal(capacityPerformanceFailures(values, {soak:true,realAi:true}).length, 2);
});
test('phase budgets only evaluate sampled categories and retain a failed burst', () => {
  const phase = new Map([['draft-save',{times:[2165]}]]);
  assert.deepEqual(capacityPerformanceFailures(phase,{requireAll:false}), ['draft-save P95=2165 exceeds 2000ms']);
});
test('exact thresholds pass, overhead features retain their own budgets', () => {
  const values = new Map(Object.entries(capacityBudgets()).map(([k,v])=>[k,{times:[v]}]));
  assert.deepEqual(capacityPerformanceFailures(values),[]);
  values.get('extended-teacher-action').times.push(2240);
  assert.equal(capacityPerformanceFailures(values).length,1);
});
test('learning recovery operation latency is gated even when individual attempts are fast', () => {
  const values = passing(); values.set('learning-events', { times: [100, 100] });
  values.set('learning-event-save', { times: [10200] });
  assert.deepEqual(capacityPerformanceFailures(values, { soak: true, realAi: true }), ['learning-event-save P95=10200 exceeds 2000ms']);
});
