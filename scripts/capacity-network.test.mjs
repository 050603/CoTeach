import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { capacityBrowserEnvironment, configureCapacityNetwork } from './capacity-network.mjs';

test('browser environment disables inherited proxies without changing the parent process', () => {
  const prior = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9999';
  try {
    const env = capacityBrowserEnvironment();
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.NO_PROXY, '*'); assert.equal(env.no_proxy, '*');
    assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:9999');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (prior === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prior;
  }
});

test('first-party lookup preserves the domain while forcing a private destination', async () => {
  const prior = process.env.CAPACITY_CONNECT_HOST;
  process.env.CAPACITY_CONNECT_HOST = '172.16.185.157';
  let config;
  try {
    config = configureCapacityNetwork('https://coteach.cn');
    const addresses = await new Promise((resolve, reject) => config.lookup('coteach.cn', { all: true }, (error, value) => error ? reject(error) : resolve(value)));
    assert.deepEqual(addresses, [{ address: '172.16.185.157', family: 4 }]);
    assert.ok(config.browserArgs.includes('--no-proxy-server'));
    assert.ok(config.browserArgs.includes('--host-resolver-rules=MAP coteach.cn 172.16.185.157'));
    process.env.CAPACITY_CONNECT_HOST = '8.8.8.8';
    assert.throws(() => configureCapacityNetwork('https://coteach.cn'), /internal/);
  } finally {
    await config?.close();
    if (prior === undefined) delete process.env.CAPACITY_CONNECT_HOST;
    else process.env.CAPACITY_CONNECT_HOST = prior;
  }
});

async function localNetwork(mode, exercise) {
  const sockets = new Set(), ids = new WeakMap();
  let nextId = 0, notifyHeld;
  const held = new Promise(resolve => { notifyHeld = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/hold') { notifyHeld(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ socketId: ids.get(request.socket), host: request.headers.host }));
  });
  server.on('connection', socket => { sockets.add(socket); ids.set(socket, ++nextId); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const priorMode = process.env.CAPACITY_TRANSPORT_MODE, priorHost = process.env.CAPACITY_CONNECT_HOST;
  if (mode === undefined) delete process.env.CAPACITY_TRANSPORT_MODE;
  else process.env.CAPACITY_TRANSPORT_MODE = mode;
  process.env.CAPACITY_CONNECT_HOST = '127.0.0.1';
  let network;
  try {
    network = configureCapacityNetwork(origin);
    const request = async actor => {
      const response = await fetch(origin, { dispatcher: network.dispatcherForActor(actor) });
      const body = await response.json();
      await delay(10); // Allow the completed response to release its socket.
      assert.equal(body.host, new URL(origin).host);
      return body;
    };
    await exercise({ network, origin, request, held, sockets });
  } finally {
    await network?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (priorMode === undefined) delete process.env.CAPACITY_TRANSPORT_MODE;
    else process.env.CAPACITY_TRANSPORT_MODE = priorMode;
    if (priorHost === undefined) delete process.env.CAPACITY_CONNECT_HOST;
    else process.env.CAPACITY_CONNECT_HOST = priorHost;
  }
}

test('shared remains the default and reuses a connection across actors', async () => {
  await localNetwork(undefined, async ({ network, request, sockets }) => {
    const teacher = {}, student = {};
    assert.equal(network.transportMode, 'shared');
    assert.equal(network.dispatcherForActor(teacher), network.dispatcherForActor(student));
    assert.equal(network.dispatcherForActor(null), network.dispatcherForActor(student));
    assert.equal((await request(teacher)).socketId, (await request(student)).socketId);
    await network.close(); await delay(10); assert.equal(sockets.size, 0);
    await network.close(); // Safe repeated release.
    assert.throws(() => network.dispatcherForActor(teacher), /closed/);
  });
});

test('isolated actors retain their own connection while a student request is pending', async () => {
  await localNetwork('isolated', async ({ network, origin, request, held, sockets }) => {
    const teacher = { cookie: 'before-login' }, student = {};
    assert.equal(network.transportMode, 'isolated');
    const teacherAgent = network.dispatcherForActor(teacher);
    assert.notEqual(teacherAgent, network.dispatcherForActor(student));
    assert.notEqual(teacherAgent, network.dispatcherForActor(null));
    assert.equal(network.dispatcherForActor(null), network.dispatcherForActor(undefined));
    const warm = await request(teacher);
    const studentWarm = await request(student); assert.notEqual(studentWarm.socketId, warm.socketId);
    teacher.cookie = 'after-login'; assert.equal(network.dispatcherForActor(teacher), teacherAgent);
    const controller = new AbortController();
    const pending = fetch(`${origin}/hold`, { dispatcher: network.dispatcherForActor(student), signal: controller.signal }).catch(error => error);
    await held;
    assert.equal((await request(teacher)).socketId, warm.socketId);
    controller.abort(); assert.ok(await pending instanceof Error);
    await network.close(); await delay(10); assert.equal(sockets.size, 0);
  });
});

test('rejects an unknown mode before installing a dispatcher', () => {
  const prior = process.env.CAPACITY_TRANSPORT_MODE;
  try {
    process.env.CAPACITY_TRANSPORT_MODE = 'isolated-typo';
    assert.throws(() => configureCapacityNetwork('https://coteach.cn'), /CAPACITY_TRANSPORT_MODE/);
  } finally {
    if (prior === undefined) delete process.env.CAPACITY_TRANSPORT_MODE;
    else process.env.CAPACITY_TRANSPORT_MODE = prior;
  }
});

test('bounded shutdown destroys a hanging request and leaves no open sockets', { timeout: 10000 }, async () => {
  await localNetwork('isolated', async ({ network, origin, held, sockets }) => {
    const pending = fetch(`${origin}/hold`, { dispatcher: network.dispatcherForActor({}) }).catch(error => error);
    await held;
    await network.close(); assert.ok(await pending instanceof Error);
    await delay(10); assert.equal(sockets.size, 0);
  });
});
