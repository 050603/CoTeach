import type { NarrationSegment } from "./types";

export interface SegmentDuration {
  segmentId: string;
  durationSec: number;
}

export interface CourseDurationEvaluation {
  actualDurationSec: number;
  targetDurationSec: number;
  minimumDurationSec: number;
  maximumDurationSec: number;
  withinTolerance: boolean;
  /** Per-page targets are guidance for a later repair, never pass/fail gates. */
  pageTargets: Array<{ pageId: string; targetDurationSec: number }>;
}

export function evaluateCourseDuration(input: {
  narration: readonly NarrationSegment[];
  audio: readonly SegmentDuration[];
  targetDurationSec?: number;
  tolerance?: number;
}): CourseDurationEvaluation {
  const targetDurationSec = input.targetDurationSec ?? 180;
  const tolerance = input.tolerance ?? 0.1;
  if (!(targetDurationSec > 0)) throw new Error("Target duration must be positive");
  if (!(tolerance >= 0 && tolerance < 1)) throw new Error("Duration tolerance must be in [0, 1)");
  const audioBySegment = new Map(input.audio.map((item) => [item.segmentId, item.durationSec]));
  const missing = input.narration.filter((segment) => !audioBySegment.has(segment.id));
  if (missing.length > 0) {
    throw new Error(`Missing measured audio for segments: ${missing.map((item) => item.id).join(", ")}`);
  }
  const actualDurationSec = input.narration.reduce(
    (sum, segment) => sum + (audioBySegment.get(segment.id) ?? 0),
    0,
  );
  const minimumDurationSec = targetDurationSec * (1 - tolerance);
  const maximumDurationSec = targetDurationSec * (1 + tolerance);
  const textUnitsByPage = new Map<string, number>();
  for (const segment of input.narration) {
    const units = [...segment.text].filter((character) => !/\s/u.test(character)).length;
    textUnitsByPage.set(segment.pageId, (textUnitsByPage.get(segment.pageId) ?? 0) + units);
  }
  const totalUnits = [...textUnitsByPage.values()].reduce((sum, units) => sum + units, 0);
  const pageTargets = [...textUnitsByPage.entries()].map(([pageId, units]) => ({
    pageId,
    targetDurationSec: totalUnits === 0
      ? targetDurationSec / Math.max(1, textUnitsByPage.size)
      : targetDurationSec * units / totalUnits,
  }));
  return {
    actualDurationSec,
    targetDurationSec,
    minimumDurationSec,
    maximumDurationSec,
    withinTolerance: actualDurationSec >= minimumDurationSec
      && actualDurationSec <= maximumDurationSec,
    pageTargets,
  };
}

