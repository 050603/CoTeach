/** AI operation denominators stay independent of unrelated poll/media traffic. */
export function evaluateCapacityAiGates({ expected, studentCount, afterLearning }) {
  const states = [...expected.values()]; const failures = [];
  const summary = {};
  for (const [kind, expectedCount] of [['learning', studentCount], ['document', studentCount * (afterLearning ? 2 : 1)]]) {
    const operations = states.flatMap(state => (state.aiOperations ?? []).filter(item => item.kind === kind));
    const failedFirst = operations.filter(item => item.firstAttemptFailed).length;
    const failureRate = failedFirst / Math.max(1, operations.length);
    summary[kind] = { operations: operations.length, failedFirst, failureRate };
    if (operations.length !== expectedCount || operations.some(item => item.status !== 'completed' || !Number.isFinite(item.elapsedMs))) failures.push(`${kind} AI operation manifest is incomplete`);
    if (failureRate >= .005) failures.push(`${kind} AI first-attempt failure rate ${failureRate} is not below 0.5%`);
  }
  const grading = states.map(state => state.subjectiveGradingAttempts);
  const elapsed = grading.map(attempts => attempts?.at(-1)?.elapsedMs);
  const gradingFailedFirst = grading.filter(attempts => attempts?.[0]?.status !== 'graded').length;
  const gradingFailureRate = gradingFailedFirst / Math.max(1, grading.length);
  summary.subjectiveGrading = { operations: grading.length, failedFirst: gradingFailedFirst, failureRate: gradingFailureRate, maxCompletionMs: Math.max(0, ...elapsed.filter(Number.isFinite)) };
  if (gradingFailureRate >= .005) failures.push(`Subjective grading first-attempt failure rate ${gradingFailureRate} is not below 0.5%`);
  if (grading.length !== studentCount || grading.some(attempts => attempts?.at(-1)?.status !== 'graded') || elapsed.some(value => !Number.isFinite(value) || value > 60000)) failures.push('Subjective grading including retries must complete for every student within 60000ms');
  return { failures, summary };
}
