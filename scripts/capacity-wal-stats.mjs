const counters = ['wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full', 'wal_write', 'wal_sync'];
const timings = ['wal_write_time', 'wal_sync_time'];
const scope = 'whole PostgreSQL instance, including backup and background traffic; not per-request latency or P95; never add to HTTP latency gates';
const unverified = reason => ({ status: 'not-verified', reason, scope });
function timestamp(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw Error('Invalid WAL sample timestamp');
  return date.toISOString();
}
function normalize(row) {
  if (!row) throw Error('pg_stat_wal returned no row');
  const result = { status: 'observed', sampledAt: timestamp(row.sampled_at), statsReset: typeof row.stats_reset === 'string' ? row.stats_reset : timestamp(row.stats_reset), trackWalIoTiming: row.track_wal_io_timing, counters: {}, timingMs: {}, scope };
  if (!result.sampledAt || !['on', 'off'].includes(result.trackWalIoTiming)) throw Error('Incomplete WAL observation');
  for (const key of counters) {
    if (typeof row[key] !== 'string' || !/^\d+$/.test(row[key])) throw Error(`Invalid WAL counter: ${key}`);
    result.counters[key] = row[key]; // Exact bigint/numeric values remain JSON-safe decimal strings.
  }
  for (const key of timings) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error(`Invalid WAL timing: ${key}`);
    result.timingMs[key] = value;
  }
  return result;
}

/** Two independent SELECTs in the runner; no configuration writes or resets. */
export async function captureCapacityWalStats(db) {
  const attemptedAt = new Date().toISOString();
  try {
    const rows = await db.$queryRaw`
      SELECT clock_timestamp() AS sampled_at, stats_reset::text,
        current_setting('track_wal_io_timing') AS track_wal_io_timing,
        wal_records::text, wal_fpi::text, wal_bytes::text, wal_buffers_full::text,
        wal_write::text, wal_sync::text, wal_write_time, wal_sync_time
      FROM pg_stat_wal`;
    return normalize(rows[0]);
  } catch (error) {
    // Optional diagnostics must not replace the original business outcome.
    return { ...unverified('observation-failed'), attemptedAt, error: { name: error?.name ?? 'Error', code: error?.code ?? null } };
  }
}

export function capacityWalDelta(before, after) {
  if (before?.status !== 'observed' || after?.status !== 'observed') return unverified('missing-observation');
  try {
    if (!before.statsReset || !after.statsReset) return unverified('missing-stats-reset');
    if (before.statsReset !== after.statsReset) return unverified('stats-reset-changed');
    const elapsedMs = Date.parse(after.sampledAt) - Date.parse(before.sampledAt);
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return unverified('nonpositive-sample-interval');
    const delta = { counters: {}, timingMs: {} };
    for (const key of counters) {
      if (!/^\d+$/.test(before.counters[key]) || !/^\d+$/.test(after.counters[key])) return unverified('invalid-counter');
      const value = BigInt(after.counters[key]) - BigInt(before.counters[key]);
      if (value < 0) return unverified(`counter-decreased:${key}`);
      delta.counters[key] = String(value);
    }
    for (const key of timings) {
      const value = after.timingMs[key] - before.timingMs[key];
      if (!Number.isFinite(value) || value < 0) return unverified(`counter-decreased-or-invalid:${key}`);
      delta.timingMs[key] = value;
    }
    const measured = before.trackWalIoTiming === 'on' && after.trackWalIoTiming === 'on';
    const average = (time, count) => measured && BigInt(count) > BigInt(0) ? time / Number(count) : null;
    return { status: 'observed', scope, elapsedMs, statsReset: before.statsReset, ...delta,
      averages: { status: measured ? 'observed' : 'not-verified', reason: measured ? 'per-operation means; null where count is zero' : 'track_wal_io_timing-not-on-at-both-snapshots',
        writeMs: average(delta.timingMs.wal_write_time, delta.counters.wal_write), syncMs: average(delta.timingMs.wal_sync_time, delta.counters.wal_sync) },
      limitations: ['Counters can lag active work until backends flush statistics.', 'Settings are observed only at endpoints; intermediate or per-session setting changes are not proven absent.', 'Includes all concurrent PostgreSQL-instance traffic, not only this fixture.'],
    };
  } catch { return unverified('invalid-observation'); }
}
