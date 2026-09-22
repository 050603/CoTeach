// Pure routing rules shared by server transports; no Node-only imports.
export function resolveProxyUrl(
  environment: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): string | undefined {
  return (
    environment.OPENPBL_OUTBOUND_PROXY?.trim() ||
    environment.https_proxy?.trim() ||
    environment.HTTPS_PROXY?.trim() ||
    environment.http_proxy?.trim() ||
    environment.HTTP_PROXY?.trim() ||
    undefined
  );
}

function getNoProxyEntries(): string[] {
  const environment: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env;
  const raw = environment.no_proxy || environment.NO_PROXY || '';
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // Accept both bare IPv6 and URL.hostname's bracketed form.
  if (host === '::1' || host === '[::1]') return true;
  return /^127(\.\d{1,3}){3}$/.test(host);
}

function matchesNoProxyEntry(hostname: string, port: string, entry: string): boolean {
  if (entry === '*') return true;

  let entryHost = entry;
  let entryPort = '';
  // Split a trailing `:port`. Skip IPv6 literals (multiple colons).
  const colonIndex = entry.lastIndexOf(':');
  if (colonIndex !== -1 && entry.indexOf(':') === colonIndex) {
    entryHost = entry.slice(0, colonIndex);
    entryPort = entry.slice(colonIndex + 1);
  }
  if (entryPort && entryPort !== port) return false;

  // A leading dot (`.example.com`) means the same as `example.com`:
  // match the host itself and any subdomain.
  entryHost = entryHost.replace(/^\./, '');
  if (!entryHost) return false;
  return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
}

/**
 * Whether a request to `url` should skip the configured proxy.
 * Exported for tests.
 */
export function shouldBypassProxy(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (isLoopbackHost(hostname)) return true;

  const entries = getNoProxyEntries();
  if (entries.length === 0) return false;

  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return entries.some((entry) => matchesNoProxyEntry(hostname, port, entry));
}
