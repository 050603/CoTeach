/**
 * Proxy-aware fetch for server-side use.
 *
 * Automatically routes requests through HTTP/HTTPS proxy when
 * the standard environment variables are set:
 *   - OPENPBL_OUTBOUND_PROXY (preferred, scoped to explicit proxyFetch calls)
 *   - https_proxy / HTTPS_PROXY
 *   - http_proxy / HTTP_PROXY
 *
 * Requests are sent directly (bypassing the proxy) when:
 *   - the target host is a loopback address (localhost, 127.0.0.0/8, ::1) —
 *     routing loopback through an external proxy resolves to the *proxy's*
 *     localhost, which is never what the caller means; or
 *   - the target host matches the standard no_proxy / NO_PROXY env var
 *     (comma-separated hosts, `*` wildcard, optional `:port`, and
 *     domain-suffix matching à la curl: `example.com` also matches
 *     `api.example.com`).
 *
 * Node.js's built-in fetch does NOT respect these env vars,
 * so we use undici's ProxyAgent when a proxy is configured.
 *
 * Usage: import { proxyFetch } from '@openmaic/lib/server/proxy-fetch';
 *        const res = await proxyFetch('https://api.openai.com/v1/...', { ... });
 */

import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { createLogger } from '@openmaic/lib/logger';

const log = createLogger('ProxyFetch');

import { resolveProxyUrl, shouldBypassProxy } from '@/lib/network/proxy-routing';
export { resolveProxyUrl, shouldBypassProxy } from '@/lib/network/proxy-routing';

let cachedAgent: ProxyAgent | null = null;
let cachedProxyUrl: string | undefined;

function getProxyAgent(proxyUrl: string | undefined): ProxyAgent | undefined {
  if (!proxyUrl) return undefined;

  // Reuse agent if proxy URL hasn't changed
  if (cachedAgent && cachedProxyUrl === proxyUrl) {
    return cachedAgent;
  }

  const previousAgent = cachedAgent;
  cachedAgent = new ProxyAgent({ uri: proxyUrl, pipelining: 0 });
  // Drain active responses when settings change; do not strand old pools.
  if (previousAgent) void previousAgent.close().catch(() => {});
  cachedProxyUrl = proxyUrl;
  return cachedAgent;
}

/**
 * Drop-in replacement for fetch() that respects proxy env vars.
 * Falls back to global fetch when no proxy is configured, when the target
 * is a loopback address, or when the target matches no_proxy / NO_PROXY.
 */
export async function proxyFetch(
  input: string | URL | Request,
  init?: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let parsed: URL | undefined;
  try { parsed = new URL(url); } catch { /* fetch reports invalid URLs */ }
  // Decide bypass before constructing an agent: a broken proxy setting must
  // not prevent local Ollama, speech or other on-host services from working.
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || shouldBypassProxy(parsed)) {
    return fetch(input, init);
  }
  const agent = getProxyAgent(proxyUrl?.trim() || resolveProxyUrl());
  if (!agent) return fetch(input, init);

  // Never log signed URL queries, request paths, or proxy credentials.
  log.debug('Using configured proxy for:', parsed.origin);
  // SDKs may supply a native Request, which is not an instance of the external
  // Undici package's Request. Preserve its options while crossing that boundary.
  const requestOptions: UndiciRequestInit = typeof input !== 'string' && !(input instanceof URL)
    ? {
        method: input.method, headers: input.headers,
        body: input.body, signal: input.signal, redirect: input.redirect,
        credentials: input.credentials, cache: input.cache, integrity: input.integrity,
        keepalive: input.keepalive, mode: input.mode, referrer: input.referrer,
        referrerPolicy: input.referrerPolicy, duplex: 'half',
      } as UndiciRequestInit
    : {};
  const res = await undiciFetch(url, {
    ...requestOptions,
    ...(init as UndiciRequestInit),
    dispatcher: agent,
  });
  return res as unknown as Response;
}
