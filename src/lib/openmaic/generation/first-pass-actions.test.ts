import { describe, expect, it, vi } from 'vitest';
import { generateSceneActions } from './scene-generator';
import { buildTtsTimingPlan } from '../audio/tts-timing';
import type { SceneOutline } from '../types/generation';

describe('first-pass teaching actions', () => {
  it('reports an unparseable formal action script instead of disguising it as a summary', async () => {
    const ai = vi.fn().mockResolvedValue('not valid actions');
    await expect(generateSceneActions({ id: 'broken', type: 'slide', title: 't', description: 'd', keyPoints: [], order: 0 }, { elements: [] }, ai))
      .rejects.toMatchObject({ code: 'INVALID_ACTION_OUTPUT' });
    expect(ai).toHaveBeenCalledOnce();
  });
  it('provides paragraph budgets before authoring, without rewriting a short script or broken board', async () => {
    const outline: SceneOutline = {
      id: 'first', type: 'slide', title: '公式', description: '解释公式条件', keyPoints: ['x=2'], order: 0,
      timingPlan: buildTtsTimingPlan({ targetDurationSec: 120, videoSec: 10, activityTargetDurationSec: 130, language: 'zh-CN' }),
      teachingStageTiming: { schemaVersion: 1, stageKey: 'ai-learning', targetDurationSec: 900, minDurationSec: 810, maxDurationSec: 990, narrationTargetDurationSec: 800, reservedDurationSec: 100, pageCount: 6, allocation: 'content-weighted', acceptance: 'stage-total-only' },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { type: 'text', content: '短讲解。' },
      { type: 'action', name: 'wb_draw_latex', params: { latex: '\\frac{x}{', x: 60, y: 80, width: 500, height: 100 } },
    ]));
    const actions = await generateSceneActions(outline, { elements: [] }, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0][1]).toContain('about 120 seconds');
    expect(ai.mock.calls[0][1]).toContain(`${outline.timingPlan!.minUnits}-${outline.timingPlan!.maxUnits}`);
    expect(ai.mock.calls[0][1]).not.toContain('总目标 900 秒');
    expect(actions.some((action) => action.type === 'speech' && action.text === '短讲解。')).toBe(true);
    expect(actions.some((action) => action.type === 'wb_draw_latex')).toBe(true);
  });
});
