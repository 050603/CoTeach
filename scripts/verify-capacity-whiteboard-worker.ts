// Real application sync server, disposable PostgreSQL identities, private SQLite files.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, type WebSocketServer } from 'ws';
import { applyObjectDiff, getTlsyncProtocolVersion, type NetworkDiff, type TLSocketServerSentEvent } from '@tldraw/sync-core';
import { createTLSchema, toRichText, type TLRecord, type TLShape } from '@tldraw/tlschema';
import { prisma } from '../src/lib/db/client';

const schema = createTLSchema();
const clients: WebSocket[] = [];
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 300; i += 1) { if (predicate()) return; await delay(20); }
  assert.ok(predicate(), label);
}
function applyDiff(records: Map<string, TLRecord>, diff: NetworkDiff<TLRecord>) {
  for (const [id, operation] of Object.entries(diff)) {
    if (operation[0] === 'put') records.set(id, operation[1]);
    else if (operation[0] === 'remove') records.delete(id);
    else { const previous = records.get(id); assert.ok(previous); records.set(id, applyObjectDiff(previous, operation[1])); }
  }
}
async function connect(port: number, courseId: string, groupId: string, cookie: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?courseId=${courseId}&groupId=${groupId}&role=student&sessionId=${randomUUID()}`, { headers: { origin: `http://127.0.0.1:${port}`, cookie } });
  clients.push(socket);
  const records = new Map<string, TLRecord>();
  const acknowledgements = new Map<number, string>();
  let connected = false;
  let clientClock = 0;
  const errors: string[] = [];
  const receive = (event: TLSocketServerSentEvent<TLRecord>) => {
    if (event.type === 'data') { event.data.forEach(receive); return; }
    if (event.type === 'connect') { applyDiff(records, event.diff); connected = true; return; }
    if (event.type === 'patch') applyDiff(records, event.diff);
    if (event.type === 'push_result') {
      acknowledgements.set(event.clientClock, typeof event.action === 'string' ? event.action : 'rebase');
      if (typeof event.action === 'object') applyDiff(records, event.action.rebaseWithDiff);
    }
  };
  socket.on('error', error => errors.push(error.message));
  socket.on('message', bytes => { try { receive(JSON.parse(bytes.toString())); } catch (error) { errors.push(String(error)); } });
  socket.on('open', () => socket.send(JSON.stringify({ type: 'connect', connectRequestId: randomUUID(), lastServerClock: 0,
    protocolVersion: getTlsyncProtocolVersion(), schema: schema.serialize() })));
  await until(() => connected || errors.length > 0, 'WebSocket handshake timed out');
  assert.deepEqual(errors, []);
  return { socket, records, async push(diff: NetworkDiff<TLRecord>) {
    const clock = ++clientClock;
    applyDiff(records, diff);
    socket.send(JSON.stringify({ type: 'push', clientClock: clock, diff }));
    await until(() => acknowledgements.has(clock) || errors.length > 0, 'Push acknowledgement timed out');
    assert.deepEqual(errors, []); assert.equal(acknowledgements.get(clock), 'commit');
  } };
}
function shape(id: string, label: string, x: number): TLShape {
  return schema.types.shape.create({ id: id as TLShape['id'], type: 'geo', index: 'a2' as TLShape['index'], parentId: 'page:page' as TLShape['parentId'], x, y: 50,
    props: { geo: 'rectangle', w: 200, h: 100, color: 'black', fill: 'solid', dash: 'solid', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle',
      richText: toRichText(label), labelColor: 'black', url: '', growY: 0, scale: 1 } });
}
function point(client: { records: Map<string, TLRecord> }, id: string) { return client.records.get(id) as TLShape | undefined; }
async function disconnect(socket: WebSocket) { if (socket.readyState === WebSocket.CLOSED) return; const closed = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.close(); await closed; }
async function portOf(server: WebSocketServer): Promise<number> {
  if (!server.address()) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER ?? '';
  assert.match(marker, /^openpbl-fault-check-[0-9a-f-]{36}$/);
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1');
  const directory = process.env.WHITEBOARD_DATA_DIR!;
  assert.ok(directory.startsWith('/tmp/openpbl-fault-check-'));
  const markers = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification"`;
  assert.equal(markers[0]?.marker, marker);
  process.env.JWT_SECRET = randomUUID() + randomUUID(); delete process.env.REDIS_URL; delete process.env.PUBLIC_BASE_URL;
  const { startTldrawSyncServer, closeTldrawSyncServer } = await import('../src/lib/realtime/tldraw-sync-server');
  const { signStudentToken } = await import('../src/lib/auth/session');
  try {
    await prisma.courseOffering.update({ where: { id: 'fault-offering' }, data: { status: 'OPEN' } });
    const base = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: 'fault-course' } });
    const courseId = randomUUID(); const groupId = randomUUID();
    await prisma.classroomInstance.create({ data: { id: courseId, activityId: base.activityId, templateVersionId: base.templateVersionId, runNo: 2, status: 'TEACHING' } });
    await prisma.projectGroup.create({ data: { id: groupId, offeringId: 'fault-offering', name: marker } });
    const cookies: string[] = [];
    for (const userId of ['fault-student-0', 'fault-student-1']) {
      const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { userId, offeringId: 'fault-offering' } });
      const participation = await prisma.classroomParticipation.create({ data: { instanceId: courseId, enrollmentId: enrollment.id } });
      await prisma.groupMember.create({ data: { groupId, userId, participationId: participation.id } });
      const token = await signStudentToken({ userId, studentName: userId, sessionVersion: 1 });
      cookies.push(`${token.cookieName}=${token.token}`);
    }
    const port = await portOf(startTldrawSyncServer(0));
    const [a, b] = await Promise.all(cookies.map(cookie => connect(port, courseId, groupId, cookie)));
    const firstId = `shape:${randomUUID()}`, secondId = `shape:${randomUUID()}`;
    await Promise.all([a.push({ [firstId]: ['put', shape(firstId, 'Student A project evidence', 10)] }), b.push({ [secondId]: ['put', shape(secondId, 'Student B project evidence', 30)] })]);
    await until(() => a.records.has(secondId) && b.records.has(firstId), 'Concurrent shapes failed to converge');
    await Promise.all([a.push({ [firstId]: ['patch', { x: ['put', 200] }] }), b.push({ [firstId]: ['patch', { y: ['put', 300] }] })]);
    await until(() => point(a, firstId)?.y === 300 && point(b, firstId)?.x === 200, 'Concurrent independent edits did not merge');
    await b.push({ [secondId]: ['remove'] });
    await until(() => !a.records.has(secondId), 'Deletion did not reach peer');
    console.log('PASS real authenticated two-client whiteboard: simultaneous shape creation, independent-field edits merge, deletion converges');
    await disconnect(a.socket);
    await b.push({ [firstId]: ['patch', { x: ['put', 450] }] });
    const reconnected = await connect(port, courseId, groupId, cookies[0]);
    assert.equal(point(reconnected, firstId)?.x, 450); assert.equal(point(reconnected, firstId)?.y, 300); assert.ok(!reconnected.records.has(secondId));
    console.log('PASS disconnected student receives edits and deletion made while offline on authenticated reconnect');

    const fileName = createHash('sha256').update(`${courseId}:${groupId}`).digest('hex') + '.sqlite';
    const source = path.join(directory, fileName);
    const recoveredDirectory = path.join(directory, 'recovered'); await mkdir(recoveredDirectory, { recursive: true });
    const recoveredPath = path.join(recoveredDirectory, fileName);
    const backup = spawnSync('python3', ['-c', 'import sqlite3,sys; source=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); target=sqlite3.connect(sys.argv[2]); source.backup(target); target.close(); source.close()', source, recoveredPath], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(backup.status, 0, backup.stderr);
    const check = new DatabaseSync(recoveredPath, { readOnly: true });
    try {
      assert.equal(Object.values(check.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
      const row = check.prepare('SELECT state FROM documents WHERE id = ?').get(firstId)!;
      const stored = JSON.parse(Buffer.from(row.state as Uint8Array).toString());
      assert.equal(stored.x, 450); assert.equal(stored.y, 300);
      assert.equal(check.prepare('SELECT count(*) AS count FROM documents WHERE id = ?').get(secondId)?.count, 0);
      assert.equal(check.prepare('SELECT count(*) AS count FROM tombstones WHERE id = ?').get(secondId)?.count, 1);
    } finally { check.close(); }
    await Promise.all([disconnect(b.socket), disconnect(reconnected.socket)]);
    await closeTldrawSyncServer();
    process.env.WHITEBOARD_DATA_DIR = recoveredDirectory;
    const restoredPort = await portOf(startTldrawSyncServer(0));
    const restored = await connect(restoredPort, courseId, groupId, cookies[0]);
    assert.equal(point(restored, firstId)?.x, 450); assert.equal(point(restored, firstId)?.y, 300); assert.ok(!restored.records.has(secondId));
    await restored.push({ [firstId]: ['patch', { y: ['put', 600] }] });
    const peer = await connect(restoredPort, courseId, groupId, cookies[1]);
    assert.equal(point(peer, firstId)?.y, 600);
    console.log('PASS SQLite online backup (including deletion tombstone) integrity check; real service close/restart against recovered directory; fresh clients recover exact state and resume editing');
    // Deletion schedules storage pruning one second later. Close immediately,
    // then keep the process alive past that deadline to catch use-after-close.
    await restored.push({ [firstId]: ['remove'] });
  } finally {
    for (const socket of clients) socket.terminate();
    await closeTldrawSyncServer();
  }
  await delay(1200);
  console.log('PASS shutdown immediately after deletion leaves no delayed SQLite access or uncaught timer failure');
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
