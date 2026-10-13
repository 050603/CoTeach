import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';

// A real, loopback-only reverse proxy lets the unmodified production browser
// bundle use its same-origin /ws URL against disposable application services.
export async function startPrelaunchProxy({ port, appPort, websocketPort }) {
  for (const [name, value] of Object.entries({ port, appPort, websocketPort })) {
    assert.ok(Number.isInteger(value) && value >= (name === 'port' ? 0 : 1) && value <= 65535, `Invalid ${name}`);
  }
  assert.notEqual(appPort, websocketPort);
  if (port) {
    assert.notEqual(port, appPort);
    assert.notEqual(port, websocketPort);
  }
  const sockets = new Set();
  const websocketSockets = new Set();
  const proxy = createServer((incoming, outgoing) => {
    const upstream = request({ hostname: '127.0.0.1', port: appPort, method: incoming.method,
      path: incoming.url, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end('Isolated application unavailable');
    });
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  proxy.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (incoming, socket, head) => {
    if (new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port: websocketPort }, () => {
      const headers = [];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
      }
      upstream.write(`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    websocketSockets.add(socket);
    sockets.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => { websocketSockets.delete(socket); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', () => { proxy.off('error', reject); resolve(); });
  });
  return {
    port: proxy.address().port,
    disconnectWebSockets: () => { for (const socket of websocketSockets) socket.destroy(); },
    close: () => new Promise((resolve, reject) => {
      proxy.close(error => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    }),
  };
}
