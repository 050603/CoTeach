import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve(process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ?? '.openpbl-runtime/first-pass-benchmark-final');
const metadata = JSON.parse(await readFile(path.join(output, 'metadata.json'), 'utf8'));
const rows = await Promise.all((await readdir(path.join(output, 'results'))).filter((file) => file.endsWith('.json')).map(async (file) => JSON.parse(await readFile(path.join(output, 'results', file), 'utf8'))));
const rendered = new Map(await Promise.all((await readdir(path.join(output, 'renders')).catch(() => [])).filter((file) => file.endsWith('.json')).map(async (file) => [file.replace(/\.json$/, ''), JSON.parse(await readFile(path.join(output, 'renders', file), 'utf8'))])));
const visualInspection = (await Promise.all(['visual-inspection.json', 'baseline-visual-inspection.json', 'baseline-mid-visual-inspection.json'].map(async (file) => JSON.parse(await readFile(path.join(output, file), 'utf8').catch(() => '[]'))))).flat();
const inspectedIds = visualInspection.map((row) => row.id);
if (new Set(inspectedIds).size !== inspectedIds.length) throw new Error('Duplicate independent inspection IDs; reconcile before reporting');
const resumeEvidence = JSON.parse(await readFile(path.join(output, 'resume-evidence.json'), 'utf8').catch(() => 'null'));
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null; };
const groups = ['baseline', 'budget', 'sketch'].map((group) => {
  const cases = rows.filter((row) => row.group === group);
  const first = cases.map((row) => rendered.get(`${row.id}-first-prepared`)).filter(Boolean);
  const final = cases.map((row) => rendered.get(row.id)).filter(Boolean);
  return { group, completedCases: cases.length, plannedCases: 72, producedFinalSlide: cases.filter((row) => row.status === 'completed').length,
    failedWithoutAnyModelResponse: cases.filter((row) => row.calls.length && !row.calls.some((call) => call.response)).length,
    returnedNoFinalSlide: cases.filter((row) => row.calls.some((call) => call.response) && row.status !== 'completed').length,
    unavailableVision: cases.filter((row) => row.error?.includes('no vision capability')).length,
    logicalCalls: cases.reduce((sum, row) => sum + row.calls.length, 0), elapsedMsSum: cases.reduce((sum, row) => sum + row.elapsedMs, 0),
    observedElapsedMs: { median: percentile(cases.filter((row) => row.calls.length).map((row) => row.elapsedMs), 0.5), p95: percentile(cases.filter((row) => row.calls.length).map((row) => row.elapsedMs), 0.95) },
    spatialPreparationMs: { median: percentile(cases.filter((row) => row.spatialPreparationMs !== undefined).map((row) => row.spatialPreparationMs), 0.5), p95: percentile(cases.filter((row) => row.spatialPreparationMs !== undefined).map((row) => row.spatialPreparationMs), 0.95), note: 'Includes spatial preparation and programmatic sketch generation, with service queue/font loading. Shared preparation is recorded on each dependent result; values must not be summed as independent computation.' },
    inputCompositionsCovered: [...new Set(cases.map((row) => row.composition))],
    compositionCoverageInterpretation: 'Eight fixture composition categories measure input coverage, not validated output layout diversity.',
    finalSlidesUsingNativeElementTypes: Object.fromEntries(['text', 'shape', 'line', 'chart', 'table', 'latex', 'image'].map((type) => [type, cases.filter((row) => row.final?.elements?.some((element) => element.type === type)).length])),
    firstRendered: first.length, firstRenderedWithoutRuleWarnings: first.filter((report) => report.status === 'completed' && report.issues.length === 0).length,
    finalRendered: final.length, finalRenderedWithoutRuleWarnings: final.filter((report) => report.status === 'completed' && report.issues.length === 0).length,
    independentScreenshotReview: { reviewedWithRenderedScreenshot: visualInspection.filter((row) => row.id.includes(`-${group}-`) && rendered.has(`${row.id}-first-prepared`)).length, reviewedWithoutGeneratedArtifact: visualInspection.filter((row) => row.id.includes(`-${group}-`) && !rendered.has(`${row.id}-first-prepared`)).length, reviewed: visualInspection.filter((row) => row.id.includes(`-${group}-`)).length, layoutAndKnowledgeAccepted: visualInspection.filter((row) => row.id.includes(`-${group}-`) && row.layoutAccepted && row.requiredKnowledgePreserved).length, layoutAccepted: visualInspection.filter((row) => row.id.includes(`-${group}-`) && row.layoutAccepted).length, requiredKnowledgePreserved: visualInspection.filter((row) => row.id.includes(`-${group}-`) && row.requiredKnowledgePreserved).length, reviewer: 'Codex screenshot and evidence inspection; not a teacher sign-off' },
    manualLayoutReview: 'complete teacher review not performed', knowledgePointReview: 'complete teacher review not performed' };
});
const report = { ...metadata, environmentLimits: 'Tail conditions overlapped six additional action-generation calls to the same model and production builds on the shared host. Provider/system load was not isolated. Timing figures are observed request durations, not dedicated-environment benchmarks or billing totals.', baselineInterpretation: 'Fixed Git commit baseline. It excludes the uncommitted accept-after-one-correction change present when this session began, so it does not represent the complete initial workspace or deployed behavior.', resumeEvidence, callAccounting: 'Saved logical requests only; transport retries and unpersisted requests in flight at environment interruption are not a provider billing total.', reportedAt: new Date().toISOString(), completedCases: rows.length, groups, measurement: 'Static geometry plus actual ReadonlySlideCanvas Chromium measurements; human acceptance remains separate',
  interpretation: 'Counts without rule warnings are diagnostic, not human acceptance. First response and final content are measured separately; no-vision cases are unavailable, not model quality failures.' };
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
