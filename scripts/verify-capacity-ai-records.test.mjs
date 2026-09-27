import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyCurrentDocumentModelOutput } from './verify-capacity-ai-records.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
function setup() {
  const task = { input: { token: 'final-token', intent: 'discuss', documentVersion: 'version' } }, participationId = 'participation', userId = 'user';
  const fact = token => ({ content: '{"kind":"discussion","message":"回答"}', idempotencyKey: `legacy-ai:${digest(JSON.stringify([participationId, userId, `document-model-success:${token}:1`]))}`, payload: { detail: { requestAttemptId: token, documentVersion: 'version', modelAttempt: 1, rawSha256: digest('{"kind":"discussion","message":"回答"}') } } });
  return { task, participationId, userId, modelOutputs: [fact('old-token'), fact('final-token')] };
}
test('old failed-attempt output cannot replace final successful raw', () => { const args = setup(); args.modelOutputs.pop(); assert.throws(() => verifyCurrentDocumentModelOutput(args), /final successful/); });
test('retains old output and verifies current successful token and stable ID', () => { verifyCurrentDocumentModelOutput(setup()); });
test('duplicate current success, wrong document or wrong stable key fails', () => {
  for (const mutate of [args => args.modelOutputs.push(structuredClone(args.modelOutputs[1])), args => { args.modelOutputs[1].payload.detail.documentVersion = 'changed'; }, args => { args.modelOutputs[1].idempotencyKey = 'wrong'; }]) { const args = setup(); mutate(args); assert.throws(() => verifyCurrentDocumentModelOutput(args)); }
});
