// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import {
  missingRequiredTextbookImageIds,
  textbookImagesForOutline,
  type GenerateClassroomInput,
} from './classroom-generation';

type TextbookImage = NonNullable<GenerateClassroomInput['textbookImages']>[number];

function image(id: string, required: boolean): TextbookImage {
  return {
    id,
    src: `data:image/png;base64,${id}`,
    pageNumber: 1,
    figureId: `figure-${id}`,
    assetId: `asset-${id}`,
    textbookRelation: required ? 'direct' : 'candidate',
    evidenceItemIds: ['evidence-1'],
    knowledgePointIds: ['kp-1'],
    sourceTitle: '教材',
    required,
  };
}

describe('page-scoped textbook visuals', () => {
  it('passes only the source images adopted for the current page', () => {
    const images = [image('textbook_fig_required', true), image('textbook_fig_other', false)];
    const outline = {
      id: 'page-1', type: 'slide', title: '页面', description: '', keyPoints: [], order: 0,
      suggestedImageIds: ['textbook_fig_required'],
    } satisfies SceneOutline;
    expect(textbookImagesForOutline(outline, images).map((item) => item.id))
      .toEqual(['textbook_fig_required']);
  });

  it('accepts resource references from the visual intent without exposing the full course pool', () => {
    const images = [image('textbook_fig_required', true), image('textbook_fig_other', false)];
    const outline = {
      id: 'page-1', type: 'slide', title: '页面', description: '', keyPoints: [], order: 0,
      visualIntent: {
        observationGoal: '观察教材原图中的关键差异',
        representation: 'source-image',
        required: true,
        resourceRefs: [{ resourceId: 'textbook_fig_required', kind: 'source-image', required: true }],
      },
    };
    expect(textbookImagesForOutline(outline, images).map((item) => item.id))
      .toEqual(['textbook_fig_required']);
  });

  it('reports a required original image when the generated page omits it', () => {
    const required = image('textbook_fig_required', true);
    const other = image('textbook_fig_other', false);
    const missing: GeneratedSlideContent = { elements: [] };
    expect(missingRequiredTextbookImageIds(missing, [required, other]))
      .toEqual(['textbook_fig_required']);

    const rendered: GeneratedSlideContent = { elements: [{
      id: 'image-1', type: 'image', left: 50, top: 120, width: 400, height: 300,
      src: required.src, fixedRatio: true, rotate: 0,
    }] };
    expect(missingRequiredTextbookImageIds(rendered, [required, other])).toEqual([]);
  });
});
