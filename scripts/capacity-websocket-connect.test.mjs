import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { subscribeCapacitySocket } from './capacity-websocket-connect.mjs';
const socket = () => Object.assign(new EventEmitter(), { _socket: { remoteAddress: '172.16.185.157' }, terminate() { this.terminated = true; }, send() {} });
const options = { courseId: 'course', address: '172.16.185.157', timeoutMs: 1000 };
test('rejects and disposes a 502 upgrade as transient', async () => {
  const ws = socket(), task = subscribeCapacitySocket(ws, options); let drained = false;
  ws.emit('unexpected-response', {}, { statusCode: 502, resume() { drained = true; } });
  await assert.rejects(task, error => error.retryable === true); assert.equal(ws.terminated, true); assert.equal(drained, true);
});
test('never retries peer mismatch, forbidden subscriptions or 401 upgrade', async () => {
  for (const mode of ['peer', 'forbidden', '401']) {
    const ws = socket(), task = subscribeCapacitySocket(ws, options);
    if (mode === 'peer') { ws._socket.remoteAddress = '127.0.0.1'; ws.emit('open'); }
    else if (mode === '401') ws.emit('unexpected-response', {}, { statusCode: 401, resume() {} });
    else ws.emit('message', Buffer.from(JSON.stringify({ type: 'error', code: 'COURSE_FORBIDDEN' })));
    await assert.rejects(task, error => error.retryable === false); assert.equal(ws.terminated, true);
  }
});
test('requires the matching subscribe ack, preserves events and tolerates later socket errors', async () => {
  const ws = socket(), messages = [], task = subscribeCapacitySocket(ws, { ...options, onMessage: value => messages.push(value) });
  ws.emit('open'); ws.emit('message', Buffer.from(JSON.stringify({ type: 'subscribed', courseId: 'course' }))); await task;
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'course-event', courseId: 'course' })));
  ws.emit('error', Error('late transport')); assert.equal(messages.at(-1).type, 'course-event');
});
test('terminates a socket on its actual bounded subscribe timeout', async () => {
  const ws = socket(); await assert.rejects(subscribeCapacitySocket(ws, { ...options, timeoutMs: 5 }), error => error.retryable === true);
  assert.equal(ws.terminated, true);
});
test('a real local HTTP 502 handshake is closed and reported as retryable', async () => {
  const { createServer } = await import('node:http');
  const { WebSocket } = await import('ws');
  const server = createServer((_request, response) => { response.writeHead(502); response.end('not listening'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    await assert.rejects(subscribeCapacitySocket(client, { ...options, address: '127.0.0.1' }), error => error.retryable === true && /502/.test(error.message));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.readyState, WebSocket.CLOSED);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
