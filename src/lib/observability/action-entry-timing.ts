// Diagnostic metadata only. It never participates in authentication or access.
export const ACTION_PROXY_STARTED_HEADER = "x-openpbl-action-proxy-started";
export const ACTION_PROXY_ENDED_HEADER = "x-openpbl-action-proxy-ended";

export function isActionTimingRequest(method: string, pathname: string): boolean {
  return method === "POST" && /^\/api\/courses\/[^/]+\/actions\/?$/.test(pathname);
}

/** Proxy overwrites both fields for every matched action, including any client
 * supplied values. Epoch time permits comparison across Next runtime contexts.
 */
export function actionEntryTimings(headers: Headers, routeEnteredAt: number): string[] {
  const start = Number(headers.get(ACTION_PROXY_STARTED_HEADER));
  const end = Number(headers.get(ACTION_PROXY_ENDED_HEADER));
  if (!start || !end || !Number.isFinite(start) || !Number.isFinite(end)
    || end < start || routeEnteredAt < end || routeEnteredAt - start > 120_000) return [];
  return [`proxy;dur=${(end - start).toFixed(2)}`, `dispatch;dur=${(routeEnteredAt - end).toFixed(2)}`];
}
