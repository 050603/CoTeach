import { describe, expect, it } from 'vitest';
import type { SpeechAction } from '@openmaic/lib/types/action';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';
import { planRegenerateApply } from './apply-regenerate';
import { regenerateSplitFixture } from './regenerate-split-fixture';
import { resolveSceneOutline } from './resolve-scene-outline';

describe('specified-page visual redesign planning', () => {
  it('produces one local transaction with conserved timing and independently editable pages', () => {
    const { scene, details, context } = regenerateSplitFixture();
    const plan = planRegenerateApply(details, scene, 'regenerate_scene', context);
    expect(plan.error).toBeUndefined();
    expect(plan.patch).toBeNull();
    const range = plan.sceneRange!;
    expect(range.before.scenes).toEqual([scene]);
    expect(range.before.outlines).toEqual(context.outlines);
    expect(range.after.scenes.map((page) => [page.title, page.targetDurationSec, page.segmentIndex])).toEqual([
      ['支持逐渐撤除', 44, 1], ['支架教学的五环节', 53, 2],
    ]);
    expect(range.after.scenes[0].id).toBe(scene.id);
    expect(range.after.scenes[1].id).not.toBe(scene.id);
    expect(range.after.scenes.every((page) => page.lectureSectionId === 'section')).toBe(true);
    expect(range.after.scenes.every((page) => page.content.type === 'slide' && !!page.content.canvas.teachingVisual)).toBe(true);
    expect(plan.snapshot?.sceneRange).toBe(range);
    expect(range.before.scenes[0].actions?.[0]).toHaveProperty('audioUrl', '/ready.wav');
    expect(range.after.scenes.every((page) => !page.narrationRevision)).toBe(true);
  });

  it('removes stale audio and alignment only from regenerated narration', () => {
    const { scene, details, context } = regenerateSplitFixture();
    const speech = details.visualRedesign!.pages[0].actions[0] as SpeechAction;
    Object.assign(speech, { audioId: 'old-audio', audioUrl: '/old.mp3', audioDurationSec: 44,
      speechAlignment: { version: 'test', status: 'pending', textHash: 'old', audioHash: 'old', spans: [] } });
    const range = planRegenerateApply(details, scene, 'regenerate_scene', context).sceneRange!;
    expect(range.after.scenes[0].actions![0]).toMatchObject({ text: speech.text, audioInvalidated: true });
    for (const key of ['audioId', 'audioUrl', 'audioDurationSec', 'speechAlignment']) {
      expect(range.after.scenes[0].actions![0]).not.toHaveProperty(key);
    }
    expect(context.scenes[2].actions?.[0]).toHaveProperty('audioUrl', '/next.wav');
    expect(range.before.scenes[0].actions?.[0]).toHaveProperty('audioId', 'old-audio');
  });

  it.each(['canvas', 'speech', 'title', 'outline', 'order', 'timing'])('refuses a concurrent %s change', (change) => {
    const { scene, details, context } = regenerateSplitFixture();
    if (change === 'canvas' && scene.content.type === 'slide') scene.content.canvas.background = { type: 'solid', color: '#aaa' };
    if (change === 'speech') scene.actions = [{ id: 'manual', type: 'speech', text: '最新教师讲稿' }];
    if (change === 'title') scene.title = '教师最新标题';
    if (change === 'outline') context.outlines = [{ ...context.outlines[0], keyPoints: ['教师最新教学条件'] }];
    if (change === 'order') scene.order = 2;
    if (change === 'timing') scene.targetDurationSec = 110;
    const plan = planRegenerateApply(details, scene, 'regenerate_scene', context);
    expect(plan.sceneRange).toBeUndefined();
    expect(plan).toMatchObject({
      snapshot: null, patch: null, error: expect.stringContaining('已保留'),
    });
  });

  it.each(['locked', 'modified', 'manual'])('refuses existing %s visual ownership', (kind) => {
    const { scene, details, context } = regenerateSplitFixture();
    scene.content = teachingVisualEditFixture();
    if (kind === 'manual') scene.content.canvas.teachingVisual!.manualElementIds = ['manual-caption'];
    else if (kind === 'locked') scene.content.canvas.teachingVisual!.components[0].locked = true;
    else scene.content.canvas.teachingVisual!.components[0].modified = true;
    context.requestScene = structuredClone(scene);
    details.visualRedesign!.before = { content: structuredClone(scene.content), actions: structuredClone(scene.actions!) };
    expect(planRegenerateApply(details, scene, 'regenerate_scene', context).error).toContain('已锁定或手动修改');
  });

  it.each(['duration', 'narration', 'target', 'order', 'too-many', 'continuation'])('refuses incomplete %s results without losing a page', (problem) => {
    const { scene, details, context } = regenerateSplitFixture();
    const pages = details.visualRedesign!.pages;
    if (problem === 'duration') pages[1].outline.targetDurationSec = 100;
    if (problem === 'narration') pages[1].actions = [];
    if (problem === 'target') pages[1].actions[1] = { id: 'invalid-cue', type: 'laser', elementId: 'from-another-page' };
    if (problem === 'order') pages[1].outline.segmentIndex = 1;
    if (problem === 'too-many') pages.push(pages[0], pages[1]);
    if (problem === 'continuation') pages[0].content.continuationPages = [pages[1].content];
    const plan = planRegenerateApply(details, scene, 'regenerate_scene', context);
    expect(plan.error).toBeTruthy();
    expect(plan.snapshot).toBeNull();
    expect(plan.sceneRange).toBeUndefined();
  });

  it('never silently applies only the first compiler continuation', () => {
    const { scene, details } = regenerateSplitFixture();
    const [first, second] = details.visualRedesign!.pages;
    const plan = planRegenerateApply({ sceneId: scene.id, content: { ...first.content, continuationPages: [second.content] }, actions: first.actions }, scene, 'regenerate_scene');
    expect(plan).toMatchObject({ patch: null, snapshot: null, error: expect.stringContaining('拆页结果缺少独立讲稿') });
  });

  it('carries historical timing and source outline identity into the server context', () => {
    const { scene, context } = regenerateSplitFixture();
    const historical = { ...scene, outlineId: undefined, title: '教师当前标题', order: 4 };
    expect(resolveSceneOutline(historical, context.outlines)).toMatchObject({
      id: scene.id, title: '教师当前标题', order: 4, targetDurationSec: 97, estimatedDuration: 97, lectureSectionId: 'section',
    });
    expect(resolveSceneOutline({ ...scene, title: '当前标题', order: 5 }, context.outlines)).toMatchObject({
      id: 'outline', title: '当前标题', order: 5, keyPoints: context.outlines[0].keyPoints,
    });
  });
});
