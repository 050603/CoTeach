import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, Client, Pool, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

export function capacityBrowserEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(http|https|all|no)_proxy$/i.test(key)) delete env[key];
  return { ...env, NO_PROXY: '*', no_proxy: '*' };
}

/** Preserve the configured site's Host/TLS identity while connecting only to
 * the local reverse proxy. An explicit LAN URL can replace CAPACITY_BASE_URL.
 */
export function configureCapacityNetwork(origin) {
  const transportMode = process.env.CAPACITY_TRANSPORT_MODE || 'shared';
  if (!['shared', 'isolated'].includes(transportMode)) throw new Error('CAPACITY_TRANSPORT_MODE must be shared or isolated');
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
  const previousDispatcher = getGlobalDispatcher();
  const agents = new Set();
  const pools = new Set();
  const createAgent = () => {
    // Keep the original connection, pipelining and TLS defaults. Isolation only
    // changes which actor may reuse a connection, not the request schedule.
    const agent = new Agent({ connect: { lookup }, factory(origin, options) {
      // This is Undici's default factory, retaining child dispatchers solely so
      // timed-out shutdown can destroy them after Agent.close clears its map.
      const pool = options?.connections === 1 ? new Client(origin, options) : new Pool(origin, options);
      pools.add(pool);
      return pool;
    } });
    agents.add(agent);
    return agent;
  };
  const fallback = createAgent();
  const actorAgents = new WeakMap();
  let closing;
  const dispatcherForActor = actor => {
    if (closing) throw new Error('Capacity network is closed');
    if (transportMode === 'shared' || actor == null) return fallback;
    if (typeof actor !== 'object' && typeof actor !== 'function') throw new TypeError('Capacity actor must be an object');
    let agent = actorAgents.get(actor);
    if (!agent) { agent = createAgent(); actorAgents.set(actor, agent); }
    return agent;
  };
  setGlobalDispatcher(fallback);
  return {
    address,
    lookup,
    transportMode,
    dispatcherForActor,
    close() {
      closing ??= (async () => {
        let timer;
        try {
          // Normally all work has drained. Bound shutdown as well when a
          // failed request left an unread response or a hanging connection.
          await Promise.race([
            Promise.allSettled([...agents].map(agent => agent.close())),
            new Promise(resolve => { timer = setTimeout(resolve, 5000); }),
          ]);
        } finally {
          clearTimeout(timer);
          await Promise.allSettled([...pools, ...agents].map(dispatcher => dispatcher.destroy()));
          if (getGlobalDispatcher() === fallback) setGlobalDispatcher(previousDispatcher);
        }
      })();
      return closing;
    },
    browserEnv: capacityBrowserEnvironment(),
    browserArgs: ['--no-proxy-server', ...(isIP(hostname) ? [] : [`--host-resolver-rules=MAP ${hostname} ${address}`])],
  };
}
