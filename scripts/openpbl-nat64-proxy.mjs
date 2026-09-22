#!/usr/bin/env node

import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const DEFAULT_DNS64_SERVERS = [
  '2a01:4f9:c010:3f02::1',
  '2a01:4f8:c2c:123f::1',
  '2a00:1098:2b::1',
  '2a00:1098:2c::1',
  '2a01:4ff:f0:9876::1',
  '2001:67c:2960::64',
  '2001:67c:2960::6464',
];

function splitList(value, fallback) {
  const entries = value?.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries?.length ? entries : fallback;
}

export function parseAuthority(authority) {
  if (!authority || /[\s/@]/.test(authority)) return undefined;
  try {
    const parsed = new URL(`https://${authority}`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/') return undefined;
    const port = Number(parsed.port || 443);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { hostname: parsed.hostname.toLowerCase(), port };
  } catch {
    return undefined;
  }
}

export function isPublicIpv6(address) {
  if (net.isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  // Only globally routed unicast space is useful to this proxy. This also
  // rejects loopback, ULA, link-local, multicast and IPv4-mapped addresses.
  return normalized.startsWith('2') || normalized.startsWith('3');
}

export function hostMatchesAllowlist(hostname, allowlist) {
  return allowlist.some((entry) => {
    const candidate = entry.toLowerCase();
    if (candidate === '*') return true;
    const suffix = candidate.replace(/^\./, '');
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
}

export function createDns64Resolver({
  servers,
  cacheTtlMs = 60_000,
  timeoutMs = 2_000,
  createResolver = (options) => new dns.Resolver(options),
}) {
  const cache = new Map();
  const pending = new Map();
  const queryTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs)) : 2_000;

  const query = async (server, hostname) => {
    const resolver = createResolver({ timeout: queryTimeoutMs, tries: 1 });
    resolver.setServers([server]);
    let timer;
    try {
      // Bound wall time as well as c-ares retries. An unresponsive DNS server
      // must not hold up successful results from the other parallel routes.
      return await Promise.race([
        resolver.resolve6(hostname, { ttl: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`DNS64 query timed out after ${queryTimeoutMs}ms (${server})`));
            resolver.cancel();
          }, queryTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  return async function resolveDns64(hostname) {
    const key = hostname.toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.addresses;
    if (pending.has(key)) return pending.get(key);

    const lookup = (async () => {
      const results = await Promise.allSettled(servers.map((server) => query(server, key)));
      const addresses = Array.from(new Set(results.flatMap((result) =>
        result.status === 'fulfilled'
          ? result.value.map((record) => typeof record === 'string' ? record : record.address)
          : [],
      ).filter(isPublicIpv6)));
      if (addresses.length === 0) {
        const reasons = results.flatMap((result) =>
          result.status === 'rejected' ? [String(result.reason)] : [],
        );
        throw new Error(`DNS64 resolution failed for ${key}: ${reasons.join('; ') || 'no public IPv6 address'}`);
      }
      cache.set(key, { addresses, expiresAt: Date.now() + cacheTtlMs });
      return addresses;
    })();
    pending.set(key, lookup);
    try {
      return await lookup;
    } finally {
      // Failed lookups are never cached, so the next request can recover.
      pending.delete(key);
    }
  };
}

function connectFirst(addresses, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const failures = [];
    let pending = addresses.length;
    let settled = false;

    const fail = (socket, error) => {
      sockets.delete(socket);
      socket.destroy();
      failures.push(error);
      pending -= 1;
      if (!settled && pending === 0) {
        settled = true;
        reject(new AggregateError(failures, `All ${addresses.length} NAT64 routes failed`));
      }
    };

    for (const address of addresses) {
      const socket = net.connect({ host: address, port, family: 6 });
      sockets.add(socket);
      socket.setTimeout(timeoutMs);
      socket.once('timeout', () => fail(socket, new Error(`Timed out connecting to [${address}]:${port}`)));
      socket.once('error', (error) => fail(socket, error));
      socket.once('connect', () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        socket.setTimeout(0);
        for (const other of sockets) {
          if (other !== socket) other.destroy();
        }
        resolve(socket);
      });
    }
  });
}

export function createNat64Proxy(options = {}) {
  const dns64Servers = options.dns64Servers ?? splitList(
    process.env.OPENPBL_NAT64_DNS_SERVERS,
    DEFAULT_DNS64_SERVERS,
  );
  const allowedHosts = options.allowedHosts ?? splitList(
    process.env.OPENPBL_NAT64_ALLOWED_HOSTS,
    ['api.deepseek.com'],
  );
  const connectTimeoutMs = options.connectTimeoutMs
    ?? Number(process.env.OPENPBL_NAT64_CONNECT_TIMEOUT_MS || 8_000);
  const dnsCacheTtlMs = Number(process.env.OPENPBL_NAT64_DNS_CACHE_TTL_MS || 10_000);
  const resolveDns64 = options.resolveDns64 ?? createDns64Resolver({
    servers: dns64Servers,
    cacheTtlMs: dnsCacheTtlMs,
    timeoutMs: options.dnsTimeoutMs ?? Number(process.env.OPENPBL_NAT64_DNS_TIMEOUT_MS || 2_000),
  });
  const connect = options.connect ?? ((addresses, port) => connectFirst(addresses, port, connectTimeoutMs));

  const openTunnel = async (hostname, port) => {
    if (port !== 443) throw new Error('Only HTTPS port 443 is permitted');
    if (!hostMatchesAllowlist(hostname, allowedHosts)) throw new Error(`Host is not allowed: ${hostname}`);
    const addresses = await resolveDns64(hostname);
    return connect(addresses, port);
  };

  const probe = async (authority = 'api.deepseek.com:443') => {
    const target = parseAuthority(authority);
    if (!target) throw new Error(`Invalid readiness target: ${authority}`);
    const upstream = await openTunnel(target.hostname, target.port);
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        socket: upstream,
        servername: target.hostname,
        rejectUnauthorized: true,
      });
      socket.setTimeout(connectTimeoutMs);
      socket.once('secureConnect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error(`TLS readiness probe timed out for ${authority}`));
      });
      socket.once('error', reject);
    });
  };

  const readinessTarget = process.env.OPENPBL_NAT64_READINESS_TARGET || 'api.deepseek.com:443';
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}\n');
      return;
    }
    if (request.method === 'GET' && request.url === '/health/ready') {
      try {
        await probe(readinessTarget);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ready"}\n');
      } catch (error) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(`${JSON.stringify({ status: 'unavailable', error: String(error) })}\n`);
      }
      return;
    }
    response.writeHead(405, { connection: 'close' });
    response.end();
  });

  server.on('connect', async (request, client, head) => {
    const startedAt = Date.now();
    const target = parseAuthority(request.url);
    let upstream;
    let closeSource;
    let errorCode;
    let connectionErrorCodes;
    let upstreamAddress;
    let established = false;
    const markClose = (source, error) => {
      closeSource ??= source;
      if (error?.code) errorCode ??= error.code;
    };
    const abort = (source, error) => {
      markClose(source, error);
      client.destroy();
      upstream?.destroy();
    };
    // Register before DNS/connect: a caller can cancel while either is pending.
    client.setKeepAlive(true, 30_000);
    client.once('error', (error) => abort('client-error', error));
    client.once('end', () => {
      markClose('client-end');
      if (!established) client.destroy();
    });
    client.once('close', () => {
      markClose('client-close');
      upstream?.destroy();
      const record = {
        target: target ? `${target.hostname}:${target.port}` : 'invalid',
        source: closeSource,
        durationMs: Date.now() - startedAt,
        established,
        upstreamAddress,
        errorCode,
        connectionErrorCodes,
        upstreamBytesRead: upstream?.bytesRead ?? 0,
        upstreamBytesWritten: upstream?.bytesWritten ?? 0,
      };
      (options.log ?? console.log)(`[NAT64Proxy] tunnel closed ${JSON.stringify(record)}`);
    });
    if (!target) {
      markClose('invalid-authority');
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    try {
      upstream = await openTunnel(target.hostname, target.port);
      upstreamAddress = upstream.remoteAddress;
      upstream.once('error', (error) => abort('upstream-error', error));
      upstream.once('end', () => markClose('upstream-end'));
      upstream.once('close', () => {
        // pipe() ends the client after all response bytes have been flushed.
        // Destroying it on normal EOF can truncate a large buffered response.
        if (!upstream.readableEnded) abort('upstream-close');
      });
      if (client.destroyed || client.readableEnded) {
        upstream.destroy();
        return;
      }
      upstream.setKeepAlive(true, 30_000);
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: CoTeach-NAT64\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch (error) {
      markClose('connect-error', error);
      connectionErrorCodes = error?.errors?.map((cause) => cause.code ?? cause.name);
      if (!client.destroyed) {
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    }
  });

  return { server, probe };
}

async function probeRunningProxy(proxyUrl, target) {
  const proxy = new URL(proxyUrl);
  const authority = parseAuthority(target);
  if (!authority) throw new Error(`Invalid target: ${target}`);
  const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
  socket.setTimeout(10_000);
  await new Promise((resolve, reject) => {
    let response = '';
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('timeout', onTimeout);
      socket.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => onError(new Error('Proxy probe timed out'));
    const onData = (chunk) => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      cleanup();
      if (!/^HTTP\/1\.[01] 200\b/.test(response)) {
        reject(new Error(`Proxy CONNECT failed: ${response.split('\r\n', 1)[0]}`));
        socket.destroy();
        return;
      }
      resolve();
    };
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority.hostname}:${authority.port} HTTP/1.1\r\nHost: ${authority.hostname}:${authority.port}\r\n\r\n`);
    });
    socket.on('data', onData);
    socket.once('timeout', onTimeout);
    socket.once('error', onError);
  });
  await new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: authority.hostname, rejectUnauthorized: true });
    secure.setTimeout(10_000);
    secure.once('secureConnect', () => {
      secure.destroy();
      resolve();
    });
    secure.once('timeout', () => reject(new Error('Proxy TLS probe timed out')));
    secure.once('error', reject);
  });
}

async function main() {
  const command = process.argv[2] || 'serve';
  if (command === 'probe') {
    const attempts = Number(process.env.OPENPBL_NAT64_PROBE_ATTEMPTS || 30);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await probeRunningProxy(
          process.env.OPENPBL_OUTBOUND_PROXY || 'http://127.0.0.1:19999',
          process.env.OPENPBL_NAT64_READINESS_TARGET || 'api.deepseek.com:443',
        );
        console.log('[NAT64Proxy] readiness probe passed');
        return;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw lastError;
  }
  if (command !== 'serve') throw new Error(`Unknown command: ${command}`);

  const host = process.env.OPENPBL_NAT64_PROXY_HOST || '127.0.0.1';
  const port = Number(process.env.OPENPBL_NAT64_PROXY_PORT || 19_999);
  const { server } = createNat64Proxy();
  server.listen(port, host, () => {
    console.log(`[NAT64Proxy] listening on http://${host}:${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[NAT64Proxy] fatal:', error);
    process.exit(1);
  });
}
