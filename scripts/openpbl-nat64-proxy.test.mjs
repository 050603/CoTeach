import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDns64Resolver,
  hostMatchesAllowlist,
  isPublicIpv6,
  parseAuthority,
} from './openpbl-nat64-proxy.mjs';

test('parses HTTPS CONNECT authorities without accepting userinfo or paths', () => {
  assert.deepEqual(parseAuthority('api.deepseek.com:443'), {
    hostname: 'api.deepseek.com',
    port: 443,
  });
  assert.equal(parseAuthority('user@example.com:443'), undefined);
  assert.equal(parseAuthority('example.com:443/path'), undefined);
  assert.equal(parseAuthority('example.com:0'), undefined);
});

test('only accepts globally routed IPv6 addresses', () => {
  assert.equal(isPublicIpv6('2a00:1098:2b::1:3ad:153f'), true);
  assert.equal(isPublicIpv6('::1'), false);
  assert.equal(isPublicIpv6('fe80::1'), false);
  assert.equal(isPublicIpv6('fc00::1'), false);
  assert.equal(isPublicIpv6('::ffff:127.0.0.1'), false);
});

test('matches exact hosts and explicitly configured domain suffixes', () => {
  const allowlist = ['api.deepseek.com', '.aliyuncs.com'];
  assert.equal(hostMatchesAllowlist('api.deepseek.com', allowlist), true);
  assert.equal(hostMatchesAllowlist('dashscope-a717.oss-accelerate.aliyuncs.com', allowlist), true);
  assert.equal(hostMatchesAllowlist('deepseek.example.com', allowlist), false);
});

function dnsFactory(resolve6, onCancel = () => {}) {
  return (options) => {
    let server;
    return {
      setServers: (servers) => { [server] = servers; },
      resolve6: (hostname) => resolve6(server, hostname, options),
      cancel: () => onCancel(server),
    };
  };
}

test('bounds an unresponsive DNS route while retaining successful parallel answers', { timeout: 1000 }, async () => {
  const cancelled = [];
  const resolve = createDns64Resolver({
    servers: ['healthy', 'hung'],
    timeoutMs: 25,
    createResolver: dnsFactory((server, _hostname, options) => {
      assert.deepEqual(options, { timeout: 25, tries: 1 });
      return server === 'hung' ? new Promise(() => {}) : Promise.resolve([{ address: '2001:db8::1' }]);
    }, (server) => cancelled.push(server)),
  });
  assert.deepEqual(await resolve('example.com'), ['2001:db8::1']);
  assert.deepEqual(cancelled, ['hung']);
});

test('coalesces simultaneous same-host lookups across every DNS route', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resolve = createDns64Resolver({
    servers: ['first', 'second'],
    createResolver: dnsFactory(async () => {
      calls += 1;
      await gate;
      return ['2001:db8::1'];
    }),
  });
  const requests = [resolve('EXAMPLE.com'), resolve('example.com'), resolve('example.com')];
  assert.equal(calls, 2);
  release();
  assert.deepEqual(await Promise.all(requests), Array(3).fill(['2001:db8::1']));
});

test('allows a fresh lookup after all DNS routes fail', async () => {
  let calls = 0;
  const resolve = createDns64Resolver({
    servers: ['dns'],
    createResolver: dnsFactory(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary outage');
      return ['2001:db8::1'];
    }),
  });
  await assert.rejects(resolve('example.com'), /temporary outage/);
  assert.deepEqual(await resolve('example.com'), ['2001:db8::1']);
  assert.equal(calls, 2);
});

test('caches valid deduplicated answers only until the short cache expires', async () => {
  let calls = 0;
  const resolve = createDns64Resolver({
    servers: ['dns'],
    cacheTtlMs: 20,
    createResolver: dnsFactory(async () => {
      calls += 1;
      return ['2001:db8::1', { address: '2001:db8::1' }, '::1'];
    }),
  });
  assert.deepEqual(await resolve('example.com'), ['2001:db8::1']);
  assert.deepEqual(await resolve('example.com'), ['2001:db8::1']);
  assert.equal(calls, 1);
  await new Promise((done) => setTimeout(done, 30));
  assert.deepEqual(await resolve('example.com'), ['2001:db8::1']);
  assert.equal(calls, 2);
});

