import { describe, expect, it } from 'vitest';
import type { SceneContent } from '@openmaic/lib/types/stage';
import type { GeneratedSlideContent } from '@openmaic/lib/types/generation';
import type { Action } from '@openmaic/lib/types/action';
import { planRegenerateApply, toRuntimeSlideContent } from './apply-regenerate';

const content = { type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625,
  theme: { fontName: 'Noto Sans SC' }, elements: [{ id: 'old' }], displayItems: [{ id: 'old-source' }],
  contentBindings: [{ sourceContentId: 'old-source', elementId: 'old' }], presentationProjection: { old: true },
  animations: [{ id: 'old-animation', elId: 'old' }], qualityDiagnostics: ['old diagnosis'] } } as unknown as SceneContent;
const generated: GeneratedSlideContent = { elements: [], contentBindings: [], qualityDiagnostics: ['actual diagnosis'] };
const actions: Action[] = [{ id: 'speech', type: 'speech', text: '完整讲稿', audioId: 'audio', audioUrl: '/audio.wav' }];

describe('apply native PPT-only redraw', () => {
  it('replaces visual metadata and clears stale projection while preserving canvas identity', () => {
    const runtime = toRuntimeSlideContent(generated, (content as unknown as { canvas: Record<string, unknown> }).canvas);
    expect(runtime).toMatchObject({ type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625,
      contentBindings: [], qualityDiagnostics: ['actual diagnosis'], animations: [] } });
    expect((runtime as { canvas: object }).canvas).not.toHaveProperty('displayItems');
    expect((runtime as { canvas: object }).canvas).not.toHaveProperty('presentationProjection');
    expect(content).toHaveProperty('canvas.presentationProjection');
  });

  it('preserves exact saved actions and refuses a result based on an older canvas or narration', () => {
    const details = { sceneId: 'scene', content: generated, actions: structuredClone(actions),
      visualPatch: { beforeContent: structuredClone(content), beforeActions: structuredClone(actions) } };
    const plan = planRegenerateApply(details, { content, actions }, 'regenerate_scene');
    expect(plan.patch?.actions).toEqual(actions);
    expect(plan.snapshot).toEqual({ sceneId: 'scene', content, actions });
    const changedSpeech: Action[] = [{ ...actions[0], type: 'speech', text: '老师更新的讲稿' }];
    expect(planRegenerateApply(details, { content, actions: changedSpeech }, 'regenerate_scene')).toMatchObject({
      patch: null, snapshot: null, error: expect.stringContaining('已保留你的最新内容'),
    });
    const changedCanvas = structuredClone(content);
    if (changedCanvas.type === 'slide') changedCanvas.canvas.elements = [];
    expect(planRegenerateApply(details, { content: changedCanvas, actions }, 'regenerate_scene').patch).toBeNull();
  });

  it('applies an empty rebound cue list explicitly and retains the legacy empty-action behavior', () => {
    const details = { sceneId: 'scene', content: generated, actions: [],
      visualPatch: { beforeContent: content, beforeActions: actions } };
    expect(planRegenerateApply(details, { content, actions }, 'regenerate_scene').patch?.actions).toEqual([]);
    expect(planRegenerateApply({ sceneId: 'scene', content: generated, actions: [] }, { content, actions }, 'regenerate_scene').patch)
      .not.toHaveProperty('actions');
  });
});
