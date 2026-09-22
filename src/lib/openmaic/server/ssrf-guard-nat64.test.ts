import { EventEmitter } from 'node:events';
import type { ConnectionOptions, PeerCertificate } from 'node:tls';
import type { Socket } from 'node:net';
import type { buildConnector } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(), tls: vi.fn(), tcp: vi.fn(), identity: vi.fn(), destroy: vi.fn(),
  options: undefined as undefined | { connect: buildConnector.connector | { lookup: (...args: unknown[]) => void } },
}));
vi.mock('node:dns', () => ({ default: { promises: { lookup: mocks.lookup } }, promises: { lookup: mocks.lookup } }));
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  return { ...actual, default: { ...actual, connect: mocks.tcp }, connect: mocks.tcp };
});
vi.mock('node:tls', async (original) => {
  const actual = await original<typeof import('node:tls')>();
  const patched = { ...actual, connect: mocks.tls, checkServerIdentity: mocks.identity };
  return { ...patched, default: patched };
});
vi.mock('undici', () => ({ Agent: class {
  constructor(options: NonNullable<typeof mocks.options>) { mocks.options = options; }
  destroy = mocks.destroy;
} }));
import { createSsrfSafeDispatcher } from './ssrf-guard';

class FakeSocket extends EventEmitter {
  destroy = vi.fn();
  setKeepAlive = vi.fn();
  setNoDelay = vi.fn();
}
const prefixes = '2001:67c:2960:6464::/96,2a00:1098:2c:0:0:5::/96';
const target = { hostname: 'media.example', protocol: 'https:', port: '443' };
function connect(options = target) {
  const callback = vi.fn<buildConnector.Callback>();
  (mocks.options!.connect as buildConnector.connector)(options, callback);
  return callback;
}

describe('pinned media NAT64 connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('OPENPBL_NAT64_PREFIXES', prefixes);
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    mocks.tls.mockImplementation(() => new FakeSocket());
    mocks.tcp.mockImplementation(() => new FakeSocket());
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('pins each candidate to the validated IPv4 while preserving TLS hostname identity', async () => {
    const connection = await createSsrfSafeDispatcher('https://media.example/a.png');
    const callback = connect();
    expect(mocks.tls.mock.calls.map(([options]) => options.host)).toEqual([
      '2001:67c:2960:6464:0:0:808:808', '2a00:1098:2c:0:0:5:808:808',
    ]);
    const options = mocks.tls.mock.calls[0][0] as ConnectionOptions;
    expect(options.servername).toBe('media.example');
    expect(options.rejectUnauthorized).toBe(true);
    const cert = {} as PeerCertificate;
    options.checkServerIdentity!('translated-route', cert);
    expect(mocks.identity).toHaveBeenCalledWith('media.example', cert);
    const [first, second] = mocks.tls.mock.results.map((result) => result.value as FakeSocket);
    second.emit('secureConnect');
    expect(callback).toHaveBeenCalledWith(null, second);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(mocks.lookup).toHaveBeenCalledTimes(2); // Existing preflight plus pinned safety resolution; no connector DNS.
    await connection.close();
  });

  it('supports public IPv4 URL literals with the original IP certificate identity and no SNI', async () => {
    const connection = await createSsrfSafeDispatcher('https://8.8.8.8/a.png');
    connect({ ...target, hostname: '8.8.8.8' });
    const options = mocks.tls.mock.calls[0][0] as ConnectionOptions;
    expect(options.servername).toBeUndefined();
    const cert = {} as PeerCertificate;
    options.checkServerIdentity!('translated-route', cert);
    expect(mocks.identity).toHaveBeenCalledWith('8.8.8.8', cert);
    expect(mocks.lookup).not.toHaveBeenCalled();
    await connection.close();
  });

  it('retains native public IPv6 and survives failure of another pinned route', async () => {
    mocks.lookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }]);
    const connection = await createSsrfSafeDispatcher('https://media.example/a.png');
    const callback = connect();
    expect(mocks.tls.mock.calls[0][0].host).toBe('2606:4700:4700::1111');
    const sockets = mocks.tls.mock.results.map((result) => result.value as FakeSocket);
    sockets[0].emit('error', new Error('route unavailable'));
    sockets[1].emit('secureConnect');
    expect(callback).toHaveBeenCalledWith(null, sockets[1]);
    await connection.close();
  });

  it('fails if every candidate rejects TLS instead of accepting an unverified route', async () => {
    const connection = await createSsrfSafeDispatcher('https://media.example/a');
    const callback = connect();
    const sockets = mocks.tls.mock.results.map((result) => result.value as FakeSocket);
    sockets[0].emit('error', new Error('certificate mismatch'));
    expect(callback).not.toHaveBeenCalled();
    sockets[1].emit('error', new Error('certificate mismatch'));
    expect(callback).toHaveBeenCalledWith(expect.any(AggregateError), null);
    for (const socket of sockets) expect(socket.destroy).toHaveBeenCalledOnce();
    await connection.close();
  });

  it('rejects mixed private DNS results and rebinding at the pinned resolution', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(createSsrfSafeDispatcher('https://media.example/a.png')).rejects.toThrow('Local/private');
    expect(mocks.tls).not.toHaveBeenCalled();
  });

  it('rejects private IPv4 embedded in a configured NAT64 prefix', async () => {
    await expect(createSsrfSafeDispatcher('https://[2001:67c:2960:6464::7f00:1]/a')).rejects.toThrow('Local/private');
  });

  it.each(['2001:67c:2960:6464::1/96', '2001:67c:2960:6464::/64', 'fd00::/96', 'bad'])('fails closed for invalid operator prefix %s', async (prefix) => {
    vi.stubEnv('OPENPBL_NAT64_PREFIXES', prefix);
    await expect(createSsrfSafeDispatcher('https://media.example/a')).rejects.toThrow('OPENPBL_NAT64_PREFIXES');
  });

  it('keeps the original pinned direct lookup when no prefix is configured', async () => {
    vi.stubEnv('OPENPBL_NAT64_PREFIXES', '');
    const connection = await createSsrfSafeDispatcher('https://media.example/a');
    const callback = vi.fn();
    const connector = mocks.options!.connect as { lookup: (...args: unknown[]) => void };
    connector.lookup('media.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(mocks.tls).not.toHaveBeenCalled();
    await connection.close();
  });

  it('bounds all hung candidates and destroys them on timeout', async () => {
    vi.useFakeTimers();
    const connection = await createSsrfSafeDispatcher('https://media.example/a');
    const callback = connect();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ message: 'Media connection timed out' }), null);
    for (const result of mocks.tls.mock.results) expect(result.value.destroy).toHaveBeenCalledOnce();
    await connection.close();
  });

  it('cleans up pending sockets and reports exactly once when aborted', async () => {
    const connection = await createSsrfSafeDispatcher('https://media.example/a');
    const callback = connect();
    await connection.close();
    for (const result of mocks.tls.mock.results) expect(result.value.destroy).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('uses pinned TCP for HTTP and prevents dispatcher reuse for a different hostname', async () => {
    const connection = await createSsrfSafeDispatcher('http://media.example/a');
    const rejected = connect({ ...target, hostname: 'internal.example' });
    expect(rejected).toHaveBeenCalledWith(expect.any(Error), null);
    const callback = connect({ ...target, protocol: 'http:', port: '80' });
    const socket = mocks.tcp.mock.results[0].value as FakeSocket;
    socket.emit('connect');
    expect(callback).toHaveBeenCalledWith(null, socket as unknown as Socket);
    expect(mocks.tls).not.toHaveBeenCalled();
    await connection.close();
  });
});
