import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { startPrelaunchProxy } from './prelaunch-proxy.mjs';

test('isolated proxy forwards real HTTP and WebSocket traffic with origin and session intact', async t => {
  const app = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ path: request.url, cookie: request.headers.cookie,
      origin: request.headers.origin, body: Buffer.concat(chunks).toString() }));
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(websocket, 'listening');
  const proxy = await startPrelaunchProxy({ port: 0, appPort: app.address().port, websocketPort: websocket.address().port });
  t.after(async () => {
    await proxy.close();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => websocket.close(resolve))]);
  });
  const origin = `http://127.0.0.1:${proxy.port}`;
  const headers = { Cookie: 'isolated-session=synthetic', Origin: origin };
  const response = await fetch(`${origin}/api/example?view=student`, { method: 'POST', headers, body: 'submission' });
  assert.deepEqual(await response.json(), { path: '/api/example?view=student', cookie: headers.Cookie, origin, body: 'submission' });
  websocket.on('connection', (socket, request) => {
    assert.equal(request.headers.cookie, headers.Cookie);
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers.host, `127.0.0.1:${proxy.port}`);
    socket.on('message', message => socket.send(message));
  });
  const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws?role=student`, { headers });
  await once(client, 'open');
  client.send('real classroom event');
  const [message] = await once(client, 'message');
  assert.equal(message.toString(), 'real classroom event');
  const disconnected = once(client, 'close');
  proxy.disconnectWebSockets();
  await disconnected;
  assert.equal((await fetch(`${origin}/still-available`)).status, 200);
  const forbidden = new WebSocket(`ws://127.0.0.1:${proxy.port}/other`, { headers });
  const [error] = await once(forbidden, 'error');
  assert.match(error.message, /404/);
});

test('isolated proxy rejects invalid ports and self-forwarding', async () => {
  await assert.rejects(startPrelaunchProxy({ port: 3198, appPort: 3198, websocketPort: 3199 }));
  await assert.rejects(startPrelaunchProxy({ port: 3198, appPort: 3197, websocketPort: -1 }));
});
