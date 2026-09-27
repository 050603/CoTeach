/** Serialize only an HTTP(S) request origin, never arbitrary CSP tokens. */
export function requestCspOrigin(requestUrl: string, host: string | null, forwardedProto: string | null): string | undefined {
  try {
    const request = new URL(requestUrl);
    const protocol = forwardedProto?.split(',', 1)[0].trim().toLowerCase() || request.protocol.slice(0, -1);
    return originFromHost(host || request.host, protocol) ?? undefined;
  } catch { return undefined; }
}

export function contentSecurityPolicy(origin?: string, development = process.env.NODE_ENV === 'development'): string {
  // WebKit treats sandboxed srcdoc fetches as opaque-origin requests. 'self'
  // alone does not permit the parent's runtime files there; add this response's
  // concrete origin while keeping the iframe sandbox and external-source ban.
  const explicitOrigin = origin ? requestCspOrigin(origin, null, null) : undefined;
  return [
    "default-src 'self'",
    development ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'" : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    ["connect-src 'self' data: wss:", ...(development ? ['https: ws:'] : []), ...(explicitOrigin ? [explicitOrigin] : [])].join(' '),
    "frame-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
import { originFromHost } from '../network/request-origin';
