import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityLocalReadiness } from './capacity-local-readiness.mjs';

test('uses authenticated loopback management endpoint and caller deadline', async () => {
  const expected = { status: 'ready', dependencies: { websocket: { ok: true } } };
  const result = await capacityLocalReadiness('test-token', 1234, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3000/api/health/ready');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(expected);
  });
  assert.deepEqual(result, { ok: true, status: 200, body: expected });
});
test('non-JSON error retains HTTP status without converting it to a parse exception', async () => {
  const result = await capacityLocalReadiness('test-token', 1000, async () => new Response('<html>Not found</html>', { status: 404 }));
  assert.deepEqual(result, { ok: false, status: 404, body: null });
});
test('non-JSON successful response cannot satisfy readiness', async () => {
  const result = await capacityLocalReadiness('test-token', 1000, async () => new Response('<html>ok</html>'));
  assert.equal(result.body, null);
});
test('transport failure remains visible to bounded retry logic', async () => {
  await assert.rejects(capacityLocalReadiness('test-token', 1000, async () => { throw new Error('connection refused'); }), /connection refused/);
});
