import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { CourseTextbookFigureResource } from './course-evidence-types';
import {
  assertRequiredTextbookFiguresAvailable,
  bindRequiredTextbookFiguresToOutlines,
} from './course-visual-binding';

const pages: SceneOutline[] = [
  {
    id: 'first', type: 'slide', title: '首次完整讲解', description: '解释机制', keyPoints: ['机制'], order: 0,
    generationPurpose: 'knowledge-teaching', knowledgePointIds: ['kp-1'],
  },
  {
    id: 'review', type: 'slide', title: '复习', description: '回顾机制', keyPoints: ['复习'], order: 1,
    generationPurpose: 'knowledge-teaching', knowledgePointIds: ['kp-1'],
    suggestedImageIds: ['textbook_fig_1'],
  },
];

const resource: CourseTextbookFigureResource = {
  id: 'textbook_fig_1', figureId: 'figure-1', assetId: 'asset-1', src: '/api/uploads/asset-1',
  pageNumber: 12, description: '教材原图；观察案例中的关键差异', relation: 'direct',
  required: true, evidenceItemIds: ['evidence-1'], knowledgePointIds: ['kp-1'],
  sourceTitle: '人工智能教学', status: 'available',
};

describe('required textbook figure binding', () => {
  it('moves a required original to the first full teaching page and records the adopted intent', () => {
    const result = bindRequiredTextbookFiguresToOutlines(pages, [resource]);
    expect(result[0]).toMatchObject({
      suggestedImageIds: ['textbook_fig_1'],
      visualIntent: {
        representation: 'source-image',
        resourceRefs: [{ resourceId: 'textbook_fig_1', kind: 'source-image', required: true }],
      },
    });
    expect(result[1]?.suggestedImageIds).toBeUndefined();
  });

  it('preserves a native relationship view and combines it with the required source image', () => {
    const result = bindRequiredTextbookFiguresToOutlines([{ ...pages[0]!, visualIntent: {
      observationGoal: '比较机制关系', representation: 'native-diagram', rationale: '关系图更清楚',
    } }], [resource]);
    expect(result[0]?.visualIntent).toMatchObject({
      observationGoal: '比较机制关系', representation: 'mixed', rationale: '关系图更清楚',
    });
  });

  it('fails before generation when no teaching slide can own a mandatory original', () => {
    expect(() => bindRequiredTextbookFiguresToOutlines([{ ...pages[0]!, type: 'interactive' }], [resource]))
      .toThrow('没有可绑定的首次知识讲解页');
  });

  it('blocks completion when a mandatory original is unavailable', () => {
    expect(() => assertRequiredTextbookFiguresAvailable([{
      ...resource,
      assetId: undefined,
      src: undefined,
      status: 'unavailable',
      failureReason: '教材图片文件已删除',
    }])).toThrow('课程不能标记为完整生成');
  });
});
