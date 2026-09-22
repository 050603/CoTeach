/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Validates URLs to prevent requests to internal/private network addresses.
 * Used by any API route that fetches a user-supplied URL server-side.
 */
import { promises as dns } from 'node:dns';
import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { connect as connectTls, checkServerIdentity } from 'node:tls';
import { Agent, type buildConnector } from 'undici';

function normalizeAddress(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.+$/, '');
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number.parseInt(part, 10);
  });

  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function extractMappedIPv4(ip: string): string | null {
  const normalized = normalizeAddress(ip);
  if (!normalized.startsWith('::ffff:')) {
    return null;
  }

  const suffix = normalized.slice('::ffff:'.length);
  const dottedIPv4 = parseIPv4(suffix);
  if (dottedIPv4) {
    return dottedIPv4.join('.');
  }

  const parts = suffix.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  const [high, low] = parts.map((part) => Number.parseInt(part, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function getFirstIPv6Hextet(ip: string): number | null {
  const normalized = normalizeAddress(ip);
  if (!normalized.includes(':')) {
    return null;
  }

  if (normalized.startsWith('::')) {
    return 0;
  }

  const [firstHextet] = normalized.split(':');
  if (!firstHextet || !/^[0-9a-f]{1,4}$/.test(firstHextet)) {
    return null;
  }

  return Number.parseInt(firstHextet, 16);
}

/** Expand an IPv6 address into 8 numeric hextets. Returns null for invalid input. */
function expandIPv6(ip: string): number[] | null {
  let normalized = normalizeAddress(ip);
  if (!normalized.includes(':')) return null;

  // Convert a dotted IPv4 suffix into the final two IPv6 hextets.
  const lastPart = normalized.split(':').pop() || '';
  if (lastPart.includes('.')) {
    const dottedIPv4 = parseIPv4(lastPart);
    if (!dottedIPv4) return null;
    const high = ((dottedIPv4[0] << 8) | dottedIPv4[1]).toString(16);
    const low = ((dottedIPv4[2] << 8) | dottedIPv4[3]).toString(16);
    normalized = `${normalized.slice(0, -lastPart.length)}${high}:${low}`;
  }

  const sides = normalized.split('::');
  if (sides.length > 2) return null;

  let parts: string[];
  if (sides.length === 2) {
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    // `::` must compress at least one hextet.
    if (missing <= 0) return null;
    parts = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    parts = normalized.split(':');
  }

  if (parts.length !== 8) return null;
  if (parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;

  return parts.map((p) => Number.parseInt(p, 16));
}

export function isPrivateIP(ip: string): boolean {
  const normalized = normalizeAddress(ip);
  const mappedIPv4 = extractMappedIPv4(normalized);
  if (mappedIPv4) {
    return isPrivateIP(mappedIPv4);
  }

  const ipv4 = parseIPv4(normalized);
  if (ipv4) {
    const [first, second, third, fourth] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224 ||
      (first === 0 && second === 0 && third === 0 && fourth === 0)
    );
  }

  const ipv6FirstHextet = getFirstIPv6Hextet(normalized);
  if (ipv6FirstHextet === null) {
    return false;
  }

  if (normalized === '::' || normalized === '::1') {
    return true;
  }

  if (
    (ipv6FirstHextet & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (ipv6FirstHextet & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (ipv6FirstHextet & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (ipv6FirstHextet & 0xff00) === 0xff00 || // ff00::/8 multicast
    normalized.startsWith('2001:db8:') // documentation range
  ) {
    return true;
  }

  // 6to4 tunnel: 2002::/16 — embedded IPv4 sits in bits 16-47
  if (ipv6FirstHextet === 0x2002) {
    const hextets = expandIPv6(normalized);
    if (hextets) {
      const embedded = `${hextets[1] >> 8}.${hextets[1] & 0xff}.${hextets[2] >> 8}.${hextets[2] & 0xff}`;
      if (isPrivateIP(embedded)) return true;
    }
  }

  // Teredo tunnel: 2001:0000::/32 — client IPv4 in last 32 bits, XOR-inverted
  if (ipv6FirstHextet === 0x2001) {
    const hextets = expandIPv6(normalized);
    if (hextets && hextets[1] === 0x0000) {
      const high = hextets[6] ^ 0xffff;
      const low = hextets[7] ^ 0xffff;
      const embedded = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      if (isPrivateIP(embedded)) return true;
    }
  }

  // ISATAP: interface identifier 0000:5efe:V4ADDR or 0200:5efe:V4ADDR.
  // Only classify the address as private when the embedded IPv4 endpoint is private.
  const hextets = expandIPv6(normalized);
  if (
    hextets &&
    (hextets[4] === 0x0000 || hextets[4] === 0x0200) &&
    hextets[5] === 0x5efe
  ) {
    const embedded = `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
    if (isPrivateIP(embedded)) return true;
  }

  return false;
}

const LOCAL_NETWORK_BLOCK_MESSAGE =
  'Local/private network URLs are not allowed. If this is a self-hosted deployment or internal gateway (including split-horizon DNS), set ALLOW_LOCAL_NETWORKS=true to allow local network targets.';

/**
 * Validate a URL against SSRF attacks.
 * Returns null if the URL is safe, or an error message string if blocked.
 */
export async function validateUrlForSSRF(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only HTTP(S) URLs are allowed';
  }

  // Self-hosted deployments can set ALLOW_LOCAL_NETWORKS=true to skip private-IP checks
  const allowLocal = process.env.ALLOW_LOCAL_NETWORKS;
  if (allowLocal === 'true' || allowLocal === '1') {
    return null;
  }

  const hostname = normalizeAddress(parsed.hostname);
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    isPrivateIP(hostname)
  ) {
    return LOCAL_NETWORK_BLOCK_MESSAGE;
  }

  if (isIP(hostname)) {
    return null;
  }

  let resolvedAddresses: Array<{ address: string; family: number }>;
  try {
    resolvedAddresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return 'Unable to verify hostname safety';
  }

  if (resolvedAddresses.length === 0) {
    return 'Unable to verify hostname safety';
  }

  if (resolvedAddresses.some(({ address }) => isPrivateIP(address))) {
    return LOCAL_NETWORK_BLOCK_MESSAGE;
  }

  return null;
}

/** Only operator-supplied /96 networks may translate already validated IPv4. */
function configuredNat64Prefixes(): string[] {
  const entries = process.env.OPENPBL_NAT64_PREFIXES?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
  return Array.from(new Set(entries.map((entry) => {
    const [address, length, extra] = entry.split('/');
    const parts = expandIPv6(address);
    if (length !== '96' || extra !== undefined || isIP(address) !== 6 || !parts
      || parts[6] !== 0 || parts[7] !== 0 || isPrivateIP(address)
      || (parts[0] & 0xe000) !== 0x2000) {
      throw new Error('OPENPBL_NAT64_PREFIXES must contain public IPv6 /96 networks');
    }
    return parts.slice(0, 6).map((part) => part.toString(16)).join(':');
  })));
}

function createPinnedConnector(hostname: string, candidates: string[]) {
  const pending = new Set<() => void>();
  let disposed = false;
  const connect: buildConnector.connector = (options, callback) => {
    if (disposed || normalizeAddress(options.hostname) !== hostname) {
      callback(new Error('Media connection target changed or connection closed'), null);
      return;
    }
    const sockets = new Set<Socket>();
    const failures: Error[] = [];
    let settled = false;
    let remaining = candidates.length;
    const finish = (error: Error | null, winner?: Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(abort);
      for (const socket of sockets) if (socket !== winner) socket.destroy();
      if (error) callback(error, null);
      else callback(null, winner!);
    };
    const abort = () => finish(new Error('Media connection closed'));
    const timer = setTimeout(() => finish(new Error('Media connection timed out')), 8_000);
    pending.add(abort);
    for (const address of candidates) {
      const secure = options.protocol === 'https:';
      const port = Number(options.port || (secure ? 443 : 80));
      const onFailure = (error: Error) => {
        failures.push(error);
        remaining -= 1;
        if (remaining === 0) finish(new AggregateError(failures, 'All pinned media routes failed'));
      };
      try {
        const socket = secure ? connectTls({
          host: address,
          port,
          // Routing uses the pinned IP, while TLS authenticates the URL identity.
          servername: isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
          ALPNProtocols: ['http/1.1'],
        }) : connectTcp({ host: address, port });
        sockets.add(socket);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        socket.once('error', onFailure);
        socket.once(secure ? 'secureConnect' : 'connect', () => finish(null, socket));
      } catch (error) {
        onFailure(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
  return {
    connect,
    dispose: () => {
      disposed = true;
      for (const abort of pending) abort();
    },
  };
}

/**
 * Resolve once, validate every result, then pin the outbound connection to a
 * validated address. This closes the DNS-rebinding gap between validation and
 * the actual socket connection.
 */
export async function createSsrfSafeDispatcher(
  rawUrl: string,
): Promise<{ dispatcher: Agent; close: () => Promise<void> }> {
  const error = await validateUrlForSSRF(rawUrl);
  if (error) throw new Error(error);

  const parsed = new URL(rawUrl);
  const hostname = normalizeAddress(parsed.hostname);
  const directFamily = isIP(hostname);
  const resolved = directFamily
    ? [{ address: hostname, family: directFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0 || resolved.some(({ address }) => isPrivateIP(address))) {
    throw new Error(LOCAL_NETWORK_BLOCK_MESSAGE);
  }
  const prefixes = configuredNat64Prefixes();
  if (prefixes.length > 0) {
    for (const { address, family } of resolved) {
      if (family !== 6) continue;
      const parts = expandIPv6(address)!;
      if (prefixes.includes(parts.slice(0, 6).map((part) => part.toString(16)).join(':'))) {
        const embedded = `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`;
        if (isPrivateIP(embedded)) throw new Error(LOCAL_NETWORK_BLOCK_MESSAGE);
      }
    }
    const candidates = Array.from(new Set(resolved.flatMap(({ address, family }) => {
      if (family === 6) return [address];
      const [a, b, c, d] = parseIPv4(address)!;
      const suffix = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
      return prefixes.map((prefix) => `${prefix}:${suffix}`);
    })));
    const connector = createPinnedConnector(hostname, candidates);
    const dispatcher = new Agent({ connect: connector.connect });
    return {
      dispatcher,
      close: async () => {
        connector.dispose();
        await dispatcher.destroy();
      },
    };
  }
  const selected = resolved[0];
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, _options, callback) => {
        callback(null, selected.address, selected.family);
      },
    },
  });
  return {
    dispatcher,
    close: async () => {
      await dispatcher.destroy();
    },
  };
}
