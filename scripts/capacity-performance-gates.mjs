/** Shared acceptance budgets. Keep small feature groups separate from bulk polling. */
export function capacityBudgets({ soak = false, realAi = false } = {}) {
  const budgets = Object.fromEntries(['ordinary-reads', 'showcase-read', 'external-artifact-state'].map(key => [key, 1000]));
  for (const key of ['draft-save', 'progress', 'pretest', 'posttest-draft', 'posttest-submit', 'archive', 'quiz', 'external-artifact-upload', 'extended-teacher-action']) budgets[key] = 2000;
  if (soak) {
    for (const key of ['event-poll', 'projection-read', 'classroom-state', 'ai-lesson-read', 'ai-classroom-read']) budgets[key] = 1000;
    budgets['learning-events'] = 2000;
    budgets['learning-event-save'] = 2000;
    if (realAi) budgets['lecture-media-stream'] = 1000;
  }
  return budgets;
}
export function capacityPerformanceFailures(metrics, { requireAll = true, ...options } = {}) {
  const failures = [];
  for (const [category, budget] of Object.entries(capacityBudgets(options))) {
    const value = metrics.get(category);
    if (!value && !requireAll) continue;
    const times = value?.times ?? [];
    const p95 = times.length ? times.toSorted((a,b) => a-b)[Math.ceil(times.length * .95) - 1] : null;
    if (p95 === null || !Number.isFinite(p95) || p95 > budget) failures.push(`${category} P95=${p95} exceeds ${budget}ms`);
  }
  return failures;
}
