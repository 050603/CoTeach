import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
