/** A partial replay can author only later sections that have never spent a
 * request. Existing responses and all upstream stages remain read-only. */
export function isUnrequestedSpokenSectionContinuation(
  replay: { spokenSectionCount?: number }, stage: string, storedAttempt: unknown,
): boolean {
  const count = replay.spokenSectionCount;
  const match = /^spoken-section:(\d+)$/u.exec(stage);
  if (!Number.isInteger(count) || (count ?? 0) < 1 || !match || Number(match[1]) <= count!) return false;
  if (storedAttempt === null || storedAttempt === undefined) return true;
  return typeof storedAttempt === 'object' && !Array.isArray(storedAttempt)
    && 'attemptsStarted' in storedAttempt && storedAttempt.attemptsStarted === 0;
}
