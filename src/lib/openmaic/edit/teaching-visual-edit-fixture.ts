import type { SlideContent } from '@openmaic/lib/types/stage';
import { createDefaultImageElement, createDefaultSlide, createDefaultTextElement } from './slide-edit-elements';

/** Shared source-grounded editing fixture; no model or transport dependency. */
export function teachingVisualEditFixture(): SlideContent {
  return {
    type: 'slide',
    canvas: {
      ...createDefaultSlide('visual-slide'),
      elements: [
        { ...createDefaultTextElement('title'), content: '<p>观察教学支持</p>' },
        { ...createDefaultTextElement('support-label'), content: '<p>逐步撤除</p>' },
        createDefaultImageElement('support-image', '/textbook.png'),
        { ...createDefaultTextElement('evaluation-label'), content: '<p>评价主体</p>' },
      ],
      teachingVisual: {
        scene: {
          schemaVersion: 1,
          designVersion: 'teaching-visual-v2',
          pages: [{
            id: 'page', title: '观察教学支持', focus: '支持如何撤除',
            components: [
              { id: 'support', kind: 'state-change', nodes: [{ id: 'withdraw', text: '逐步撤除', sourceContentIds: ['source-1'] }] },
              { id: 'evaluation', kind: 'comparison', nodes: [{ id: 'subjects', text: '评价主体', sourceContentIds: ['source-2'] }] },
            ],
          }],
        },
        pageId: 'page', candidateId: 'focus-wide', compilerVersion: 'test-compiler', themeVersion: 'test-theme',
        components: [
          { id: 'support', kind: 'state-change', elementIds: ['support-label', 'support-image'], sourceContentIds: ['source-1'] },
          { id: 'evaluation', kind: 'comparison', elementIds: ['evaluation-label'], sourceContentIds: ['source-2'] },
        ],
      },
    },
  };
}
