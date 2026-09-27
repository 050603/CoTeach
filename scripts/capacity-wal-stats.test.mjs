import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCapacityWalStats, capacityWalDelta } from './capacity-wal-stats.mjs';
const row = (changes = {}) => ({ sampled_at: new Date('2026-09-27T10:00:00Z'), stats_reset: new Date('2026-09-26T00:00:00Z'), track_wal_io_timing: 'on', wal_records: '100', wal_fpi: '2', wal_bytes: '9007199254740993000', wal_buffers_full: '0', wal_write: '5', wal_sync: '2', wal_write_time: 10, wal_sync_time: 8, ...changes });
const sample = changes => captureCapacityWalStats({ $queryRaw: async () => [row(changes)] });
test('reads only pg_stat_wal and setting with one SELECT, preserving exact large integer counters', async () => {
  let calls = 0;
  const result = await captureCapacityWalStats({ $queryRaw: async sql => { calls++; const text = sql.join('');
    assert.match(text, /^\s*SELECT/); assert.match(text, /FROM pg_stat_wal/); assert.doesNotMatch(text, /ALTER|set_config|RESET|UPDATE/); return [row()]; } });
  assert.equal(calls, 1); assert.equal(result.counters.wal_bytes, '9007199254740993000');
  assert.equal(result.sampledAt, '2026-09-27T10:00:00.000Z'); assert.equal(result.trackWalIoTiming, 'on');
  assert.doesNotThrow(() => JSON.stringify(result));
});
test('computes exact differences and per-write/sync means only for an unchanged reset epoch', async () => {
  const before = await sample(); const after = await sample({ sampled_at: new Date('2026-09-27T10:01:00Z'), wal_bytes: '9007199254740993007', wal_write: '9', wal_sync: '4', wal_write_time: 22, wal_sync_time: 18 });
  const delta = capacityWalDelta(before, after);
  assert.equal(delta.status, 'observed'); assert.equal(delta.elapsedMs, 60000); assert.equal(delta.counters.wal_bytes, '7');
  assert.equal(delta.averages.writeMs, 3); assert.equal(delta.averages.syncMs, 5); assert.match(delta.scope, /not per-request/);
});
test('does not calculate deltas after reset, missing reset, decreased counters or backwards time', async () => {
  const before = await sample();
  for (const changes of [{ stats_reset: new Date('2026-09-27T10:00:10Z') }, { stats_reset: null }, { wal_records: '99' }, { wal_sync_time: 7 }, { sampled_at: new Date('2026-09-27T09:00:00Z') }]) {
    const after = await sample({ sampled_at: new Date('2026-09-27T10:01:00Z'), ...changes });
    const result = capacityWalDelta(before, after); assert.equal(result.status, 'not-verified'); assert.equal(result.counters, undefined); assert.equal(result.averages, undefined);
  }
});
test('does not report zero as a measured mean when timing is disabled or count did not advance', async () => {
  const before = await sample();
  const noOperations = capacityWalDelta(before, await sample({ sampled_at: new Date('2026-09-27T10:01:00Z') }));
  assert.equal(noOperations.averages.writeMs, null); assert.equal(noOperations.averages.syncMs, null);
  const disabled = capacityWalDelta(before, await sample({ sampled_at: new Date('2026-09-27T10:01:00Z'), track_wal_io_timing: 'off', wal_write: '10' }));
  assert.equal(disabled.status, 'observed'); assert.equal(disabled.averages.status, 'not-verified'); assert.equal(disabled.averages.writeMs, null);
});
test('observation errors and malformed rows are diagnostic failures rather than thrown business failures', async () => {
  for (const db of [{ $queryRaw: async () => { throw Object.assign(Error('permission denied'), { code: 'P2010' }); } }, { $queryRaw: async () => [] }, { $queryRaw: async () => [row({ wal_write_time: null })] }]) {
    const observed = await captureCapacityWalStats(db); assert.equal(observed.status, 'not-verified');
    assert.equal(capacityWalDelta(undefined, observed).status, 'not-verified');
  }
});

test('retains sub-millisecond reset identity rather than rounding two resets into one', async () => {
  const before = await sample({ stats_reset: '2026-09-26 00:00:00.000001+00' });
  const after = await sample({ stats_reset: '2026-09-26 00:00:00.000002+00', sampled_at: new Date('2026-09-27T10:01:00Z') });
  assert.equal(before.statsReset, '2026-09-26 00:00:00.000001+00');
  assert.equal(capacityWalDelta(before, after).reason, 'stats-reset-changed');
});
