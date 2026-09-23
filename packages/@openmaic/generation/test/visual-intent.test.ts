import { describe, expect, test, vi } from 'vitest';
import {
  generateSceneContent,
  resolveImageIds,
  type AICallFn,
  type GeneratedSlideContent,
  type SceneOutline,
} from '@openmaic/generation';

function textElement() {
  return {
    id: 'title',
    type: 'text',
    left: 60,
    top: 60,
    width: 880,
    height: 76,
    content: '<p>顺应</p>',
    defaultFontName: '',
    defaultColor: '#222222',
  };
}

function outline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene_adaptation',
    type: 'slide',
    title: '顺应与错误理解',
    description: '通过具体例子解释顺应。',
    keyPoints: ['比较真实动物和儿童的错误理解'],
    order: 1,
    ...overrides,
  };
}

describe('slide visual intent', () => {
  test('keeps a definition-only page text-only without requesting media', async () => {
    let prompt = '';
    const aiCall: AICallFn = async (system, user) => {
      prompt = `${system}\n${user}`;
      return JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [textElement()],
      });
    };

    const result = await generateSceneContent(
      outline({
        visualIntent: {
          observationGoal: 'Read the concise definition of adaptation.',
          representation: 'text',
          rationale: 'The definition is clearest when read directly.',
        },
      }),
      aiCall,
    );

    expect(result).not.toBeNull();
    expect(prompt).toContain('"representation": "text"');
    expect(prompt).toContain('Required Resource Placements');
    expect(prompt).not.toContain('AI-Generated Images (use these IDs');
  });

  test('places and resolves a required stable textbook image ID', async () => {
    const resourceId = 'textbook_fig_adaptation-animals';
    const aiCall: AICallFn = async () =>
      JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          textElement(),
          {
            id: 'animals',
            type: 'image',
            left: 500,
            top: 150,
            width: 400,
            height: 240,
            src: resourceId,
            fixedRatio: true,
          },
        ],
      });

    const result = await generateSceneContent(
      outline({
        visualIntent: {
          observationGoal: 'Compare the fish, frog, and cow as real animals.',
          representation: 'source-image',
          resourceRefs: [
            {
              resourceId,
              kind: 'source-image',
              required: true,
              reason: 'The textbook picture is direct evidence for the example.',
            },
          ],
        },
      }),
      aiCall,
      {
        assignedImages: [
          {
            id: resourceId,
            src: '',
            pageNumber: 4,
            width: 1000,
            height: 600,
            textbookRelation: 'direct',
            required: true,
          },
        ],
        imageMapping: { [resourceId]: 'ast_textbook_adaptation_animals' },
      },
    );

    expect((result as GeneratedSlideContent | null)?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', src: 'ast_textbook_adaptation_animals' }),
      ]),
    );
  });

  test('fails before layout generation when a required source image is unavailable', async () => {
    const aiCall = vi.fn<AICallFn>();
    const failures: unknown[] = [];

    const result = await generateSceneContent(
      outline({
        visualIntent: {
          observationGoal: 'Inspect the textbook figure.',
          representation: 'source-image',
          resourceRefs: [
            {
              resourceId: 'textbook_fig_missing',
              kind: 'source-image',
              required: true,
              reason: 'The original textbook figure is required.',
            },
          ],
        },
      }),
      aiCall,
      { onFailure: (failure) => failures.push(failure) },
    );

    expect(result).toBeNull();
    expect(aiCall).not.toHaveBeenCalled();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  test('fails the first pass when the model omits a required bound resource', async () => {
    const aiCall: AICallFn = async () =>
      JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [textElement()],
      });
    const failures: unknown[] = [];

    const result = await generateSceneContent(
      outline({
        visualIntent: {
          observationGoal: 'Compare the concrete animals.',
          representation: 'generated-image',
          resourceRefs: [
            {
              resourceId: 'gen_img_animal-contrast',
              kind: 'generated-image',
              required: true,
              reason: 'The visible contrast carries the example.',
            },
          ],
        },
      }),
      aiCall,
      { onFailure: (failure) => failures.push(failure) },
    );

    expect(result).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  test('accepts a shared generated image reference without a second generation request', async () => {
    let userPrompt = '';
    const resourceId = 'gen_img_animal-contrast';
    const aiCall: AICallFn = async (_system, user) => {
      userPrompt = user;
      return JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          textElement(),
          {
            id: 'shared-animals',
            type: 'image',
            left: 500,
            top: 150,
            width: 400,
            height: 225,
            src: resourceId,
            fixedRatio: true,
          },
        ],
      });
    };

    const result = await generateSceneContent(
      outline({
        visualIntent: {
          observationGoal: 'Recall the same visible animal contrast.',
          representation: 'generated-image',
          resourceRefs: [
            {
              resourceId,
              kind: 'generated-image',
              required: true,
              reason: 'Reuse the previously generated evidence.',
            },
          ],
        },
      }),
      aiCall,
    );

    expect((result as GeneratedSlideContent | null)?.elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image', src: resourceId })]),
    );
    expect(userPrompt).toContain('Shared AI-Generated Images');
    expect(userPrompt).not.toContain('prompt":');
  });

  test('resolves any exact image mapping key, including non-legacy stable IDs', () => {
    const result = resolveImageIds(
      [
        {
          id: 'figure',
          type: 'image',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          src: 'curriculum_asset_alpha',
          fixedRatio: true,
        },
      ],
      { curriculum_asset_alpha: 'ast_alpha' },
    );

    expect(result[0]).toMatchObject({ type: 'image', src: 'ast_alpha' });
  });
});
