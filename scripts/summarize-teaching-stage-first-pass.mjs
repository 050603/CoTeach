/** Summarize cached stage measurements only; never contacts a model/provider. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const option = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const directory = option('--input');
const destination = option('--output');
if (!directory || !destination) throw new Error('Required: --input <experiment-directory> --output <report.json>');
const read = async (file) => JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
const results = await read('results.json');
const manifest = await read('manifest.json');
for (const group of results.groups) {
  const outlines = await read(`${group.language}/prepared-outlines.json`);
  group.plannedSpeechSec = outlines.reduce((sum, outline) => sum + outline.timingPlan.targetDurationSec, 0);
  group.generatedScriptPredictedSec = group.pages.reduce((sum, page) => sum + page.segments.reduce((subtotal, segment) => subtotal + segment.predictedSec, 0), 0);
  group.draftBudgetErrorRatio = group.generatedScriptPredictedSec / group.plannedSpeechSec - 1;
  group.ttsPredictionErrorRatio = group.audioTotalSec / group.generatedScriptPredictedSec - 1;
  group.speechSegments = group.pages.reduce((sum, page) => sum + page.segments.length, 0);
  group.calibrationIdentity = { ...manifest.identity.voice, language: group.language, algorithmVersion: manifest.identity.algorithmVersion };
}
const report = {
  experiment: 'Real first-draft teaching-stage timing on fixed editable slide content',
  scope: manifest.scope, model: manifest.identity.model, algorithmVersion: manifest.identity.algorithmVersion,
  sourceHashes: manifest.identity.sourceHashes, identityHash: manifest.identityHash,
  frozenRuntimeHash: createHash('sha256').update(await fs.readFile(path.join(directory, 'frozen-runtime.mjs'))).digest('hex'),
  generatedAt: results.generatedAt,
  rules: { targetSecPerGroup: 120, pagesPerGroup: 2, qualityRetries: 0, networkRetriesMax: 2, ttsSpeed: 1, slideContentGeneration: false },
  successfulFirstDraftResponses: results.groups.reduce((sum, group) => sum + group.pages.length, 0),
  successfulSpeechSegments: results.groups.reduce((sum, group) => sum + group.speechSegments, 0),
  groupsWithinTolerance: results.groups.filter((group) => group.withinTolerance).length,
  groups: results.groups,
};
await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ groups: results.groups.length, withinTolerance: report.groupsWithinTolerance, successfulFirstDraftResponses: report.successfulFirstDraftResponses, successfulSpeechSegments: report.successfulSpeechSegments }));
