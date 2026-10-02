import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent } from '../types/generation';
import type { SlideContent } from '../types/stage';
import { teachingVisualEditFixture } from './teaching-visual-edit-fixture';
import { createDefaultImageElement, createDefaultShapeElement, createDefaultTextElement } from './slide-edit-elements';
import { applySlideEditOperation } from './slide-ops';

const mocks = vi.hoisted(() => ({ compile: vi.fn() }));
vi.mock('../generation/teaching-visual-compiler', () => ({ compileTeachingVisualScene: mocks.compile }));

import { recomposeTeachingVisualSlide } from './teaching-visual-recompose';

function fixture(): SlideContent {
  const content = teachingVisualEditFixture();
  Object.assign(content.canvas.elements[0], { left: 50, top: 28, width: 700, height: 48 });
  Object.assign(content.canvas.elements[1], { left: 50, top: 140, width: 220, height: 60 });
  Object.assign(content.canvas.elements[2], { left: 50, top: 210, width: 220, height: 150 });
  Object.assign(content.canvas.elements[3], { left: 650, top: 160, width: 180, height: 72 });
  content.canvas.teachingVisual!.candidateId = 'visual-1';
  content.canvas.presentationProjection = {
    schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true,
    items: [{ id: 'withdraw', text: '逐步撤除', sourceContentIds: ['source-1'] },
      { id: 'subjects', text: '评价主体', sourceContentIds: ['source-2'] }], links: [],
    elementIdsBySource: { 'source-1': ['support-label', 'support-image'], 'source-2': ['evaluation-label'] },
  };
  return content;
}

function candidate(content: SlideContent, candidateId = 'visual-2'): GeneratedSlideContent {
  const next = structuredClone(content.canvas);
  next.teachingVisual!.candidateId = candidateId;
  next.elements.find((element) => element.id === 'evaluation-label')!.left = 550;
  return next;
}

beforeEach(() => { mocks.compile.mockReset(); });

describe('measured teaching visual recomposition', () => {
  it('freezes other components before measurement and returns a usable local layout', async () => {
    const original = fixture();
    const next = candidate(original);
    next.elements.find((element) => element.id === 'support-label')!.left = 150;
    mocks.compile.mockResolvedValue(next);
    const result = await recomposeTeachingVisualSlide(original, { componentId: 'evaluation' });
    expect(result.canvas.elements.find((element) => element.id === 'support-label')).toEqual(original.canvas.elements[1]);
    expect(result.canvas.elements.find((element) => element.id === 'evaluation-label')?.left).toBe(550);
    const options = mocks.compile.mock.calls[0][2];
    expect(options.previous.teachingVisual.components[0].locked).toBe(true);
    expect(options.allowSplit).toBe(false);
    expect(options.allowedCandidateIds).toEqual(['visual-2']);
    expect(result.canvas.teachingVisual?.components[0].locked).toBeUndefined();
    expect(result.canvas.teachingVisual?.components[1].modified).toBeUndefined();
    expect(original.canvas.teachingVisual?.candidateId).toBe('visual-1');
    expect(document.querySelector('.slide-renderer-prose')).toBeNull();
    expect(document.querySelector('[data-teaching-visual-measure]')).toBeNull();
  });

  it('keeps manual images outside compiler resource requirements', async () => {
    const original = fixture();
    const manual = { ...createDefaultImageElement('manual-image', '/teacher.png'), left: 800, top: 430, width: 100, height: 80 };
    const edited = applySlideEditOperation(original, { type: 'element.add', element: manual });
    mocks.compile.mockResolvedValue(candidate(original));
    const result = await recomposeTeachingVisualSlide(edited);
    expect(mocks.compile.mock.calls[0][2].images).toEqual([]);
    expect(result.canvas.elements.find((element) => element.id === 'manual-image')).toEqual(manual);
    expect(result.canvas.teachingVisual?.manualElementIds).toEqual(['manual-image']);
  });

  it('keeps legacy playback cue IDs and updates their projected bounds', async () => {
    const original = fixture();
    const alias = { ...createDefaultShapeElement('outline:visible-1'), left: 650, top: 160, width: 180, height: 72, opacity: 0 };
    original.canvas.elements.push(alias);
    const next = candidate(original);
    next.elements = next.elements.filter((element) => element.id !== alias.id);
    next.elements.push({ ...alias, id: 'page:visible-1', left: 550 });
    mocks.compile.mockResolvedValue(next);
    const result = await recomposeTeachingVisualSlide(original);
    expect(result.canvas.elements.find((element) => element.id === alias.id)).toMatchObject({ left: 550, top: 160, width: 180, height: 72 });
    expect(result.canvas.elements.find((element) => element.id === 'page:visible-1')).toBeUndefined();
    expect(new Set(result.canvas.elements.map((element) => element.id)).size).toBe(result.canvas.elements.length);
  });

  it('carries textbook image captions and their exact symbols into composition', async () => {
    const original = fixture();
    const component = original.canvas.teachingVisual!.scene.pages[0].components[0];
    component.kind = 'annotated-image';
    component.resourceId = 'support-image';
    original.canvas.teachingVisual!.components[0].kind = 'annotated-image';
    original.canvas.teachingVisual!.components[0].elementIds.push('support-image-caption');
    original.canvas.elements.push({ ...createDefaultTextElement('support-image-caption'),
      left: 50, top: 370, width: 220, height: 30, content: '<p>图 A：T &lt; 25 °C</p>' });
    mocks.compile.mockResolvedValue(candidate(original));
    await recomposeTeachingVisualSlide(original);
    expect(mocks.compile.mock.calls[0][2].images).toEqual([expect.objectContaining({ id: 'support-image', caption: '图 A：T < 25 °C' })]);
  });

  it('rejects new collisions with teacher notes and disposes measurement DOM', async () => {
    const original = fixture();
    original.canvas.elements.push({ ...createDefaultImageElement('note', '/note.png'), left: 400, top: 180, width: 100, height: 80 });
    const next = candidate(original);
    next.elements.find((element) => element.id === 'evaluation-label')!.left = 410;
    mocks.compile.mockResolvedValueOnce(next).mockResolvedValueOnce(null);
    await expect(recomposeTeachingVisualSlide(original)).rejects.toThrow('没有其他可读');
    expect(mocks.compile).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.slide-renderer-prose')).toBeNull();
    expect(document.querySelector('[data-teaching-visual-measure]')).toBeNull();
    expect(original.canvas.teachingVisual?.candidateId).toBe('visual-1');
  });

  it('protects locked or manually edited targets before invoking the compiler', async () => {
    const original = fixture();
    const edited = applySlideEditOperation(original, { type: 'element.delete', elementId: 'support-image' });
    await expect(recomposeTeachingVisualSlide(edited, { componentId: 'support' })).rejects.toThrow('此构件已保留');
    expect(mocks.compile).not.toHaveBeenCalled();
  });
});
