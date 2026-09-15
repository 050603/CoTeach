/** Replay saved decoded measurements without provider access or audio synthesis.
 * pnpm exec tsx scripts/replay-tts-timing.ts --input <results.json> --output-dir <directory>
 * Fitting reads independent-calibration rows only; held-out rows are evaluation only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  TTS_TIMING_ALGORITHM_VERSION, createTtsVoiceTimingCalibration,
  mergeTtsVoiceTimingCalibrations, registerTtsVoiceTimingCalibration,
  estimateSpeechDurationSec, assessTtsDurationError,
  type TtsVoiceTimingCalibration,
} from '../src/lib/openmaic/audio/tts-timing';

type Row = {
  language: string; index: number; phase: string; text: string; actualSec: number;
  predictedSec: number; pass: boolean; errorRatio: number;
  previousPredictedSec?: number; previousPass?: boolean;
};
async function main() {
  const args = process.argv.slice(2);
  const argument = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const input = argument('--input');
  const outputDir = argument('--output-dir');
  if (!input || !outputDir) throw new Error('Required: --input <saved-results.json> --output-dir <directory>');
  const corpus = JSON.parse(await fs.readFile(input, 'utf8'));
  const rows = corpus.results as Row[];
  const profiles: TtsVoiceTimingCalibration[] = [];
  const languages = [...new Set(rows.map((row) => row.language))];
  // Fit and freeze all profiles before evaluating any held-out result.
  for (const language of languages) {
    let aggregate: TtsVoiceTimingCalibration | undefined;
    for (const row of rows.filter((entry) => entry.phase === 'independent-calibration' && entry.language === language)) {
      aggregate = mergeTtsVoiceTimingCalibrations(aggregate, createTtsVoiceTimingCalibration({
        ...corpus.identity, language, text: row.text, measuredDurationSec: row.actualSec,
        calibratedAt: argument('--calibrated-at') ?? corpus.calibratedAt ?? new Date().toISOString(),
      }));
    }
    if (!aggregate || (aggregate.sampleCount ?? 0) < 6) throw new Error(`Insufficient independent calibration: ${language}`);
    profiles.push(aggregate);
    registerTtsVoiceTimingCalibration(aggregate);
  }
  const results = rows.map((row) => {
    if (row.phase !== 'held-out') return row;
    const predictedSec = estimateSpeechDurationSec(row.text, { ...corpus.identity, language: row.language });
    const assessment = assessTtsDurationError({ targetSec: predictedSec, actualSec: row.actualSec });
    return {
      ...row, previousPredictedSec: row.previousPredictedSec ?? row.predictedSec,
      previousPass: row.previousPass ?? row.pass, predictedSec,
      errorRatio: assessment.errorRatio, pass: assessment.withinTolerance,
    };
  });
  const heldOut = results.filter((row) => row.phase === 'held-out');
  const summary = {
    algorithmVersion: TTS_TIMING_ALGORITHM_VERSION,
    primaryMetric: 'Total knowledge-lecture duration; individual clips are diagnostic only.',
    aggregateTiming: Object.fromEntries(['all', ...languages].map((language) => {
      const group = heldOut.filter((row) => language === 'all' || row.language === language);
      const predictedSec = group.reduce((sum, row) => sum + row.predictedSec, 0);
      const actualSec = group.reduce((sum, row) => sum + row.actualSec, 0);
      const errorRatio = actualSec / predictedSec - 1;
      return [language, { samples: group.length, predictedSec, actualSec, errorRatio, withinTolerance: Math.abs(errorRatio) <= 0.1 }];
    })),
    heldOut: heldOut.length, heldOutPass: heldOut.filter((row) => row.pass).length,
    meanAbsoluteRelativeError: heldOut.reduce((sum, row) => sum + Math.abs(row.errorRatio), 0) / heldOut.length,
    maxAbsoluteRelativeError: Math.max(...heldOut.map((row) => Math.abs(row.errorRatio))),
    languages: Object.fromEntries(languages.map((language) => [language, {
      total: heldOut.filter((row) => row.language === language).length,
      pass: heldOut.filter((row) => row.language === language && row.pass).length,
    }])),
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'results.json'), JSON.stringify({ ...corpus,
    algorithmVersion: TTS_TIMING_ALGORITHM_VERSION,
    previousEvaluation: corpus.previousEvaluation ?? { algorithmVersion: corpus.algorithmVersion, heldOutPass: heldOut.filter((row) => row.previousPass).length, heldOut: heldOut.length },
    replaySummary: summary, results,
  }, null, 2) + '\n');
  await fs.writeFile(path.join(outputDir, 'calibrations.json'), JSON.stringify({
    algorithmVersion: TTS_TIMING_ALGORITHM_VERSION,
    source: 'Independent offline calibration; six varied-length samples per language; median-normalized relative-error regression. See docs/verification/2026-09-14-tts-first-pass.md.', profiles,
  }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
