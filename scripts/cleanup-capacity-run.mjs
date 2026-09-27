/** Remove only terminal, UUID-owned capacity fixtures. Defaults to a dry run. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, unlink, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const runPattern = new RegExp(`^capacity-${uuid}$`);
const identifier = (value) => { assert.match(value, /^[A-Za-z_][A-Za-z_0-9]*$/); return `"${value}"`; };

export function fixturePolicy(report, kind = 'classroom-capacity') {
  assert.match(report.runId, runPattern, 'Report must identify one capacity UUID');
  assert.ok(['classroom-capacity', 'projection-contention'].includes(kind), 'Unknown cleanup fixture kind');
  if (report.kind !== undefined) assert.equal(report.kind, kind, 'Report kind disagrees with explicit cleanup kind');
  return { kind, title: `${kind === 'projection-contention' ? '投屏混合验收' : '并发验收'} ${report.runId}`,
    classroomId: `${report.runId}-${kind === 'projection-contention' ? 'projection-load' : 'lesson'}` };
}

export function validateReport(report, abortedRun, kind = 'classroom-capacity') {
  const policy = fixturePolicy(report, kind);
  if (kind === 'projection-contention') {
    // Historical probe reports have no kind field. Never infer their identity
    // from a loose prefix: callers must explicitly opt into this fixture type.
    assert.equal(abortedRun, report.runId, 'Projection cleanup requires --abort-run with the complete run ID');
    assert.ok(['failed', 'latency-failed', 'measured'].includes(report.outcome), 'Projection report must be terminal');
    assert.equal(report.origin, 'https://coteach.cn', 'Unexpected projection probe origin');
    assert.ok(typeof report.startedAt === 'string' && typeof report.finishedAt === 'string'
      && Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt))
      && new Date(report.startedAt).toISOString() === report.startedAt && new Date(report.finishedAt).toISOString() === report.finishedAt
      && Date.parse(report.finishedAt) >= Date.parse(report.startedAt), 'Projection report requires a valid finishedAt');
    assert.ok(Number.isInteger(report.rounds) && report.rounds >= 2 && report.rounds <= 60);
    const originalProbe = report.heartbeats === undefined && report.includeState === undefined && report.modes === undefined
      && report.workload === 'real HTTP/42 WebSocket receivers; no mocked API; artificial same-tick quiz/progress/draft burst';
    if (!originalProbe) assert.equal(typeof report.heartbeats, 'boolean');
    if (report.includeState !== undefined) assert.equal(typeof report.includeState, 'boolean');
    if (report.modes !== undefined) assert.ok(Array.isArray(report.modes) && report.modes.length > 0
      && new Set(report.modes).size === report.modes.length && report.modes.every(mode => ['draft', 'mixed'].includes(mode)));
    const workload = `real HTTP/42 WebSocket receivers; no mocked API; practice=40 draft${report.includeState !== false ? '+40 state' : ''}${report.heartbeats ? '+40 heartbeat' : ''}; extra cross-stage stress=those plus40 quiz+40 progress`;
    assert.ok(report.workload === workload || originalProbe, 'Unknown projection probe workload manifest');
    for (const field of ['batches', 'databaseWaitSamples', 'errors']) assert.ok(Array.isArray(report[field]), `Missing projection ${field}`);
    assert.ok(report.fixture && typeof report.fixture === 'object', 'Projection fixture manifest is required');
    for (const field of ['offeringId', 'templateId', 'instanceId', 'activityId', 'chapterId']) {
      assert.match(report.fixture[field], new RegExp(`^${uuid}$`), `Invalid projection fixture ${field}`);
    }
    assert.equal(report.fixture.classroomId, policy.classroomId);
    assert.ok(Array.isArray(report.fixture.userIds) && report.fixture.userIds.length === 42, 'Projection fixture requires all 42 user IDs');
  } else {
    const reconciled = report.outcome === 'passed' && report.checks?.some(
      (check) => check.name === 'per-student-database-file-reconciliation' && check.status === '通过');
    const aborted = abortedRun === report.runId && ['failed', 'partial'].includes(report.outcome);
    assert.ok(reconciled || aborted, 'Require successful reconciliation or --abort-run matching a failed/partial terminal report');
    if (report.fixture?.classroomId) assert.equal(report.fixture.classroomId, policy.classroomId);
  }
  for (const id of report.fixture?.userIds ?? []) assert.match(id, new RegExp(`^${uuid}$`));
  if (report.fixture?.userIds) assert.equal(new Set(report.fixture.userIds).size, report.fixture.userIds.length, 'Duplicate fixture user IDs');
  return policy;
}

export function validateUsers(runId, users, kind = 'classroom-capacity', manifestUserIds) {
  fixturePolicy({ runId }, kind);
  const projection = kind === 'projection-contention';
  if (projection) assert.ok(Array.isArray(manifestUserIds) && manifestUserIds.length === 42, 'Projection user ownership requires its complete manifest');
  const namePattern = new RegExp(`^${runId}-${projection ? 'projection-([0-9]|[1-3][0-9]|4[01])' : '[0-9]+'}$`);
  for (const user of users) {
    assert.match(user.username, namePattern, 'Refusing a user outside the exact run prefix');
    assert.equal(user.usernameKey, user.username);
    if (projection) {
      const index = Number(user.username.match(namePattern)[1]);
      assert.equal(typeof user.id, 'string', 'Projection user ID is required');
      assert.equal(user.id, manifestUserIds?.[index], 'Projection user ID disagrees with its manifest index');
      assert.equal(user.role, index < 2 ? 'TEACHER' : 'STUDENT', 'Projection user role disagrees with its fixture index');
    }
  }
}

export function validateProjectionRecords(report, { offerings, templates, chapter, activity, instance }) {
  const { title, classroomId } = fixturePolicy(report, 'projection-contention');
  const fixture = report.fixture;
  for (const offering of offerings) {
    assert.equal(offering.id, fixture.offeringId); assert.equal(offering.name, title); assert.equal(offering.description, report.runId);
  }
  for (const template of templates) {
    assert.equal(template.id, fixture.templateId); assert.equal(template.title, title); assert.equal(template.ownerId, fixture.userIds[0]);
  }
  if (chapter) {
    assert.equal(chapter.id, fixture.chapterId); assert.equal(chapter.offeringId, fixture.offeringId);
    assert.equal(chapter.title, '独立混合锁验收'); assert.equal(chapter.position, 0);
  }
  if (activity) {
    assert.equal(activity.id, fixture.activityId); assert.equal(activity.chapterId, fixture.chapterId);
    assert.equal(activity.title, title); assert.equal(activity.type, 'CLASSROOM'); assert.equal(activity.position, 0);
  }
  if (instance) {
    assert.equal(instance.id, fixture.instanceId); assert.equal(instance.activityId, fixture.activityId);
    assert.equal(instance.templateVersion.templateId, fixture.templateId);
    assert.equal(instance.templateVersion.snapshot?.design?.aiLearningClassroomId, classroomId);
  }
}

export function validateOwnedProjectionRoots(report, owned) {
  for (const [table, field] of [
    ['CourseOffering', 'offeringId'], ['ClassroomTemplate', 'templateId'], ['ClassroomInstance', 'instanceId'], ['Chapter', 'chapterId'], ['Activity', 'activityId'],
  ]) assert.ok([...(owned.get(table) ?? [])].every(id => id === report.fixture[field]), `Unexpected projection ${table}`);
  assert.ok([...(owned.get('User') ?? [])].every(id => report.fixture.userIds.includes(id)), 'Unexpected projection User');
}

export function deletionOrder(owned, edges) {
  const remaining = new Set([...owned].filter(([, ids]) => ids.size).map(([table]) => table));
  const result = [];
  while (remaining.size) {
    const leaves = [...remaining].filter((table) => !edges.some(
      (edge) => edge.parent === table && edge.child !== table && remaining.has(edge.child)));
    assert.ok(leaves.length, 'Cyclic fixture dependencies require manual inspection; no records deleted');
    for (const table of leaves) { remaining.delete(table); result.push(table); }
  }
  return result;
}

async function planAndDelete(tx, report, execute, kind) {
  const runId = report.runId;
  const policy = fixturePolicy(report, kind);
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', runId);
  const users = await tx.user.findMany({ where: { username: { startsWith: `${runId}-` } }, select: { id: true, username: true, usernameKey: true, role: true } });
  validateUsers(runId, users, kind, report.fixture?.userIds);
  const userIds = users.map((user) => user.id);
  if (report.fixture?.userIds) {
    assert.ok(userIds.every((id) => report.fixture.userIds.includes(id)), 'Run users disagree with fixture manifest');
    // Missing IDs are allowed only for idempotent cleanup; an existing ID must
    // always still belong to this run, even when its username was changed.
    const manifestUsers = await tx.user.findMany({ where: { id: { in: report.fixture.userIds } }, select: { id: true, username: true, usernameKey: true, role: true } });
    validateUsers(runId, manifestUsers, kind, report.fixture.userIds);
  }
  const offerings = await tx.courseOffering.findMany({ where: { description: runId }, select: { id: true, name: true, description: true } });
  const templates = await tx.classroomTemplate.findMany({ where: { ownerId: { in: userIds }, title: { contains: runId } }, select: { id: true, ownerId: true, title: true } });
  for (const offering of offerings) assert.equal(offering.name, policy.title);
  for (const template of templates) assert.equal(template.title, policy.title);
  if (report.fixture?.offeringId) {
    const value = await tx.courseOffering.findUnique({ where: { id: report.fixture.offeringId } });
    assert.ok(!value || (value.description === runId && value.name === policy.title), 'Offering is not owned by this run');
    assert.ok(offerings.every((item) => item.id === report.fixture.offeringId));
  }
  if (report.fixture?.templateId) {
    const value = await tx.classroomTemplate.findUnique({ where: { id: report.fixture.templateId } });
    assert.ok(!value || (userIds.includes(value.ownerId) && value.title === policy.title), 'Template is not owned by this run');
    assert.ok(templates.every((item) => item.id === report.fixture.templateId));
  }
  if (kind === 'projection-contention') {
    validateProjectionRecords(report, { offerings, templates,
      chapter: await tx.chapter.findUnique({ where: { id: report.fixture.chapterId } }),
      activity: await tx.activity.findUnique({ where: { id: report.fixture.activityId } }),
      instance: await tx.classroomInstance.findUnique({ where: { id: report.fixture.instanceId }, include: {
        templateVersion: { select: { templateId: true, snapshot: true } },
      } }),
    });
  }
  const owned = new Map([
    ['User', new Set(userIds)], ['CourseOffering', new Set(offerings.map((item) => item.id))],
    ['ClassroomTemplate', new Set(templates.map((item) => item.id))],
  ]);
  const edges = await tx.$queryRawUnsafe(`
    SELECT child.relname AS child, parent.relname AS parent,
           child_column.attname AS "childColumn", parent_column.attname AS "parentColumn",
           cardinality(fk.conkey) AS columns
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid=fk.conrelid
    JOIN pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_namespace namespace ON namespace.oid=child.relnamespace
    JOIN pg_attribute child_column ON child_column.attrelid=child.oid AND child_column.attnum=fk.conkey[1]
    JOIN pg_attribute parent_column ON parent_column.attrelid=parent.oid AND parent_column.attnum=fk.confkey[1]
    WHERE fk.contype='f' AND namespace.nspname='public'
  `);
  for (const edge of edges) {
    assert.equal(edge.columns, 1, 'Composite foreign key requires manual inspection');
    assert.equal(edge.parentColumn, 'id', 'Unsupported foreign key; refusing cleanup');
  }
  // Discover only descendants of verified roots. Never follow a foreign key
  // upward into an unrelated course or account.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const parentIds = [...(owned.get(edge.parent) ?? [])];
      if (!parentIds.length) continue;
      const rows = await tx.$queryRawUnsafe(
        `SELECT id FROM ${identifier(edge.child)} WHERE ${identifier(edge.childColumn)} = ANY($1::text[])`, parentIds);
      if (!owned.has(edge.child)) owned.set(edge.child, new Set());
      const ids = owned.get(edge.child);
      for (const { id } of rows) if (!ids.has(id)) { ids.add(id); changed = true; }
    }
    assert.ok([...owned.values()].reduce((sum, ids) => sum + ids.size, 0) <= 500000, 'Fixture is unexpectedly large');
  }
  // A fixture descendant with any FK into unrelated data is shared data.
  // Refuse the entire transaction before issuing a delete.
  for (const edge of edges) {
    const ids = [...(owned.get(edge.child) ?? [])];
    if (!ids.length) continue;
    const rows = await tx.$queryRawUnsafe(
      `SELECT id FROM ${identifier(edge.child)} WHERE id=ANY($1::text[]) AND ${identifier(edge.childColumn)} IS NOT NULL AND NOT (${identifier(edge.childColumn)}=ANY($2::text[])) LIMIT 1`,
      ids, [...(owned.get(edge.parent) ?? [])]);
    assert.equal(rows.length, 0, `${edge.child} references non-fixture ${edge.parent}; refusing cleanup`);
  }
  if (report.fixture?.instanceId) assert.ok(
    [...(owned.get('ClassroomInstance') ?? [])].every((id) => id === report.fixture.instanceId), 'Unexpected classroom instance');
  if (kind === 'projection-contention') validateOwnedProjectionRoots(report, owned);
  const assets = await tx.fileAsset.findMany({ where: { id: { in: [...(owned.get('FileAsset') ?? [])] } }, select: { id: true, storageKey: true, sha256: true } });
  const order = deletionOrder(owned, edges);
  const counts = Object.fromEntries(order.map((table) => [table, owned.get(table).size]));
  if (execute) for (const table of order) {
    await tx.$executeRawUnsafe(`DELETE FROM ${identifier(table)} WHERE id=ANY($1::text[])`, [...owned.get(table)]);
  }
  return { runId, kind, counts, assets, databaseDeleted: execute, completedAt: new Date().toISOString() };
}

async function main() {
  const args = process.argv.slice(2);
  const reportPath = args.find((arg) => !arg.startsWith('--'));
  assert.ok(reportPath, 'Usage: node scripts/cleanup-capacity-run.mjs REPORT.json [--kind=projection-contention] [--execute] [--abort-run=capacity-UUID]');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const kind = args.find(arg => arg.startsWith('--kind='))?.slice('--kind='.length) ?? 'classroom-capacity';
  const policy = validateReport(report, args.find((arg) => arg.startsWith('--abort-run='))?.slice('--abort-run='.length), kind);
  const execute = args.includes('--execute');
  const root = path.resolve(import.meta.dirname, '..');
  const databaseUrl = process.env.CAPACITY_DATABASE_URL || (await readFile(path.join(root, 'deploy/secrets/database_url.txt'), 'utf8')).trim();
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const result = await db.$transaction((tx) => planAndDelete(tx, report, execute, kind), { isolationLevel: 'Serializable', timeout: 60000 });
    const receiptPath = path.join(path.dirname(path.resolve(reportPath)), 'cleanup.json');
    if (execute) {
      const previous = await readFile(receiptPath, 'utf8').then(JSON.parse).catch((error) => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      if (previous?.databaseDeleted && !previous.filesDeleted) {
        assert.equal(previous.runId, result.runId, 'Cleanup receipt belongs to another run');
        assert.equal(previous.kind ?? 'classroom-capacity', kind, 'Cleanup receipt belongs to another fixture kind');
        for (const asset of previous.assets) {
          assert.equal(await db.fileAsset.count({ where: { OR: [{ id: asset.id }, { storageKey: asset.storageKey }] } }), 0,
            'Previously removed asset is referenced again; refusing file deletion');
          if (!result.assets.some((item) => item.id === asset.id)) result.assets.push(asset);
        }
      }
      // Preserve a file-deletion receipt before touching filesystem paths.
      await writeFile(receiptPath, JSON.stringify(result, null, 2), { mode: 0o600 });
      for (const asset of result.assets) {
        assert.ok(asset.storageKey && path.basename(asset.storageKey) === asset.storageKey && !['.', '..'].includes(asset.storageKey));
        const file = path.join(root, '.openpbl-data/uploads', asset.storageKey);
        const stat = await lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) continue;
        assert.ok(stat.isFile(), 'Refusing a non-regular upload path');
        if (asset.sha256) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), asset.sha256);
        await unlink(file);
      }
      const classroom = path.join(root, '.openpbl-data/classrooms', policy.classroomId);
      await unlink(`${classroom}.json`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await rm(classroom, { recursive: true, force: true });
      result.filesDeleted = true;
      await writeFile(receiptPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify({ runId: result.runId, kind, dryRun: !execute, counts: result.counts, uploads: result.assets.length }));
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
