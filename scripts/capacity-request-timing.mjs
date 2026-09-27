/** Pair phases with their own request; nested service phases are not additive
 * with handler. Missing outer measurements must not become a zero-duration gap.
 */
export function pairCapacityRequestTiming({ category, requestId, elapsedMs, serverTiming }) {
  const phases = {};
  for (const part of (serverTiming ?? '').split(',')) {
    const match = part.trim().match(/^([a-z]+);dur=([0-9.]+)$/);
    if (match && Number.isFinite(Number(match[2]))) phases[match[1]] = Number(match[2]);
  }
  const { proxy, dispatch, handler } = phases;
  return { category, requestId, elapsedMs, phases,
    ...(proxy !== undefined && dispatch !== undefined && handler !== undefined
      ? { outsideMeasuredMs: elapsedMs - proxy - dispatch - handler } : {}) };
}
