/** Read-only reconciliation of a capacity run's real AI requests. No secrets or message content are exported. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const digest = value => createHash('sha256').update(value).digest('hex');

export function separateCapacityAiDiagnostics(facts) {
  const diagnostics = facts.filter(event => event.eventType === 'error');
  const modelOutputs = facts.filter(event => event.payload?.detail?.kind === 'model-output');
  for (const event of [...diagnostics, ...modelOutputs]) {
    assert.equal(event.actor, 'system', 'Failure diagnostics must not masquerade as a successful message');
    assert.equal(typeof event.content, 'string');
    const detail = event.payload?.detail;
    if (detail?.kind === 'invalid-model-response' || detail?.kind === 'model-output') {
      assert.equal(digest(event.content), detail.rawSha256, 'Invalid model output hash differs');
      assert.equal(event.content.length, detail.rawLength, 'Invalid model output was truncated');
      assert.ok(typeof detail.requestAttemptId === 'string' && detail.requestAttemptId.length > 0);
      assert.ok(Number.isInteger(detail.modelAttempt) && detail.modelAttempt >= 1 && detail.modelAttempt <= 3);
      if (detail.kind === 'invalid-model-response') assert.ok(['INVALID_JSON', 'EXPECTED_OBJECT', 'INVALID_KIND', 'EMPTY_MESSAGE', 'INVALID_SUGGESTION'].includes(detail.reason));
    }
  }
  return { diagnostics, modelOutputs, successful: facts.filter(event => event.eventType !== 'error' && event.payload?.detail?.kind !== 'model-output') };
}

export function capacityAiRequestManifests(state) {
  assert.ok(state.tutorRequestId && state.documentRequestId, 'Missing whole-class AI request IDs');
  assert.ok(state.browserDocumentRequests === undefined || Array.isArray(state.browserDocumentRequests));
  assert.ok(state.followupDocumentRequests === undefined || Array.isArray(state.followupDocumentRequests));
  const requests = [
    { kind: 'tutor', requestId: state.tutorRequestId, taskType: 'KNOWLEDGE_LECTURE_TUTOR' },
    { kind: 'document', requestId: state.documentRequestId, taskType: 'DOCUMENT_COLLABORATION' },
    ...(state.followupDocumentRequests ?? []).map(requestId => ({ kind: 'after-learning-document', requestId, taskType: 'DOCUMENT_COLLABORATION' })),
    ...(state.browserDocumentRequests ?? []).map(manifest => {
      assert.ok(manifest && typeof manifest.requestId === 'string' && manifest.requestId.length > 0, 'Browser AI request ID is missing');
      assert.equal(manifest.status, 'completed', 'Browser AI has no observed completion');
      return { kind: 'browser-document', requestId: manifest.requestId, taskType: 'DOCUMENT_COLLABORATION', manifest };
    }),
  ];
  assert.equal(new Set(requests.map(item => item.requestId)).size, requests.length, 'AI request manifests contain duplicate IDs');
  return requests;
}

export function verifyCurrentDocumentModelOutput({ task, modelOutputs, participationId, userId }) {
  assert.ok(typeof task.input.token === 'string' && task.input.token.length, 'Completed document task must retain its final attempt token');
  const current = modelOutputs.filter(row => row.payload.detail.requestAttemptId === task.input.token);
  assert.ok(current.length > 0, 'The final successful attempt has no raw model output; older retries cannot substitute');
  for (const row of current) {
    assert.equal(row.payload.detail.documentVersion, task.input.documentVersion);
    assert.equal(digest(row.content), row.payload.detail.rawSha256);
  }
  // This workload's discussion requests use the structured-response repair path.
  // Delegated model steps have another producer contract and retain their own current-token facts.
  if (task.input.intent === 'discuss') {
    const successful = current.filter(row => row.idempotencyKey === `legacy-ai:${digest(JSON.stringify([participationId, userId,
      `document-model-success:${task.input.token}:${row.payload.detail.modelAttempt}`]))}`);
    assert.equal(successful.length, 1, 'The final discussion needs exactly one stable successful-model fact');
  }
}

export async function verifyCapacityAiRecords({ db, fixture, expected, studentCount }) {
  const entries = expected instanceof Map ? [...expected] : Object.entries(expected ?? {});
  assert.equal(entries.length, studentCount, 'Every student must have an expected AI record');
  const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: fixture.instanceId }, include: { activity: { include: { chapter: true } } } });
  assert.equal(instance.activity.chapter.offeringId, fixture.offeringId);
  const results = [];
  for (const [userId, state] of entries) {
    assert.ok(fixture.userIds.includes(userId), 'Expected identity is outside this run');
    const participation = await db.classroomParticipation.findFirstOrThrow({ where: { instanceId: fixture.instanceId, enrollment: { userId, offeringId: fixture.offeringId } }, include: { enrollment: true } });
    for (const { kind, requestId, taskType, manifest } of capacityAiRequestManifests(state)) {
      const tasks = await db.aiTask.findMany({ where: { createdById: userId, taskType, input: { path: ['requestId'], equals: requestId } }, include: { conversation: true } });
      assert.equal(tasks.length, 1, `${kind} request must own exactly one task`);
      const task = tasks[0];
      assert.equal(task.status, 'COMPLETED', `${kind} request ${requestId} did not complete`);
      assert.ok(task.completedAt);
      assert.equal(task.offeringId, fixture.offeringId);
      assert.equal(task.conversation?.participationId, participation.id);
      assert.equal(task.conversation?.userId, userId);
      let messageIds;
      let expectedMessages;
      if (kind === 'tutor') {
        assert.ok(task.output?.thread?.messages.some(message => message.role === 'assistant' && message.content?.trim()));
        if (fixture.modelOutputEvidenceVersion === 1) {
          assert.equal(typeof task.output.modelOutput?.raw, 'string', 'Tutor raw model output is missing');
          assert.equal(digest(task.output.modelOutput.raw), task.output.modelOutput.sha256);
        }
        messageIds = [`${task.id}:student`, `${task.id}:assistant`];
      } else {
        assert.equal(task.output?.response?.status, 'completed');
        assert.equal(task.output?.response?.requestId, requestId);
        expectedMessages = task.output?.response?.messages;
        assert.equal(expectedMessages?.length, 2, 'Document discussion must preserve both request and response');
        messageIds = expectedMessages.map(message => message.id);
        if (manifest) {
          assert.equal(digest(task.input.message), manifest.messageSha256, 'Browser question differs from the saved task');
          assert.equal(task.input.documentVersion, manifest.documentVersion, 'Browser document snapshot differs from the saved task');
          assert.equal(task.output.response.conversationId, manifest.conversationId);
          assert.equal(digest(task.output.response.result.message), manifest.responseSha256, 'Browser answer differs from the saved task');
          assert.equal(expectedMessages.find(message => message.role === 'student')?.id, manifest.studentMessageId);
          assert.equal(expectedMessages.find(message => message.role === 'agent')?.id, manifest.assistantMessageId);
        }
      }
      const messages = await db.aiMessage.findMany({ where: { id: { in: messageIds } }, orderBy: { createdAt: 'asc' } });
      assert.equal(messages.length, 2);
      assert.equal(messages.filter(message => message.role === 'user').length, 1);
      assert.equal(messages.filter(message => message.role === 'assistant').length, 1);
      for (const message of messages) {
        assert.equal(message.conversationId, task.conversationId);
        assert.ok(message.content.trim(), 'Persisted AI messages cannot be empty');
        if (message.role === 'user') { assert.equal(message.userId, userId); assert.equal(message.content, task.input.message); }
        if (expectedMessages) assert.equal(message.content, expectedMessages.find(item => item.id === message.id)?.content);
      }
      const facts = await db.aiInteractionEvent.findMany({ where: { requestId } });
      const { diagnostics, modelOutputs, successful } = separateCapacityAiDiagnostics(facts);
      if (kind !== 'tutor' && fixture.modelOutputEvidenceVersion === 1) verifyCurrentDocumentModelOutput({ task, modelOutputs, participationId: participation.id, userId });
      assert.equal(successful.length, kind === 'tutor' ? 2 : 3, 'Request audit has missing or duplicate successful facts');
      assert.equal(successful.filter(event => event.actor === 'student').length, 1);
      assert.equal(successful.filter(event => event.actor === 'assistant').length, 1);
      const acknowledgedFailures = (state.aiFailures ?? []).filter(failure => failure.requestId === requestId && failure.error === 'AI_COLLABORATION_FAILED');
      assert.ok(diagnostics.length >= acknowledgedFailures.length, 'An acknowledged AI failure has no durable diagnostic');
      for (const event of facts) {
        assert.equal(event.userId, userId); assert.equal(event.participationId, participation.id);
        assert.equal(event.offeringId, fixture.offeringId); assert.equal(event.researchKey, participation.enrollment.researchKey);
        if (kind === 'tutor') assert.equal(event.taskId, task.id);
        if (event.actor === 'student') assert.equal(event.content, task.input.message);
        if (event.actor === 'assistant') assert.equal(event.content, messages.find(message => message.role === 'assistant').content);
      }
      if (kind !== 'tutor') {
        const messageFacts = await db.aiInteractionEvent.findMany({ where: { idempotencyKey: { in: messageIds.map(id => `companion-message:${id}`) } } });
        assert.equal(messageFacts.length, 2, 'Atomic document message audit must be complete');
        for (const event of messageFacts) {
          assert.equal(event.participationId, participation.id); assert.equal(event.researchKey, participation.enrollment.researchKey);
        }
      }
      results.push({ userId, kind, requestId, taskId: task.id, status: task.status, messageCount: messages.length, requestAuditCount: facts.length, diagnosticCount: diagnostics.length, modelOutputCount: modelOutputs.length });
    }
  }
  return { outcome: 'passed', checkedAt: new Date().toISOString(), students: entries.length, requests: results.length, results };
}

async function main() {
  const filename = process.argv[2];
  if (!filename || filename === '--help') { console.log('node scripts/verify-capacity-ai-records.mjs <capacity-report.json>'); return; }
  const reportPath = path.resolve(filename);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.match(report.runId ?? '', /^capacity-[0-9a-f-]{36}$/);
  assert.ok(report.fixture?.instanceId && report.fixture?.offeringId && report.expected);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const url = new URL(process.env.CAPACITY_DATABASE_URL || (await readFile(path.join(root, 'deploy/secrets/database_url.txt'), 'utf8')).trim());
  url.searchParams.set('options', '-c default_transaction_read_only=on');
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  let result;
  try {
    const setting = await db.$queryRaw`SELECT current_setting('default_transaction_read_only') AS value`;
    assert.equal(setting[0].value, 'on', 'Database connection must enforce read-only transactions');
    const offering = await db.courseOffering.findUniqueOrThrow({ where: { id: report.fixture.offeringId } });
    assert.equal(offering.description, report.runId, 'Only this capacity run may be inspected');
    result = { runId: report.runId, ...await verifyCapacityAiRecords({ db, fixture: report.fixture, expected: report.expected, studentCount: report.studentCount }) };
  } catch (error) {
    result = { runId: report.runId, outcome: 'failed', checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally { await db.$disconnect(); }
  const output = path.join(path.dirname(reportPath), 'ai-records.json');
  await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`${result.outcome}: ${output}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
