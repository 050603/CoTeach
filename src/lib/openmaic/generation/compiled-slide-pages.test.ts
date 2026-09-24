import { describe, expect, it } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { expandCompiledSlidePages } from './compiled-slide-pages';

const outline: SceneOutline = {
  id: 'page', type: 'slide', title: '观察与解释', description: '先观察对象，再解释差异',
  keyPoints: ['观察', '解释'], order: 0, targetDurationSec: 61,
  plannedTiming: { narrationSec: 53, learnerActivitySec: 5, transitionSec: 3, role: 'teaching' },
  knowledgePointIds: ['kp'], lectureSectionId: 'section',
  mediaGenerations: [{ type: 'image', prompt: '观察差异', elementId: 'image', aspectRatio: '4:3' }],
  visualIntent: { observationGoal: '观察差异', representation: 'mixed',
    resourceRefs: [{ resourceId: 'image', kind: 'generated-image', required: true, reason: '观察' }] },
};
const content: GeneratedSlideContent = {
  elements: [{ id: 'image', type: 'image', left: 50, top: 150, width: 400, height: 300, src: 'image', fixedRatio: true, rotate: 0 }],
  sourceGroupIds: ['observation'], teachingText: ['先看外观'],
  continuationPages: [{ elements: [], sourceGroupIds: ['explanation'], teachingText: ['解释差异的原因'] }],
};

describe('first-pass semantic pagination', () => {
  it('keeps all content and stable targets while conserving the adopted timing', () => {
    const result = expandCompiledSlidePages(outline, content);
    expect(result.map((page) => page.outline.id)).toEqual(['page', 'page--continuation-2']);
    expect(result.map((page) => page.outline.keyPoints)).toEqual([['先看外观'], ['解释差异的原因']]);
    expect(result.every((page) => page.outline.lectureSectionId === 'section')).toBe(true);
    expect(result.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(61);
    for (const part of ['narrationSec', 'learnerActivitySec', 'transitionSec'] as const) {
      expect(result.reduce((sum, page) => sum + page.outline.plannedTiming![part], 0)).toBe(outline.plannedTiming![part]);
    }
    expect(result[0].content.elements[0].id).toBe('image');
    expect(result[0].content.continuationPages).toBeUndefined();
    expect(result[0].outline.mediaGenerations).toHaveLength(1);
    expect(result[1].outline.mediaGenerations).toHaveLength(0);
    expect(result[1].outline.visualIntent?.resourceRefs).toHaveLength(0);
    expect(content.continuationPages).toHaveLength(1);
  });

  it('leaves unexpanded pages unchanged and does not invent timing for impossible splits', () => {
    const ordinary = { elements: [] };
    expect(expandCompiledSlidePages(outline, ordinary)).toEqual([{ outline, content: ordinary }]);
    expect(() => expandCompiledSlidePages({ ...outline, targetDurationSec: 1 }, content)).toThrow('教学时间不足');
  });
});
