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

  it('keeps a required textbook original only with the split page that renders it', () => {
    const source = { ...outline,
      visualIntent: { observationGoal: '观察教材图', representation: 'source-image' as const,
        resourceRefs: [{ resourceId: 'textbook_fig_32', kind: 'source-image' as const,
          required: true, reason: '教材原图' }] },
      teachingBrief: { schemaVersion: 1 as const, explanation: '解释', examples: [], conditions: [], evidence: [],
        assessmentFocus: '理解', resourceNeeds: [{ kind: 'source-image' as const,
          assetId: 'textbook_fig_32', required: true, purpose: '教材原图' }] },
    };
    const split: GeneratedSlideContent = { ...content, elements: [],
      continuationPages: [{ ...content.continuationPages![0]!, elements: [{
        id: 'source-image', type: 'image', left: 50, top: 150, width: 400, height: 300,
        src: 'textbook_fig_32', fixedRatio: true, rotate: 0,
      }] }] };
    const result = expandCompiledSlidePages(source, split);
    expect(result[0]?.outline.visualIntent?.resourceRefs).toEqual([]);
    expect(result[0]?.outline.teachingBrief?.resourceNeeds).toEqual([]);
    expect(result[1]?.outline.visualIntent?.resourceRefs?.[0]?.resourceId).toBe('textbook_fig_32');
    expect(result[1]?.outline.teachingBrief?.resourceNeeds?.[0]?.assetId).toBe('textbook_fig_32');
  });

  it('allocates adopted time by measured teaching load when the compiler provides it', () => {
    const weighted: GeneratedSlideContent = {
      ...content,
      layoutMeasurement: { bodyCapacity: 400, occupiedHeight: 300, contentLoad: 0.75,
        pageIndex: 1, pageCount: 2, sourceGroupIds: ['observation'] },
      continuationPages: [{ ...content.continuationPages![0]!,
        layoutMeasurement: { bodyCapacity: 400, occupiedHeight: 100, contentLoad: 0.25,
          pageIndex: 2, pageCount: 2, sourceGroupIds: ['explanation'] } }],
    };
    const pages = expandCompiledSlidePages(outline, weighted);
    expect(pages.map((page) => page.outline.plannedTiming?.narrationSec)).toEqual([40, 13]);
    expect(pages.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(61);
    expect(pages[0]?.outline.teachingBrief?.teachingPlan?.introduces).toBeUndefined();
  });
});
