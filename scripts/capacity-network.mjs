import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, setGlobalDispatcher } from 'undici';

export function capacityBrowserEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(http|https|all|no)_proxy$/i.test(key)) delete env[key];
  return { ...env, NO_PROXY: '*', no_proxy: '*' };
}

/** Preserve the configured site's Host/TLS identity while connecting only to
 * the local reverse proxy. An explicit LAN URL can replace CAPACITY_BASE_URL.
 */
export function configureCapacityNetwork(origin) {
  const hostname = new URL(origin).hostname;
  const address = process.env.CAPACITY_CONNECT_HOST || (isIP(hostname) ? hostname : '127.0.0.1');
  const family = isIP(address);
  if (!family) throw new Error('CAPACITY_CONNECT_HOST must be an internal IP address');
  const internal = address === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || /^(fc|fd|fe80:)/i.test(address);
  if (!internal) throw new Error('Classroom acceptance is restricted to an internal address');
  const lookup = (name, options, callback) => {
    if (name !== hostname) return dnsLookup(name, options, callback);
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  setGlobalDispatcher(new Agent({ connect: { lookup } }));
  return {
    address,
    lookup,
    browserEnv: capacityBrowserEnvironment(),
    browserArgs: ['--no-proxy-server', ...(isIP(hostname) ? [] : [`--host-resolver-rules=MAP ${hostname} ${address}`])],
  };
}
