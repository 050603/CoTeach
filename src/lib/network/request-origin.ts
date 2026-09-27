type OriginHeaders = {
  origin?: string | null;
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
};

function firstHeaderValue(value: string | null | undefined): string {
  return value?.split(",", 1)[0]?.trim() ?? "";
}

export function originFromHost(host: string, protocol: string): string | null {
  if (protocol !== "http" && protocol !== "https") return null;
  if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i.test(host)) return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * Validate browser Origin against both the configured canonical address and
 * the address that actually reached the reverse proxy. The Host comparison
 * keeps migrations and alternate ports working without accepting a genuinely
 * cross-origin request when PUBLIC_BASE_URL is temporarily stale.
 */
export function isAllowedBrowserOrigin(headers: OriginHeaders): boolean {
  const origin = headers.origin?.trim();
  if (!origin) return process.env.NODE_ENV !== "production";

  let actual: string;
  try {
    actual = new URL(origin).origin;
  } catch {
    return false;
  }

  const allowed = new Set<string>();
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    try {
      allowed.add(new URL(configured).origin);
    } catch {
      return false;
    }
  }

  const originProtocol = new URL(actual).protocol.replace(":", "");
  const forwardedProto = firstHeaderValue(headers.forwardedProto) || originProtocol;
  const forwardedHost = firstHeaderValue(headers.forwardedHost);
  const host = firstHeaderValue(headers.host);
  const forwardedOrigin = originFromHost(forwardedHost, forwardedProto);
  const hostOrigin = originFromHost(host, forwardedProto);
  if (forwardedOrigin) allowed.add(forwardedOrigin);
  if (hostOrigin) allowed.add(hostOrigin);

  return allowed.has(actual);
}
