import assert from 'node:assert/strict';
import test from 'node:test';
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
  try {
    const config = configureCapacityNetwork('https://coteach.cn');
    const addresses = await new Promise((resolve, reject) => config.lookup('coteach.cn', { all: true }, (error, value) => error ? reject(error) : resolve(value)));
    assert.deepEqual(addresses, [{ address: '172.16.185.157', family: 4 }]);
    assert.ok(config.browserArgs.includes('--no-proxy-server'));
    assert.ok(config.browserArgs.includes('--host-resolver-rules=MAP coteach.cn 172.16.185.157'));
    process.env.CAPACITY_CONNECT_HOST = '8.8.8.8';
    assert.throws(() => configureCapacityNetwork('https://coteach.cn'), /internal/);
  } finally {
    if (prior === undefined) delete process.env.CAPACITY_CONNECT_HOST;
    else process.env.CAPACITY_CONNECT_HOST = prior;
  }
});
