import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { buildTtsTimingPlan } from '@openmaic/lib/audio/tts-timing';
import { allocateTeachingStageTiming } from './teaching-stage-timing-plan';

function page(id: string, content: string, overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id, title: id, description: content, keyPoints: [content], type: 'slide', order: 0,
    stageKey: 'ai-learning', audience: 'student', targetDurationSec: 100, estimatedDuration: 100,
    timingPlan: buildTtsTimingPlan({ targetDurationSec: 80, activityTargetDurationSec: 100, language: 'zh-CN', videoSec: 10, transitionSec: 3, studentActivitySec: 7, readingThinkingSec: 7 }),
    ...overrides,
  };
}

describe('teaching stage timing', () => {
  it('gives denser teaching content more narration while preserving the stage total and silent/video time', () => {
    const result = allocateTeachingStageTiming([
      page('brief', '给出定义。'),
      page('detailed', '说明能量守恒的适用条件，利用电路的例子解释输入与输出，再通过两组实际测量数据说明系统边界的重要性。'),
    ]);
    expect(result[1].timingPlan!.targetDurationSec).toBeGreaterThan(result[0].timingPlan!.targetDurationSec);
    expect(result.reduce((sum, row) => sum + row.targetDurationSec!, 0)).toBe(200);
    expect(result.reduce((sum, row) => sum + row.timingPlan!.targetDurationSec, 0)).toBe(160);
    for (const row of result) {
      expect(row.teachingStageTiming).toMatchObject({ targetDurationSec: 200, minDurationSec: 180, maxDurationSec: 220, narrationTargetDurationSec: 160, reservedDurationSec: 40, acceptance: 'stage-total-only' });
      expect(row.timingPlan).toMatchObject({ videoSec: 10, transitionSec: 3, studentActivitySec: 7 });
      expect(row.timingPlan!.paragraphBudgets!.reduce((sum, part) => sum + part.targetDurationSec, 0)).toBe(row.timingPlan!.targetDurationSec);
    }
  });

  it('counts student activities without narration but never borrows time from teacher resources or other stages', () => {
    const teacher = page('teacher', '教师资料', { audience: 'teacher' });
    const project = page('project', '项目实践', { stageKey: 'implementation' });
    const result = allocateTeachingStageTiming([page('lesson', '定义'), page('silent', '阅读任务', { timingPlan: undefined, ttsPolicy: 'none', targetDurationSec: 30, estimatedDuration: 30 }), teacher, project]);
    expect(result[0].teachingStageTiming).toMatchObject({ targetDurationSec: 130, narrationTargetDurationSec: 80, reservedDurationSec: 50, pageCount: 2 });
    expect(result[1].targetDurationSec).toBe(30);
    expect(result[2]).toBe(teacher);
    expect(result[3]).toBe(project);
  });

  it('keeps integer totals and prepared allocations across repeated preparation', () => {
    const result = allocateTeachingStageTiming([page('one', '能量'), page('two', '能量守恒'), page('three', '用实例说明能量守恒')]);
    expect(result.reduce((sum, row) => sum + row.targetDurationSec!, 0)).toBe(300);
    expect(result.every((row) => Number.isInteger(row.targetDurationSec))).toBe(true);
    expect(allocateTeachingStageTiming(result)).toEqual(result);
  });
});
