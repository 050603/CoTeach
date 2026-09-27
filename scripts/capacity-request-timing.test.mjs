import assert from 'node:assert/strict';
import test from 'node:test';
import { pairCapacityRequestTiming } from './capacity-request-timing.mjs';

test('pairs each request without adding nested action phases or different requests', () => {
  const first = pairCapacityRequestTiming({ category: 'draft-projection', requestId: 'first', elapsedMs: 600,
    serverTiming: 'authenticate;dur=3, action;dur=30, write;dur=4, proxy;dur=5, dispatch;dur=100, handler;dur=50' });
  const second = pairCapacityRequestTiming({ category: 'draft-projection', requestId: 'second', elapsedMs: 120,
    serverTiming: 'proxy;dur=10, dispatch;dur=20, handler;dur=80' });
  assert.equal(first.outsideMeasuredMs, 445);
  assert.equal(second.outsideMeasuredMs, 10);
  assert.equal(first.requestId, 'first');
  assert.equal(first.phases.action, 30);
});

test('missing outer phases leave the residual unmeasured', () => {
  for (const serverTiming of [null, 'action;dur=5', 'proxy;dur=1, dispatch;dur=2']) {
    assert.equal(Object.hasOwn(pairCapacityRequestTiming({ elapsedMs: 20, serverTiming }), 'outsideMeasuredMs'), false);
  }
});

test('keeps small negative residuals visible rather than hiding clock rounding', () => {
  const result = pairCapacityRequestTiming({ elapsedMs: 9.5, serverTiming: 'proxy;dur=1, dispatch;dur=2, handler;dur=7' });
  assert.equal(result.outsideMeasuredMs, -0.5);
});
