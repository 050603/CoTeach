// @vitest-environment node
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createOpenAI: vi.fn() }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.createOpenAI }));
import { getModel } from './providers';

async function createExpiringTunnelFixture() {
  const sockets = new Set<Duplex>();
  const requests = new Set<net.Socket>();
  let tunnelCount = 0;
  const upstream = http.createServer((request, response) => {
    // Reproduce an upstream dropping an aged/reused connection when the next
    // POST starts. There is no response to safely recover from on this socket.
    if (requests.has(request.socket)) {
      request.socket.destroy();
      return;
    }
    requests.add(request.socket);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    setTimeout(() => response.end('data: complete\n\n'), 10);
  });
  upstream.keepAliveTimeout = 60_000;
  upstream.on('connection', (socket) => sockets.add(socket));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const proxy = http.createServer();
  proxy.on('connect', (_request, client, head) => {
    tunnelCount += 1;
    sockets.add(client);
    const remote = net.connect(upstreamPort, '127.0.0.1');
    sockets.add(remote);
    client.on('error', () => remote.destroy());
    remote.on('error', () => client.destroy());
    client.on('close', () => remote.destroy());
    remote.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  return {
    proxyUrl: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
    tunnelCount: () => tunnelCount,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([upstream, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}

describe('real proxied model transport', () => {
  it('reproduces a socket failure when a later POST reuses an expired tunnel', async () => {
    const fixture = await createExpiringTunnelFixture();
    const dispatcher = new ProxyAgent({ uri: fixture.proxyUrl, connections: 1 });
    try {
      const response = await undiciFetch('http://model.test/completions', { method: 'POST', body: '{}', dispatcher });
      expect(await response.text()).toContain('complete');
      await expect(undiciFetch('http://model.test/completions', { method: 'POST', body: '{}', dispatcher }))
        .rejects.toMatchObject({ cause: { code: 'UND_ERR_SOCKET' } });
      expect(fixture.tunnelCount()).toBe(1);
    } finally {
      await dispatcher.destroy();
      await fixture.close();
    }
  });

  it.each(['explicit', 'managed'] as const)('completes every first attempt on a fresh %s model tunnel', async (routing) => {
    const fixture = await createExpiringTunnelFixture();
    mocks.createOpenAI.mockReset().mockReturnValue({ chat: () => ({}) });
    try {
      vi.stubEnv('OPENPBL_OUTBOUND_PROXY', fixture.proxyUrl);
      getModel({ providerId: 'openai', modelId: 'gpt-4o-mini', apiKey: 'test',
        ...(routing === 'explicit' ? { proxy: fixture.proxyUrl } : {}),
      });
      const transport = mocks.createOpenAI.mock.calls[0][0].fetch as typeof fetch;
      for (let index = 0; index < 4; index++) {
        const response = await transport('http://model.test/completions', { method: 'POST', body: '{}' });
        expect(await response.text()).toBe('data: first\n\ndata: complete\n\n');
      }
      expect(fixture.tunnelCount()).toBe(4);
    } finally {
      vi.unstubAllEnvs();
      await fixture.close();
    }
  });
});
