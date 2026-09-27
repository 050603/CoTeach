import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Gauge } from 'prom-client';
import { prisma } from '@/lib/db/client';
import { readAiAuditOutboxCounts } from '@/lib/ai-collaboration/audit-outbox';
import { classroomAiCapacitySnapshot } from '@/lib/llm/classroom-capacity';
import { register, getOrCreateRegisteredMetric } from './metrics';

const gauge = (name: string, help: string) => getOrCreateRegisteredMetric(register, name,
  () => new Gauge({ name, help }));
const connections = gauge('openpbl_postgres_connections', 'Current database connections.');
const limit = gauge('openpbl_postgres_connection_limit', 'Configured database connection limit.');
const waiting = gauge('openpbl_postgres_lock_waiters', 'Connections waiting for a database lock.');
const activeAi = gauge('openpbl_classroom_ai_active', 'Active classroom model calls.');
const pendingAi = gauge('openpbl_classroom_ai_pending', 'Interactive model calls waiting for capacity.');
const pendingAudit = gauge('openpbl_ai_audit_outbox_pending', 'Durable audit batches awaiting database replay.');
const quarantinedAudit = gauge('openpbl_ai_audit_outbox_quarantined', 'Invalid audit batches preserved for investigation and repair.');
const backupAt = gauge('openpbl_local_backup_checkpoint_timestamp_seconds', 'Latest recoverable local database/files checkpoint.');

export async function refreshClassroomHealthMetrics(): Promise<void> {
  const ai = classroomAiCapacitySnapshot();
  activeAi.set(ai.active); pendingAi.set(ai.pending);
  const [database, backup, outbox] = await Promise.allSettled([
    prisma.$queryRaw<Array<{ connections: bigint; waiting: bigint; max: number }>>`
      SELECT count(*) AS connections,
        count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting,
        current_setting('max_connections')::int AS max
      FROM pg_stat_activity`,
    readFile(process.env.LOCAL_BACKUP_STATUS_FILE || path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', '../local-backup/status/last-success.json'), 'utf8'),
    readAiAuditOutboxCounts(),
  ]);
  pendingAudit.set(outbox.status === 'fulfilled' ? outbox.value.pending : Number.NaN);
  quarantinedAudit.set(outbox.status === 'fulfilled' ? outbox.value.quarantined : Number.NaN);
  if (database.status === 'fulfilled' && database.value[0]) {
    const row = database.value[0];
    connections.set(Number(row.connections)); waiting.set(Number(row.waiting)); limit.set(row.max);
  } else { connections.set(Number.NaN); waiting.set(Number.NaN); }
  if (backup.status === 'fulfilled') {
    try {
      const status = JSON.parse(backup.value);
      backupAt.set(Number(status.startedEpoch) || 0);
    } catch { backupAt.set(0); }
  } else backupAt.set(0);
}
