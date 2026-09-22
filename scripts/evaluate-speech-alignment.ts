#!/usr/bin/env -S pnpm exec tsx

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  alignSpeechFile,
  type SpeechAlignmentSpan,
} from '../src/lib/openmaic/server/speech-alignment';

type AnchorAnnotation = {
  quote: string;
  occurrence?: number;
  expectedStartMs: number;
};

type EvaluationManifest = {
  audioPath: string;
  text: string;
  language?: string;
  anchors: AnchorAnnotation[];
};

function quoteStart(text: string, quote: string, occurrence = 0): number {
  if (!quote || occurrence < 0 || !Number.isInteger(occurrence)) return -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(quote, from);
    if (found < 0) return -1;
    if (index === occurrence) return found;
    from = found + Math.max(1, quote.length);
  }
  return -1;
}

function alignedStart(spans: readonly SpeechAlignmentSpan[], startChar: number): number | undefined {
  return spans.find((span) => span.startChar <= startChar && span.endChar > startChar)?.startMs
    ?? spans.find((span) => span.startChar >= startChar)?.startMs;
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

async function main() {
  const manifestArgument = process.argv[2];
  if (!manifestArgument) {
    throw new Error('用法：pnpm exec tsx scripts/evaluate-speech-alignment.ts <人工标注.json> [--no-cache]');
  }
  const manifestPath = path.resolve(manifestArgument);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvaluationManifest;
  if (!Array.isArray(manifest.anchors) || manifest.anchors.length < 20) {
    throw new Error('验收清单至少需要 20 个由人工听音标注的动作触发点');
  }
  const startedAt = performance.now();
  const result = await alignSpeechFile({
    audioPath: path.resolve(path.dirname(manifestPath), manifest.audioPath),
    text: manifest.text,
    language: manifest.language,
    cacheDir: process.argv.includes('--no-cache') ? false : undefined,
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const anchors = manifest.anchors.map((annotation) => {
    const startChar = quoteStart(manifest.text, annotation.quote, annotation.occurrence);
    if (startChar < 0) throw new Error(`人工标注词句不在原讲稿中：${annotation.quote}`);
    const actualStartMs = alignedStart(result.spans, startChar);
    if (actualStartMs === undefined) throw new Error(`对齐结果未覆盖人工标注词句：${annotation.quote}`);
    return {
      ...annotation,
      occurrence: annotation.occurrence ?? 0,
      actualStartMs,
      absoluteErrorMs: Math.abs(actualStartMs - annotation.expectedStartMs),
    };
  });
  const p95Ms = percentile95(anchors.map((anchor) => anchor.absoluteErrorMs));
  const report = {
    passed: p95Ms <= 300,
    targetP95Ms: 300,
    p95Ms,
    elapsedMs,
    audioDurationMs: result.durationMs,
    realTimeFactor: Number((elapsedMs / result.durationMs).toFixed(3)),
    alignmentVersion: result.version,
    anchors,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
