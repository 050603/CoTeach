/** Management readiness is intentionally unavailable through the campus proxy.
 * Student/teacher WebSocket subscription checks still use the campus origin.
 */
export async function capacityLocalReadiness(token, timeout, fetchImpl = fetch) {
  const response = await fetchImpl('http://127.0.0.1:3000/api/health/ready', {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout),
  });
  let body = null;
  try { body = await response.json(); }
  catch { /* Retain the HTTP status when an upstream returns a non-JSON body. */ }
  return { ok: response.ok, status: response.status, body };
}
