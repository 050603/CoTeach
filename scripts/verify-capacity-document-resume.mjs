/** Resume only the document-browser checks on an explicitly selected failed capacity fixture.
 * Original reports remain unchanged; the separate manifest records all subsequent writes. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { configureCapacityNetwork } from './capacity-network.mjs';
import { verifyCapacityDocumentBrowsers } from './verify-capacity-document-browser.mjs';
const runId = process.argv[2];
assert.match(runId ?? '', /^capacity-[0-9a-f-]{36}$/);
const directory = path.resolve('test-results/capacity', runId);
const source = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
assert.equal(source.runId, runId); assert.equal(source.outcome, 'failed');
const output = path.join(directory, `document-resume-${Date.now()}.json`);
const fixture = source.fixture;
const db = new PrismaClient({ datasourceUrl: (await readFile('deploy/secrets/database_url.txt', 'utf8')).trim() });
const secret = new TextEncoder().encode((await readFile('deploy/secrets/jwt_secret.txt', 'utf8')).trim());
const origin = source.origin;
assert.equal(origin, 'https://coteach.cn');
const network = configureCapacityNetwork(origin);
const expected = new Map(Object.entries(source.expected));
const report = { runId, buildId: (await readFile('.next-build/BUILD_ID', 'utf8')).trim(), startedAt: new Date().toISOString(), outcome: 'running', checks: [] };
const users = [];
try {
  const offering = await db.courseOffering.findUniqueOrThrow({ where: { id: fixture.offeringId } });
  assert.ok(JSON.stringify(offering).includes(runId), 'Fixture ownership marker is required');
  const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: fixture.instanceId }, include: { activity: { include: { chapter: true } } } });
  assert.equal(instance.activityId, fixture.activityId);
  assert.equal(instance.activity.chapter.offeringId, fixture.offeringId);
  for (const id of fixture.userIds) {
    const user = await db.user.findUniqueOrThrow({ where: { id } });
    assert.match(user.username, new RegExp(`^${runId}-[0-9]+$`));
    const role = user.role.toLowerCase(); assert.ok(['student', 'teacher'].includes(role));
    const token = await new SignJWT({ role, sv: user.sessionVersion, username: user.username, displayName: user.displayName, studentName: user.displayName, userId: id })
      .setSubject(id).setProtectedHeader({ alg: 'HS256' }).setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('30m').sign(secret);
    users.push({ id, username: user.username, role, index: Number(user.username.split('-').at(-1)), cookie: `openpbl_${role}=${token}` });
  }
  const request = async (user, method, endpoint, body) => {
    const response = await fetch(`${origin}${endpoint}`, { method, headers: { Origin: origin, Cookie: user.cookie, 'X-OpenPBL-Role': user.role, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const payload = await response.json(); assert.equal(response.status, 200); return payload;
  };
  // The helper validates the saved draft version before editing; stale manifests fail closed.
  await request(users.find(user => user.role === 'teacher'), 'POST', `/api/courses/${fixture.instanceId}/actions`, { requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: fixture.instanceId, index: 2 } } });
  await verifyCapacityDocumentBrowsers({ users, fixture, origin, request, expected, browserArgs: network.browserArgs, connectAddress: network.address,
    record: (name, status, detail) => { report.checks.push({ name, status, detail }); console.log(status, name, JSON.stringify(detail)); } });
  report.outcome = 'passed';
} catch (error) { report.outcome = 'failed'; report.error = String(error.stack ?? error); console.error(report.error); process.exitCode = 1; }
finally { report.expected = Object.fromEntries(expected); report.endedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 }); await db.$disconnect(); console.log('Report:', output); }