async function fixture(t, onConnection, options = {}) {
  const { default: net } = await import('node:net');
  const { once } = await import('node:events');
  const { createNat64Proxy } = await import('./openpbl-nat64-proxy.mjs');
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const origin = net.createServer((socket) => onConnection(track(socket)));
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const records = [];
  const dial = async () => {
    const socket = track(net.connect(origin.address().port, '127.0.0.1'));
    await once(socket, 'connect');
    return socket;
  };
  const { server } = createNat64Proxy({
    resolveDns64: async () => ['::1'],
    connect: dial,
    log: (line) => records.push(JSON.parse(line.slice(line.indexOf('{')))),
    ...options,
  });
  server.on('connection', track);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([server, origin].map((item) => new Promise((resolve) => item.close(resolve))));
  });
  const client = track(net.connect(server.address().port, '127.0.0.1'));
  await once(client, 'connect');
  client.write('CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: api.deepseek.com\r\n\r\n');
  return { client, records, dial, once };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'condition did not become true');
}

test('forwards a full buffered response on normal upstream EOF', { timeout: 5000 }, async (t) => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 'x');
  const { client, records, once } = await fixture(t, (socket) => {
    socket.once('data', (data) => {
      assert.equal(data.toString(), 'request');
      socket.end(payload);
    });
  });
  const chunks = [];
  client.on('data', (chunk) => chunks.push(chunk));
  await once(client, 'data');
  client.write('request');
  client.pause();
  await new Promise((resolve) => setTimeout(resolve, 30));
  client.resume();
  await once(client, 'end');
  const received = Buffer.concat(chunks);
  assert.deepEqual(received.subarray(received.indexOf('\r\n\r\n') + 4), payload);
  await eventually(() => records.length === 1);
  assert.equal(records[0].source, 'upstream-end');
  assert.equal(records[0].upstreamBytesRead, payload.length);
  assert.equal(records[0].upstreamBytesWritten, 7);
  assert.equal(records[0].upstreamAddress, '127.0.0.1');
});

test('cleans up a late upstream when the client cancels during connection', { timeout: 5000 }, async (t) => {
  let release;
  let pending;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, () => {}, {
    connect: async () => {
      pending = await f.dial();
      await gate;
      return pending;
    },
  });
  await eventually(() => pending);
  f.client.destroy();
  await eventually(() => f.records.length === 1);
  release();
  await eventually(() => pending.destroyed);
  assert.equal(f.records[0].established, false);
});

test('closes the client and records the cause when upstream resets', { timeout: 5000 }, async (t) => {
  let originSocket;
  const { client, records, once } = await fixture(t, (socket) => { originSocket = socket; });
  client.resume();
  await once(client, 'data');
  const closed = new Promise((resolve) => client.once('close', resolve));
  originSocket.resetAndDestroy();
  await closed;
  await eventually(() => records.length === 1);
  assert.equal(records[0].source, 'upstream-error');
  assert.equal(records[0].errorCode, 'ECONNRESET');
});

test('handles client reset during DNS without an unhandled error or leaked upstream', { timeout: 5000 }, async (t) => {
  let releaseDns;
  let resolving = false;
  let upstream;
  const dnsGate = new Promise((resolve) => { releaseDns = resolve; });
  const f = await fixture(t, () => {}, {
    resolveDns64: async () => {
      resolving = true;
      await dnsGate;
      return ['::1'];
    },
    connect: async () => {
      upstream = await f.dial();
      return upstream;
    },
  });
  await eventually(() => resolving);
  f.client.resetAndDestroy();
  await eventually(() => f.records.length === 1);
  releaseDns();
  await eventually(() => upstream?.destroyed);
  assert.equal(f.records[0].source, 'client-error');
  assert.equal(f.records[0].errorCode, 'ECONNRESET');
});

test('returns 502 with structured error codes when all connections fail', { timeout: 5000 }, async (t) => {
  const { client, records, once } = await fixture(t, () => {}, {
    connect: async () => {
      throw new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })]);
    },
  });
  let response = '';
  client.on('data', (chunk) => { response += chunk; });
  await once(client, 'end');
  assert.match(response, /^HTTP\/1.1 502/);
  await eventually(() => records.length === 1);
  assert.equal(records[0].source, 'connect-error');
  assert.deepEqual(records[0].connectionErrorCodes, ['ECONNREFUSED']);
});
