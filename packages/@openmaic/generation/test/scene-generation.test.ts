import { describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { AICallFn } from '@openmaic/generation';
import {
  PBLGenerationError,
  extractWidgetConfig,
  generateSceneActions,
  generateSceneContent,
} from '@openmaic/generation';
import {
  pblOutline,
  quizOutline,
  slideOutline,
  validPBLResponse,
  widgetOutline,
} from './scene-fixtures.js';

describe('scene generation primitives', () => {
  it('generates slide content through the injected AI call', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        elements: [
          {
            type: 'text',
            left: 80,
            top: 60,
            width: 840,
            height: 100,
            content: 'Dependency injection',
          },
        ],
        background: { type: 'solid', color: '#ffffff' },
      }),
    );

    const content = await generateSceneContent(slideOutline(), aiCall);
    expect(content).toMatchObject({
      elements: [expect.objectContaining({ type: 'text', content: 'Dependency injection' })],
      background: { type: 'solid', color: '#ffffff' },
    });
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('generates quiz content through the json-output-rules prompt path', async () => {
    let system = '';
    const aiCall: AICallFn = async (systemPrompt) => {
      system = systemPrompt;
      return JSON.stringify([
        {
          type: 'single',
          question: 'Who owns model routing?',
          options: ['The caller', 'The package'],
          correctAnswer: 'A',
        },
      ]);
    };

    const content = await generateSceneContent(quizOutline(), aiCall);
    expect(system).toContain('Output Format Requirements (Must Follow Strictly)');
    expect(content).toMatchObject({
      questions: [
        expect.objectContaining({
          type: 'single',
          options: [
            { value: 'A', label: 'The caller' },
            { value: 'B', label: 'The package' },
          ],
          answer: ['A'],
        }),
      ],
    });
  });

  it('runs one widget kind end-to-end through config extraction and actions', async () => {
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      if (calls === 1) {
        return '<!DOCTYPE html><html><head></head><body><input id="energy" type="range"><script type="application/json" id="widget-config">{"variables":["energy"]}</script></body></html>';
      }
      return JSON.stringify([
        { type: 'action', name: 'widget_highlight', params: { target: '#energy' } },
        { type: 'action', name: 'widget_setState', params: { state: { energy: 75 } } },
      ]);
    };

    const outline = widgetOutline();
    const content = await generateSceneContent(outline, aiCall);
    expect(content).toMatchObject({
      widgetType: 'simulation',
      widgetConfig: { type: 'simulation', variables: ['energy'] },
    });
    if (!content || !('html' in content)) throw new Error('expected interactive content');
    expect(extractWidgetConfig(content.html, 'simulation')).toEqual({
      type: 'simulation',
      variables: ['energy'],
    });
    const actions = await generateSceneActions(outline, content, aiCall);
    expect(actions.map((action) => action.type)).toEqual(['widget_highlight', 'widget_setState']);
  });

  it('publishes precise table cells to the original action call and never fabricates a fallback target', async () => {
    let userPrompt = '';
    const table = {
      id: 'stage-table', type: 'table', left: 40, top: 80, width: 800, height: 300,
      outline: {}, colWidths: [0.4, 0.6], cellMinHeight: 40,
      data: [[
        { id: 'r1c1', colspan: 1, rowspan: 1, text: '学段' },
        {
          id: 'r1c2', colspan: 1, rowspan: 1,
          text: '图形化编程、机器人体验等低代码工具，以及完整的不截断说明',
        },
      ]],
    } as PPTElement;
    const aiCall: AICallFn = async (_system, user) => {
      userPrompt = user;
      return JSON.stringify([
        { type: 'action', name: 'spotlight', params: { elementId: 'missing-element' } },
        { type: 'text', content: '小学采用低代码工具。' },
      ]);
    };

    const actions = await generateSceneActions(slideOutline(), { elements: [table] }, aiCall);

    expect(userPrompt).toContain('"cellId":"r1c2"');
    expect(userPrompt).toContain('图形化编程、机器人体验等低代码工具，以及完整的不截断说明');
    expect(actions[0]).toMatchObject({ type: 'spotlight', elementId: 'missing-element' });
    expect(actions[0]).not.toHaveProperty('elementId', 'stage-table');
  });

  it('uses narration without a guessed visual action when action generation falls back', async () => {
    const actions = await generateSceneActions(
      slideOutline(),
      {
        elements: [{
          id: 'visible-text', type: 'text', left: 0, top: 0, width: 100, height: 30,
          content: 'Visible', defaultFontName: 'Arial', defaultColor: '#000000',
        } as PPTElement],
      },
      async () => 'not-json',
    );

    expect(actions.map((action) => action.type)).toEqual(['speech']);
  });

  it('can require parseable action output while keeping compatibility fallback by default', async () => {
    const outline = slideOutline();
    const content = {
      elements: [{
        id: 'visible-text', type: 'text', left: 0, top: 0, width: 100, height: 30,
        content: 'Visible', defaultFontName: 'Arial', defaultColor: '#000000',
      } as PPTElement],
    };

    await expect(generateSceneActions(outline, content, async () => 'not-json', {
      requireStructuredOutput: true,
    })).rejects.toMatchObject({
      code: 'INVALID_ACTION_OUTPUT',
      message: expect.stringContaining('Invalid or empty teaching actions'),
    });
    await expect(generateSceneActions(outline, content, async () => 'not-json'))
      .resolves.toEqual([expect.objectContaining({ type: 'speech' })]);
  });

  it('generates PBL content with the re-seated single-call planner', async () => {
    const content = await generateSceneContent(pblOutline(), async () => validPBLResponse(), {
      targetLanguage: 'en-US',
      languageDirective: 'Reply in English.',
    });
    expect(content).toMatchObject({
      projectV2: {
        title: 'CSV Data Analyzer project',
        status: 'active',
        uiPhase: 'hero',
      },
    });
  });

  it('fails loudly when PBL single-call planning fails and no fallback exists', async () => {
    await expect(
      generateSceneContent(pblOutline(), async () => {
        throw new Error('model unavailable');
      }),
    ).rejects.toBeInstanceOf(PBLGenerationError);
  });

  it('invokes the injected PBL loop fallback after a single-call failure', async () => {
    const fallback = vi.fn(async () => ({
      uiPhase: 'hero' as const,
      title: 'Recovered project',
      description: 'Recovered by the host loop planner.',
      tags: [],
      language: 'en-US',
      proficiency: 'beginner' as const,
      status: 'active' as const,
      roles: [],
      milestones: [],
      submissions: [],
      evaluations: [],
      threads: [],
      engagementEvents: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));

    const content = await generateSceneContent(pblOutline(), async () => '{}', {
      pblLoopFallback: fallback,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(content).toMatchObject({ projectV2: { title: 'Recovered project' } });
  });

  it('skips the PBL loop fallback after a single-call abort', async () => {
    const fallback = vi.fn();

    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw new DOMException('The operation was aborted.', 'AbortError');
        },
        { pblLoopFallback: fallback },
      ),
    ).rejects.toMatchObject({
      name: 'PBLGenerationError',
      message: expect.stringContaining('after all planner attempts'),
      cause: expect.objectContaining({ name: 'AbortError' }),
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('skips the PBL loop fallback after an error-shaped single-call abort', async () => {
    const fallback = vi.fn();

    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        },
        { pblLoopFallback: fallback },
      ),
    ).rejects.toMatchObject({
      name: 'PBLGenerationError',
      message: expect.stringContaining('after all planner attempts'),
      cause: expect.objectContaining({ name: 'AbortError', message: 'Aborted' }),
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('skips the PBL loop fallback after a status-bearing provider failure', async () => {
    const fallback = vi.fn();

    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw Object.assign(new Error('rate limited'), { status: 429 });
        },
        { pblLoopFallback: fallback },
      ),
    ).rejects.toMatchObject({
      name: 'PBLGenerationError',
      message: expect.stringContaining('after all planner attempts'),
      statusCode: 429,
      cause: expect.objectContaining({ message: 'rate limited', status: 429 }),
    });
    expect(fallback).not.toHaveBeenCalled();
  });
});
