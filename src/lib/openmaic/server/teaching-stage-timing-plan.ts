import type { SceneOutline } from '@openmaic/lib/types/generation';
import { buildTtsTimingPlan, estimateSpeechDurationSec } from '@openmaic/lib/audio/tts-timing';

export interface TeachingStageTimingBudget {
  schemaVersion: 1;
  stageKey: string;
  targetDurationSec: number;
  minDurationSec: number;
  maxDurationSec: number;
  narrationTargetDurationSec: number;
  reservedDurationSec: number;
  pageCount: number;
  allocation: 'content-weighted';
  acceptance: 'stage-total-only';
}

/** Pre-authoring allocation only. Completed narration is never checked or rewritten here. */
export function allocateTeachingStageTiming(outlines: SceneOutline[]): SceneOutline[] {
  const groups = new Map<string, SceneOutline[]>();
  for (const outline of outlines) {
    if (outline.audience === 'teacher' || (outline.stageKey && outline.stageKey !== 'ai-learning')) continue;
    const key = outline.stageKey ?? 'course-narration';
    groups.set(key, [...(groups.get(key) ?? []), outline]);
  }
  const updates = new Map<string, SceneOutline>();
  for (const [stageKey, members] of groups) {
    // Prepared checkpoints retain their allocation, even when the estimator evolves.
    if (members.some((outline) => outline.teachingStageTiming)) continue;
    if (members.every((outline) => outline.plannedTiming)) {
      const target = members.reduce((sum, outline) => sum + (outline.targetDurationSec ?? outline.estimatedDuration ?? 60), 0);
      const narrationTarget = members.reduce((sum, outline) => sum + outline.plannedTiming!.narrationSec, 0);
      const stageBudget: TeachingStageTimingBudget = {
        schemaVersion: 1,
        stageKey,
        targetDurationSec: target,
        minDurationSec: Math.round(target * 900) / 1000,
        maxDurationSec: Math.round(target * 1100) / 1000,
        narrationTargetDurationSec: narrationTarget,
        reservedDurationSec: target - narrationTarget,
        pageCount: members.length,
        allocation: 'content-weighted',
        acceptance: 'stage-total-only',
      };
      for (const outline of members) updates.set(outline.id, { ...outline, teachingStageTiming: stageBudget });
      continue;
    }
    const narrated = members.filter((outline) => outline.timingPlan);
    if (!narrated.length) continue;
    const target = members.reduce((sum, outline) => sum + (outline.targetDurationSec ?? outline.estimatedDuration ?? 60), 0);
    const narrationTarget = narrated.reduce((sum, outline) => sum + outline.timingPlan!.targetDurationSec, 0);
    const weights = narrated.map((outline) => {
      const plan = outline.timingPlan!;
      const content = outline.keyPoints.length ? outline.keyPoints.join('。') : outline.description || outline.title;
      const contentSeconds = estimateSpeechDurationSec(content, plan);
      // Temper outline length with the planner's allocation: long wording alone
      // must not consume the whole stage. This is an explicit planning heuristic.
      return Math.sqrt(Math.max(1, contentSeconds) * Math.max(1, plan.targetDurationSec));
    });
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    const exact = weights.map((weight) => 1 + Math.max(0, narrationTarget - narrated.length) * weight / weightSum);
    const seconds = exact.map(Math.floor);
    let remainder = Math.round(narrationTarget - seconds.reduce((sum, value) => sum + value, 0));
    for (const index of exact.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index)) {
      if (remainder-- <= 0) break;
      seconds[index.index]++;
    }
    const stageBudget: TeachingStageTimingBudget = {
      schemaVersion: 1, stageKey, targetDurationSec: target,
      minDurationSec: Math.round(target * 900) / 1000, maxDurationSec: Math.round(target * 1100) / 1000,
      narrationTargetDurationSec: narrationTarget, reservedDurationSec: target - narrationTarget,
      pageCount: members.length, allocation: 'content-weighted', acceptance: 'stage-total-only',
    };
    narrated.forEach((outline, index) => {
      const plan = outline.timingPlan!;
      const reserved = (plan.activityTargetDurationSec ?? outline.targetDurationSec ?? outline.estimatedDuration ?? plan.targetDurationSec) - plan.targetDurationSec;
      const activityTarget = reserved + seconds[index];
      updates.set(outline.id, {
        ...outline, targetDurationSec: activityTarget, estimatedDuration: activityTarget,
        teachingStageTiming: stageBudget,
        timingPlan: buildTtsTimingPlan({
          ...plan, targetDurationSec: seconds[index], activityTargetDurationSec: activityTarget,
          feedbackSec: Math.min(plan.feedbackSec ?? 0, seconds[index]),
          timingRationale: [...(plan.timingRationale ?? []), '按教学内容量分配讲稿；仅知识讲授阶段总时长采用 ±10% 验收，页与段不单独判定。'],
        }),
      });
    });
    for (const outline of members) if (!updates.has(outline.id)) updates.set(outline.id, { ...outline, teachingStageTiming: stageBudget });
  }
  return outlines.map((outline) => updates.get(outline.id) ?? outline);
}
