/** Read-only regression probe for the real course's earlier and accepted source-backed examples. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectPriorSourceExamples } from '../src/lib/course-design/job-runner';
import type { CourseContent } from '../src/lib/session/types';

async function main() {
  const root = '.openpbl-runtime/course-upgrade-20260923';
  const old = JSON.parse(await readFile(`${root}/source-before-stage2-rebuild.json`, 'utf8')).snapshot.design.content as CourseContent;
  const beforeAccepted = JSON.parse(await readFile(`${root}/source-before-accepted-stage2-workspace.json`, 'utf8')).course.content as CourseContent;
  const request = JSON.parse(await readFile(`${root}/source-stage2-full-request.json`, 'utf8')) as { teachingSourceContext: string };
  const earlier = collectPriorSourceExamples(old.teachingBlueprint, old.knowledgePoints, beforeAccepted.knowledgePoints,
    `${request.teachingSourceContext}\n${JSON.stringify(old.courseEvidence ?? '')}`, true);
  const fish = earlier.find((example) => example.workedExample.includes('青蛙'));
  assert.ok(fish, 'Earlier source-backed observation case was lost when knowledge points were regrouped');
  assert.deepEqual(fish.knowledgePointIds, ['kp-2']);
  const accepted = collectPriorSourceExamples(beforeAccepted.teachingBlueprint, beforeAccepted.knowledgePoints,
    beforeAccepted.knowledgePoints, request.teachingSourceContext, true);
  console.log(JSON.stringify({ previousCases: earlier.length, carriedFishTo: fish.knowledgePointIds,
    previousFishImagePlanned: fish.imagePlanned, intermediateCases: accepted.length, providerCalls: 0 }));
}
void main();
