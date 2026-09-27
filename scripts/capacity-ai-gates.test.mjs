import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCapacityAiGates } from './capacity-ai-gates.mjs';
function setup() {
  return { studentCount: 40, afterLearning: true, expected: new Map(Array.from({ length: 40 }, (_, i) => [String(i), {
    aiOperations: [{ kind: 'learning', status: 'completed', firstAttemptFailed: false, elapsedMs: 1000 }, ...[1, 2].map(() => ({ kind: 'document', status: 'completed', firstAttemptFailed: false, elapsedMs: 2000 }))],
    subjectiveGradingAttempts: [{ status: 'graded', elapsedMs: 1000 }],
  }])) };
}
test('complete successful operation manifests pass without any GET-based denominator', () => { assert.deepEqual(evaluateCapacityAiGates(setup()).failures, []); });
test('one recovered document failure among 80 operations fails independent 0.5% rate', () => {
  const args = setup(); args.expected.get('0').aiOperations[1].firstAttemptFailed = true;
  const result = evaluateCapacityAiGates(args); assert.equal(result.summary.document.failureRate, 1 / 80); assert.ok(result.failures.some(value => value.includes('document AI first-attempt')));
});
test('learning failure is evaluated independently of document operations', () => {
  const args = setup(); args.expected.get('0').aiOperations[0].firstAttemptFailed = true;
  assert.ok(evaluateCapacityAiGates(args).failures.some(value => value.includes('learning AI first-attempt')));
});
test('subjective complete retry wall time above 60s fails even when last attempt was fast', () => {
  const args = setup(); args.expected.get('0').subjectiveGradingAttempts = [{ status: 'failed', elapsedMs: 59000 }, { status: 'graded', elapsedMs: 61000 }];
  assert.ok(evaluateCapacityAiGates(args).failures.some(value => value.includes('60000ms')));
});
test('subjective recovery below 60s still fails independent first-attempt reliability gate', () => {
  const args = setup(); args.expected.get('0').subjectiveGradingAttempts = [{ status: 'failed', elapsedMs: 4000 }, { status: 'graded', elapsedMs: 7000 }];
  const result = evaluateCapacityAiGates(args); assert.equal(result.failures.length, 1); assert.match(result.failures[0], /Subjective grading first-attempt/); assert.equal(result.summary.subjectiveGrading.failedFirst, 1); assert.equal(result.summary.subjectiveGrading.failureRate, 1 / 40);
});
test('missing operation or incomplete grading manifest cannot pass', () => {
  const args = setup(); args.expected.get('0').aiOperations.pop(); delete args.expected.get('1').subjectiveGradingAttempts;
  assert.equal(evaluateCapacityAiGates(args).failures.length, 3);
});

test('all subjective first attempts failing cannot be hidden by successful fast retries', () => {
  const args = setup();
  for (const state of args.expected.values()) state.subjectiveGradingAttempts = [{ status: 'failed', elapsedMs: 1000 }, { status: 'graded', elapsedMs: 2000 }];
  const result = evaluateCapacityAiGates(args);
  assert.equal(result.summary.subjectiveGrading.failureRate, 1);
  assert.deepEqual(result.failures, ['Subjective grading first-attempt failure rate 1 is not below 0.5%']);
});
