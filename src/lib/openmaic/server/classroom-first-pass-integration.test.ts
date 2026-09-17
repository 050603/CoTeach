import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '../types/generation';
import type { Scene } from '../types/stage';
import type { SlideSpatialBudget } from '../generation/slide-spatial-types';

const mocks = vi.hoisted(() => ({
  ai: vi.fn(),
  resolve: vi.fn(),
  prepare: vi.fn(),
  sketch: vi.fn(),
  persist: vi.fn(),
  review: vi.fn(),
  layout: vi.fn(),
  density: vi.fn(),
  coverage: vi.fn(),
  createAiCall: vi.fn(),
}));
vi.mock('./resolve-model', () => ({ resolveModel: mocks.resolve }));
vi.mock('./course-generation-ai-call', () => ({
  createCourseGenerationAiCall: (options: unknown) => mocks.createAiCall(options),
  withCourseGenerationAiCallContext: (aiCall: unknown) => aiCall,
}));
vi.mock('./classroom-media-readiness', () => ({ assertRequestedClassroomMediaProviders: () => {} }));
vi.mock('./classroom-media-generation', () => ({ resolveServerTtsTimingSelection: () => ({ providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Serena', language: 'zh-CN', speed: 1 }) }));
vi.mock('./classroom-storage', () => ({ persistClassroom: mocks.persist }));
vi.mock('./provider-config', async (original) => ({ ...await original<typeof import('./provider-config')>(), getClassroomSceneConcurrency: () => 1 }));
vi.mock('../generation/slide-spatial-plan', () => ({ prepareCourseSlideSpatialPlans: mocks.prepare, getSlideSpatialSketch: mocks.sketch }));
vi.mock('../generation/slide-layout-audit', () => ({
  auditAndRepairSlideOnce: mocks.review,
  auditSlideLayout: mocks.layout,
  auditSlideDensity: mocks.density,
  slideKnowledgeCoverage: mocks.coverage,
}));

import { generateClassroom } from './classroom-generation';
import { fingerprintSceneOutline, restoreSceneCheckpoint, type PageCheckpointSnapshot } from '@/lib/course-generation/page-checkpoints';

const spatialBudget: SlideSpatialBudget = {
  schemaVersion: 1, canvas: { width: 1000, height: 562.5 }, safeBody: { x: 60, y: 145, width: 880, height: 335 },
  title: { text: '保存的空间方案', bounds: { x: 60, y: 8, width: 880, height: 128 }, fontSize: 32, lineHeight: 1.5, measuredHeight: 68, maxLines: 2 },
  reserveRatio: 0.1, regions: [], occupied: [], remaining: [], conflicts: [], connectors: [], measurement: 'browser-renderer-fonts-v1',
};
const outline: SceneOutline = {
  id: 'saved-page--spatial-1', type: 'slide', title: '保存的空间方案', description: '解释两个概念', keyPoints: ['证据'], order: 0,
  targetDurationSec: 31, estimatedDuration: 31, spatialParentId: 'saved-page', spatialBudget,
};
const content = { elements: [
  { id: 'a', type: 'text', left: 60, top: 160, width: 400, height: 100, content: '<p style="font-size:24px">首遍证据</p>' },
  { id: 'b', type: 'text', left: 60, top: 170, width: 400, height: 100, content: '<p style="font-size:24px">有意保留首遍坐标</p>' },
] };
const narration = [{ type: 'text', content: '短讲稿。' }, { type: 'action', name: 'wb_draw_latex', params: { latex: '\\frac{x}{', x: 20, y: 20, width: 100, height: 50 } }];
const input = { requirement: '从保存的大纲继续生成', agentMode: 'default' as const, enableImageGeneration: false, enableVideoGeneration: false, enableTTS: false };

describe('classroom first-pass orchestration and checkpoint integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ai.mockReset();
    mocks.createAiCall.mockReset().mockImplementation(() => mocks.ai);
    mocks.resolve.mockResolvedValue({ model: {}, modelInfo: { capabilities: { vision: true }, outputWindow: 12000 }, modelString: 'test-model', providerId: 'openai', apiKey: 'test' });
    mocks.prepare.mockRejectedValue(new Error('Saved outlines must never be prepared again'));
    mocks.sketch.mockResolvedValue('data:image/png;base64,c3BhdGlhbA==');
    mocks.review.mockImplementation(async ({ content }: { content: unknown }) => ({
      content,
      initialAudit: { status: 'checked', issues: [] },
      finalAudit: { status: 'checked', issues: [] },
      repairAttempted: false,
      adopted: 'first-draft',
      initialKnowledgeCoverage: 1,
      finalKnowledgeCoverage: 1,
      initialDensityIssues: [],
      finalDensityIssues: [],
      initialVisibleTextCharacters: 200,
      finalVisibleTextCharacters: 200,
      initialVerticalSpan: 380,
      finalVerticalSpan: 380,
      initialContentAreaUtilization: 0.95,
      finalContentAreaUtilization: 0.95,
      initialMaxBlankBand: 20,
      finalMaxBlankBand: 20,
      initialHasDeepBlueTitle: true,
      finalHasDeepBlueTitle: true,
      initialHasSubtitle: true,
      finalHasSubtitle: true,
      semanticStructureRequired: false,
      initialSemanticStructures: [],
      finalSemanticStructures: [],
      initialPaletteDeviationCount: 0,
      finalPaletteDeviationCount: 0,
    }));
    mocks.layout.mockResolvedValue({ status: 'checked', issues: [] });
    mocks.density.mockReturnValue({
      issues: [],
      visibleTextCharacters: 20,
      verticalSpan: 200,
      underrepresentedKeyPoints: [],
      contentAreaUtilization: 0.95,
      maxBlankBand: 20,
      hasDeepBlueTitle: true,
      hasSubtitle: true,
      semanticStructureRequired: false,
      semanticStructures: [],
      semanticStructureSatisfied: true,
      paletteDeviationCount: 0,
      elementCount: 2,
      semanticElementCount: 0,
    });
    mocks.coverage.mockReturnValue(1);
    mocks.persist.mockImplementation(async (value: { id: string }) => ({ id: value.id, createdAt: '2026-09-14T00:00:00Z' }));
  });

  it('restores a completed checkpoint without content or action calls after its page audit passes', async () => {
    const saved = { ...outline, teachingToolPlan: [{ tool: 'whiteboard' as const, trigger: '讲解时', purpose: '显示推导', content: ['推导'], required: true }] };
    let returnedCheckpoint: Scene | undefined;
    const onOutlinesPrepared = vi.fn();
    const onSceneCompleted = vi.fn();
    const loadSceneCheckpoint = vi.fn((_outline: SceneOutline, _index: number, stageId: string) => {
      returnedCheckpoint = { id: 'completed-page', stageId, type: 'slide', title: outline.title, order: 0, content: { type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625, elements: content.elements } }, actions: [], createdAt: 1, updatedAt: 1 } as unknown as Scene;
      return returnedCheckpoint;
    });
    const result = await generateClassroom(input, { preparedOutlines: [saved], loadSceneCheckpoint, onOutlinesPrepared, onSceneCompleted });
    expect(result.scenes[0]).toEqual(returnedCheckpoint);
    expect(result.assetContext.outlines[0]).toMatchObject({ id: outline.id, spatialParentId: 'saved-page', spatialBudget, targetDurationSec: 31 });
    expect(onOutlinesPrepared.mock.calls[0][0][0].spatialBudget).toEqual(spatialBudget);
    expect(loadSceneCheckpoint).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.sketch).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(onSceneCompleted).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it('regenerates an unmarked knowledge-page checkpoint so resumed courses cannot mix narration policies', async () => {
    const enhancedOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      audience: 'student',
      teachingBrief: {
        schemaVersion: 1,
        explanation: '证据支持结论，语言流畅不能证明事实正确。',
        examples: ['核对一个具体年份。'],
        conditions: ['同源转载不是独立来源。'],
        evidence: [],
        assessmentFocus: '说明核验步骤和理由。',
      },
    };
    const legacyCheckpoint = {
      id: 'legacy-first-draft',
      stageId: 'old-stage',
      outlineId: enhancedOutline.id,
      type: 'slide',
      title: enhancedOutline.title,
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'legacy-canvas', viewportSize: 1000, viewportRatio: 0.5625,
          elements: content.elements,
        },
      },
      actions: [{ id: 'legacy-speech', type: 'speech', text: '首遍讲稿。' }],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Scene;
    mocks.ai.mockImplementation(async (system: string, user: string) => {
      if (system.includes('# Slide Content Generator')) return JSON.stringify(content);
      if (system.includes('Slide Action Generator')) return JSON.stringify(narration);
      if (system.includes('中文课堂讲稿编辑')) {
        const ids = [...user.matchAll(/^\[([^\]]+)]/gm)].map((match) => match[1]);
        return JSON.stringify({ segments: ids.map((id) => ({
          id,
          text: '判断信息是否可靠，要回到独立来源核对事实和依据。',
        })) });
      }
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });

    const result = await generateClassroom(input, {
      preparedOutlines: [enhancedOutline],
      loadSceneCheckpoint: () => legacyCheckpoint,
    });

    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls.some(([system]) => system.includes('中文课堂讲稿编辑'))).toBe(false);
    expect(result.scenes[0]?.id).not.toBe('legacy-first-draft');
    expect(result.scenes[0]?.narrationRevision).toBe('natural-teacher-speech-v2');
  });

  it('regenerates a sparse resumed slide instead of bypassing the page audit', async () => {
    const themedOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      courseVisualDirection: 'stale warm palette',
    };
    mocks.density
      .mockReturnValueOnce({
        issues: ['可见教学文字过少'],
        visibleTextCharacters: 5,
        verticalSpan: 80,
        underrepresentedKeyPoints: [{ keyPoint: '证据', coverage: 0 }],
        contentAreaUtilization: 0.2,
        maxBlankBand: 300,
        hasDeepBlueTitle: false,
        hasSubtitle: false,
        semanticStructureRequired: false,
        semanticStructures: [],
        paletteDeviationCount: 0,
      });
    mocks.layout.mockResolvedValueOnce({
      status: 'checked',
      issues: ['slide contains no elements'],
    });
    mocks.ai.mockImplementation(async (system: string, user: string) => {
      if (system.includes('课程小节的教学设计师')) {
        return JSON.stringify({ pages: [{
          outlineId: themedOutline.id,
          explanation: '解释两个概念之间的证据关系。',
          examples: ['用一个具体判断任务逐步说明。'],
          conditions: ['结论只能落在已有证据范围内。'],
          assessmentFocus: '说明判断和理由。',
          evidenceQuotes: [],
        }] });
      }
      if (system.includes('# Slide Content Generator')) return JSON.stringify(content);
      if (system.includes('Slide Action Generator')) return JSON.stringify(narration);
      if (system.includes('中文课堂讲稿编辑')) {
        const ids = [...user.matchAll(/^\[([^\]]+)]/gm)].map((match) => match[1]);
        return JSON.stringify({ segments: ids.map((id) => ({
          id,
          text: '先比较两个概念使用的证据，再判断结论能够成立到什么范围。',
        })) });
      }
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });
    const checkpoint = {
      id: 'sparse-checkpoint',
      stageId: 'old-stage',
      outlineId: themedOutline.id,
      type: 'slide',
      title: themedOutline.title,
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'sparse-canvas',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            backgroundColor: '#FFF5E6',
            themeColors: ['#8E44AD'],
            fontColor: '#333333',
            fontName: 'Other',
          },
          background: { type: 'solid', color: '#FFF5E6' },
          elements: [],
        },
      },
      actions: [],
      narrationRevision: 'natural-teacher-speech-v2',
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Scene;

    const result = await generateClassroom(input, {
      preparedOutlines: [themedOutline],
      loadSceneCheckpoint: () => checkpoint,
    });

    expect(mocks.ai).toHaveBeenCalledTimes(3);
    expect(mocks.ai.mock.calls.some(([system]) => system.includes('中文课堂讲稿编辑'))).toBe(false);
    expect(result.scenes[0]?.id).not.toBe('sparse-checkpoint');
    expect(result.scenes[0]?.content.type).toBe('slide');
    if (result.scenes[0]?.content.type !== 'slide') throw new Error('Expected slide');
    expect(result.scenes[0].content.canvas.background).toBeUndefined();
    expect(result.qualityReport.visualConsistency).toMatchObject({
      expectedBackground: 'white-or-light-gray-blue',
      passed: true,
    });
    expect(result.qualityReport.disposition).toBe('ready');
  });

  it('reuses a completed checkpoint when only density heuristics remain', async () => {
    mocks.density.mockReturnValueOnce({
      issues: ['关键教学点可见覆盖率仅 80.0%，存在 1 条未完整可见的已确认要点'],
      visibleTextCharacters: 170,
      verticalSpan: 360,
      underrepresentedKeyPoints: [{ keyPoint: '证据', coverage: 0.2 }],
      contentAreaUtilization: 0.91,
      maxBlankBand: 20,
      hasDeepBlueTitle: true,
      hasSubtitle: true,
      semanticStructureRequired: false,
      semanticStructures: ['grouped-shapes'],
      semanticStructureSatisfied: true,
      paletteDeviationCount: 0,
      elementCount: 8,
      semanticElementCount: 2,
    });
    const checkpoint = {
      id: 'density-warning-checkpoint',
      stageId: 'old-stage',
      outlineId: outline.id,
      type: 'slide',
      title: outline.title,
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'saved-canvas',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: content.elements,
        },
      },
      actions: [],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Scene;

    const result = await generateClassroom(input, {
      preparedOutlines: [outline],
      loadSceneCheckpoint: (_saved, _index, stageId) => ({ ...checkpoint, stageId }),
    });

    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(result.scenes[0]?.id).toBe('density-warning-checkpoint');
    expect(result.qualityReport.layoutAudit?.pages[0]?.finalDensityIssues).toHaveLength(1);
    expect(result.qualityReport.disposition).toBe('needs-review');
  });

  it('ignores the saved legacy spatial plan and uses the official prompt once', async () => {
    mocks.ai.mockResolvedValueOnce(JSON.stringify(content)).mockResolvedValueOnce(JSON.stringify(narration));
    const onSceneCompleted = vi.fn();
    const result = await generateClassroom(input, { preparedOutlines: [outline], loadSceneCheckpoint: () => null, onSceneCompleted });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.sketch).not.toHaveBeenCalled();
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls[0][0]).toContain('# Slide Content Generator');
    expect(mocks.ai.mock.calls[0][1]).not.toContain('browser-renderer-fonts-v1');
    expect(mocks.ai.mock.calls[0][1]).not.toContain('Course-wide visual theme contract');
    expect(mocks.ai.mock.calls[0][2]).toBeUndefined();
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(result.scenes[0].content.type).toBe('slide');
    if (result.scenes[0].content.type !== 'slide') throw new Error('Expected a slide');
    expect(result.scenes[0].content.canvas.elements.map((e) => [e.left, e.top, 'height' in e ? e.height : undefined])).toEqual([[60, 160, 100], [60, 170, 100]]);
    expect(result.scenes[0].actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'speech', text: expect.stringContaining('短讲稿。') })]));
    expect(onSceneCompleted).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it('resumes after narration failure without regenerating completed content, review, or actions', async () => {
    const resumableOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      teachingBrief: {
        schemaVersion: 1,
        explanation: '语言流畅不能单独证明事实正确，需要核对独立来源。',
        examples: ['标出事实主张，再逐项核对原始资料。'],
        conditions: ['同源转载不能当作多个独立来源。'],
        evidence: [],
        assessmentFocus: '说明核验步骤和理由。',
      },
      timingPlan: {
        unit: 'cjk-char', targetUnits: 120, minUnits: 100, maxUnits: 140,
      } as NonNullable<SceneOutline['timingPlan']>,
    };
    const stages = new Map<string, unknown>();
    let narrationAvailable = false;
    mocks.ai.mockImplementation(async (system: string, user: string) => {
      if (system.includes('# Slide Content Generator')) return JSON.stringify(content);
      if (system.includes('Slide Action Generator')) return JSON.stringify(narration);
      if (system.includes('中文课堂讲稿编辑')) {
        if (!narrationAvailable) {
          throw Object.assign(new Error('Receive batching backend response failed'), {
            code: 'InternalError',
          });
        }
        const [id] = [...user.matchAll(/^\[([^\]]+)]/gm)].map((match) => match[1]);
        return JSON.stringify({ segments: [{
          id,
          text: '判断信息是否可靠，要回到独立来源核对事实、证据和适用条件。',
        }] });
      }
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });
    const callbacks = {
      preparedOutlines: [resumableOutline],
      loadSceneCheckpoint: () => null,
      loadSceneStageCheckpoint: (_saved: SceneOutline, stage: string) => stages.get(stage) ?? null,
      onSceneStageCompleted: async (
        _saved: SceneOutline,
        stage: string,
        payload: unknown,
      ) => { stages.set(stage, payload); },
    };

    await expect(generateClassroom(input, callbacks)).rejects.toThrow(/batching backend/);
    expect([...stages.keys()]).toEqual(['content', 'reviewed-content', 'actions']);
    expect(mocks.ai).toHaveBeenCalledTimes(3);
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(mocks.persist).not.toHaveBeenCalled();

    narrationAvailable = true;
    const result = await generateClassroom(input, callbacks);

    expect(mocks.ai).toHaveBeenCalledTimes(4);
    expect(mocks.ai.mock.calls.filter(([system]) => system.includes('# Slide Content Generator'))).toHaveLength(1);
    expect(mocks.ai.mock.calls.filter(([system]) => system.includes('Slide Action Generator'))).toHaveLength(1);
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(stages.has('narration')).toBe(true);
    expect(result.scenes[0]?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'speech',
        text: expect.stringContaining('独立来源'),
      }),
    ]));
  });

  it('adds one shared teaching-design call without restoring the obsolete media planner', async () => {
    mocks.ai
      .mockResolvedValueOnce(JSON.stringify({ pages: [{
        outlineId: outline.id,
        explanation: '解释两个概念之间的证据关系。',
        examples: ['用一个具体判断任务逐步说明。'],
        conditions: ['结论只能落在已有证据范围内。'],
        assessmentFocus: '说明判断和理由。',
        evidenceQuotes: [],
      }] }))
      .mockResolvedValueOnce(JSON.stringify(content))
      .mockResolvedValueOnce(JSON.stringify(narration));

    const onProgress = vi.fn();
    await generateClassroom({ ...input, enableImageGeneration: true, sceneOutlines: [outline] }, {
      loadSceneCheckpoint: () => null,
      onProgress,
    });

    expect(mocks.ai).toHaveBeenCalledTimes(3);
    expect(mocks.ai.mock.calls[0]?.[0]).toContain('课程小节的教学设计师');
    expect(mocks.ai.mock.calls[1]?.[0]).toContain('# Slide Content Generator');
    expect(mocks.ai.mock.calls[2]?.[0]).toContain('Slide Action Generator');
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      step: 'generating_outlines',
      message: '正在生成分小节教学设计（1/1）',
    }));
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('carries one shared teaching design through slide, narration, and persisted outlines', async () => {
    const enhancedOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      audience: 'student',
      parentActivityId: 'section-1',
      narrationMode: 'embedded-segment',
    };
    mocks.ai.mockImplementation(async (system: string, user: string) => {
      if (system.includes('课程小节的教学设计师')) {
        return JSON.stringify({ pages: [{
          outlineId: enhancedOutline.id,
          explanation: '证据支持结论，表达流畅本身不能证明事实正确。',
          examples: ['先标出年份主张，再查找独立原始资料并记录差异。'],
          conditions: ['同源转载不能当作多个独立来源。'],
          assessmentFocus: '说明核验步骤以及每一步的理由。',
          evidenceQuotes: [],
        }] });
      }
      if (system.includes('# Slide Content Generator')) return JSON.stringify(content);
      if (system.includes('Slide Action Generator')) return JSON.stringify(narration);
      if (system.includes('中文课堂讲稿编辑')) {
        const ids = [...user.matchAll(/^\[([^\]]+)]/gm)].map((match) => match[1]);
        return JSON.stringify({ segments: ids.map((id) => ({
          id,
          text: '大家先看这个具体回答。它的句子很通顺，细节也像是真的，但这些只能说明表达自然，不能证明事实成立。判断内容是否可靠，还要标出姓名、年份和数据，再回到独立的原始资料逐项核对。这样才能把语言表达和证据可靠性分开，也能说明每一步核验为什么必要。最后还要记录来源，让其他同学可以重复检查。',
        })) });
      }
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });

    const result = await generateClassroom({
      ...input,
      sceneOutlines: [enhancedOutline],
      courseTitle: '人工智能信息核验',
      languageDirective: '使用简体中文授课',
    }, { loadSceneCheckpoint: () => null });

    expect(mocks.ai).toHaveBeenCalledTimes(4);
    expect(mocks.ai.mock.calls[1]?.[0]).toContain('CoTeach teaching enhancement adapter');
    expect(mocks.ai.mock.calls[1]?.[1]).toContain('同源转载不能当作多个独立来源');
    expect(mocks.ai.mock.calls[2]?.[1]).toContain('说明核验步骤以及每一步的理由');
    expect(result.assetContext.outlines[0]?.teachingBrief?.examples).toEqual([
      '先标出年份主张，再查找独立原始资料并记录差异。',
    ]);
    expect(result.scenes[0]?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'speech', text: expect.stringContaining('表达自然') }),
    ]));
    expect(result.scenes[0]?.narrationRevision).toBe('natural-teacher-speech-v2');
    expect(result.qualityReport.teachingEnhancementVersion).toBe('section-teaching-brief-v2');
    expect(result.qualityReport.narrationEnhancementVersion).toBe('natural-teacher-speech-v2');
  });

  it('does not publish a first-draft page when natural narration fails validation twice', async () => {
    const enhancedOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      audience: 'student',
      parentActivityId: 'section-1',
      narrationMode: 'embedded-segment',
    };
    mocks.ai.mockImplementation(async (system: string, user: string) => {
      if (system.includes('课程小节的教学设计师')) {
        return JSON.stringify({ pages: [{
          outlineId: enhancedOutline.id,
          explanation: '证据支持结论，表达流畅不能证明事实正确。',
          examples: ['先标出事实主张，再查找独立资料。'],
          conditions: ['同源转载不能当作多个独立来源。'],
          assessmentFocus: '说明核验步骤和理由。',
          evidenceQuotes: [],
        }] });
      }
      if (system.includes('# Slide Content Generator')) return JSON.stringify(content);
      if (system.includes('Slide Action Generator')) return JSON.stringify(narration);
      if (system.includes('中文课堂讲稿编辑')) {
        const ids = [...user.matchAll(/^\[([^\]]+)]/gm)].map((match) => match[1]);
        return JSON.stringify({ segments: ids.map((id) => ({
          id,
          text: '这一页的核心观点是核验信息。',
        })) });
      }
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });

    await expect(generateClassroom({
      ...input,
      sceneOutlines: [enhancedOutline],
      languageDirective: '使用简体中文授课',
    }, { loadSceneCheckpoint: () => null })).rejects.toThrow(/已停止课程生成/);

    expect(mocks.ai).toHaveBeenCalledTimes(5);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('resolves the teacher-selected model once and reuses it for every authoring call', async () => {
    mocks.resolve.mockResolvedValue({
      model: {},
      modelInfo: { capabilities: { vision: true }, outputWindow: 393_216 },
      modelString: 'deepseek:teacher-selected',
      providerId: 'deepseek',
      apiKey: 'test',
    });
    mocks.ai.mockResolvedValueOnce(JSON.stringify(content)).mockResolvedValueOnce(JSON.stringify(narration));
    await generateClassroom({ ...input, generationModelString: 'deepseek:teacher-selected' }, {
      preparedOutlines: [outline],
      loadSceneCheckpoint: () => null,
    });
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledWith({ modelString: 'deepseek:teacher-selected' });
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    const interactiveCall = mocks.createAiCall.mock.calls.find(([options]) => (
      (options as { source?: string }).source === 'generate-classroom-interactive'
    ));
    expect(interactiveCall?.[0]).toEqual(expect.objectContaining({
      source: 'generate-classroom-interactive',
      timeoutMs: 600_000,
      maxRetries: 2,
      streamResponse: true,
    }));
    for (const source of [
      'generate-classroom',
      'classroom-section-teaching-design',
      'classroom-natural-narration',
    ]) {
      const structuredCall = mocks.createAiCall.mock.calls.find(([options]) => (
        (options as { source?: string }).source === source
      ));
      expect(structuredCall?.[0]).toEqual(expect.objectContaining({
        source,
        timeoutMs: 600_000,
        maxOutputTokens: 393_216,
        maxRetries: 2,
      }));
      expect((structuredCall?.[0] as { streamResponse?: boolean }).streamResponse).toBe(true);
    }
    const selectedModel = mocks.createAiCall.mock.calls[0]?.[0]?.model;
    expect(mocks.createAiCall.mock.calls.slice(0, 4).every(([options]) => options.model === selectedModel))
      .toBe(true);
  });

  it('uses the same teacher-selected model for the one evidence-triggered page edit', async () => {
    mocks.review.mockImplementationOnce(async ({ content: firstDraft, regenerate }: {
      content: typeof content;
      regenerate: (directive: string, baseline: typeof content) => Promise<typeof content>;
    }) => {
      const repaired = await regenerate('Measured text density is below the reference floor.', firstDraft);
      return {
        content: repaired,
        initialAudit: { status: 'checked', issues: [] },
        finalAudit: { status: 'checked', issues: [] },
        repairAttempted: true,
        adopted: 'repair',
        initialKnowledgeCoverage: 1,
        finalKnowledgeCoverage: 1,
        initialDensityIssues: ['普通讲授页可见教学文字低于基线'],
        finalDensityIssues: [],
        initialVisibleTextCharacters: 90,
        finalVisibleTextCharacters: 180,
        initialVerticalSpan: 200,
        finalVerticalSpan: 360,
        initialContentAreaUtilization: 0.5,
        finalContentAreaUtilization: 0.95,
        initialMaxBlankBand: 180,
        finalMaxBlankBand: 20,
        initialHasDeepBlueTitle: true,
        finalHasDeepBlueTitle: true,
        initialHasSubtitle: true,
        finalHasSubtitle: true,
        semanticStructureRequired: false,
        initialSemanticStructures: [],
        finalSemanticStructures: [],
        initialSemanticStructureSatisfied: true,
        finalSemanticStructureSatisfied: true,
        initialPaletteDeviationCount: 0,
        finalPaletteDeviationCount: 0,
        initialElementCount: 5,
        finalElementCount: 8,
        initialSemanticElementCount: 0,
        finalSemanticElementCount: 0,
        initialQualityScore: 55,
        finalQualityScore: 80,
      };
    });
    mocks.ai
      .mockResolvedValueOnce(JSON.stringify(content))
      .mockResolvedValueOnce(JSON.stringify(content))
      .mockResolvedValueOnce(JSON.stringify(narration));

    await generateClassroom({ ...input, generationModelString: 'deepseek:teacher-selected' }, {
      preparedOutlines: [outline],
      loadSceneCheckpoint: () => null,
    });

    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.ai).toHaveBeenCalledTimes(3);
    expect(mocks.ai.mock.calls[1]?.[1]).toContain('## EDIT MODE');
    expect(mocks.ai.mock.calls[1]?.[1]).toContain('Measured text density is below the reference floor.');
  });

  it('keeps the first draft when the optional single page edit fails', async () => {
    mocks.review.mockImplementationOnce(async ({ content: firstDraft, regenerate }: {
      content: typeof content;
      regenerate: (directive: string, baseline: typeof content) => Promise<typeof content | null>;
    }) => {
      const candidate = await regenerate('Measured density issue.', firstDraft);
      expect(candidate).toBeNull();
      return {
        content: firstDraft,
        initialAudit: { status: 'checked', issues: [] },
        finalAudit: { status: 'checked', issues: [] },
        repairAttempted: true,
        adopted: 'first-draft',
        initialKnowledgeCoverage: 1,
        finalKnowledgeCoverage: 1,
        initialDensityIssues: ['普通讲授页可见教学文字低于基线'],
        finalDensityIssues: ['普通讲授页可见教学文字低于基线'],
      };
    });
    mocks.ai
      .mockResolvedValueOnce(JSON.stringify(content))
      .mockRejectedValueOnce(new Error('optional editor timeout'))
      .mockResolvedValueOnce(JSON.stringify(narration));

    const result = await generateClassroom(input, {
      preparedOutlines: [outline],
      loadSceneCheckpoint: () => null,
    });

    expect(mocks.ai).toHaveBeenCalledTimes(3);
    expect(result.scenes[0]?.content.type).toBe('slide');
    expect(result.qualityReport.layoutAudit?.pages[0]).toMatchObject({
      repairAttempted: true,
      adopted: 'first-draft',
    });
  });

  it('keeps the official first draft and records audit-unavailable without a hidden repair', async () => {
    mocks.review.mockImplementationOnce(async ({ content: firstDraft }: { content: typeof content }) => ({
      content: firstDraft,
      initialAudit: { status: 'unavailable', issues: [], reason: 'chromium missing' },
      finalAudit: { status: 'unavailable', issues: [], reason: 'chromium missing' },
      repairAttempted: false,
      adopted: 'first-draft',
      initialKnowledgeCoverage: 1,
      finalKnowledgeCoverage: 1,
      initialDensityIssues: [],
      finalDensityIssues: [],
    }));
    mocks.ai.mockResolvedValueOnce(JSON.stringify(content)).mockResolvedValueOnce(JSON.stringify(narration));

    const result = await generateClassroom(input, { preparedOutlines: [outline] });

    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(result.qualityReport).toMatchObject({
      generationMethod: 'classic-one-click',
      generationModelString: 'test-model',
      disposition: 'audit-unavailable',
      layoutAudit: { status: 'unavailable' },
    });
  });

  it('repairs an English narration draft once before a Chinese course can reach TTS', async () => {
    mocks.ai
      .mockResolvedValueOnce(JSON.stringify(content))
      .mockResolvedValueOnce(JSON.stringify([{
        type: 'text',
        content: 'Today we will explain how evidence changes the conclusion of this example.',
      }]))
      .mockResolvedValueOnce(JSON.stringify([{
        type: 'text',
        content: '这一页先明确证据与结论的关系，再用具体例子检验这个判断。',
      }]));

    const result = await generateClassroom(input, {
      preparedOutlines: [outline],
      loadSceneCheckpoint: () => null,
    });

    expect(mocks.ai).toHaveBeenCalledTimes(3);
    expect(mocks.ai.mock.calls[2]?.[1]).toContain('LANGUAGE CORRECTION');
    expect(mocks.ai.mock.calls[2]?.[1]).toContain('Rewrite every speech segment in natural Simplified Chinese');
    expect(result.scenes[0].actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'speech',
        text: expect.stringContaining('证据与结论'),
      }),
    ]));
  });

  it('does not invoke the obsolete spatial sketch browser', async () => {
    mocks.sketch.mockRejectedValue(Object.assign(new Error('browser page crashed'), { code: 'SPATIAL_MEASUREMENT_UNAVAILABLE' }));
    mocks.ai.mockResolvedValueOnce(JSON.stringify(content)).mockResolvedValueOnce(JSON.stringify(narration));
    const result = await generateClassroom(input, { preparedOutlines: [outline] });
    expect(result.scenes).toHaveLength(1);
    expect(mocks.ai.mock.calls[0][2]).toBeUndefined();
    expect(mocks.sketch).not.toHaveBeenCalled();
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it('keeps an already completed page checkpoint when a later page is invalid, with no quality retry', async () => {
    mocks.ai.mockResolvedValueOnce(JSON.stringify(content)).mockResolvedValueOnce(JSON.stringify(narration)).mockResolvedValueOnce('{"invalid":true}');
    const onSceneCompleted = vi.fn();
    await expect(generateClassroom(input, { preparedOutlines: [outline, { ...outline, id: 'invalid-page', order: 1 }], onSceneCompleted })).rejects.toThrow();
    expect(mocks.ai).toHaveBeenCalledTimes(3);
    expect(onSceneCompleted).toHaveBeenCalledOnce();
    expect(onSceneCompleted.mock.calls[0][0].id).toBe(outline.id);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('round-trips real outline fingerprints through persistence and resumes without reauthoring', async () => {
    mocks.ai.mockResolvedValueOnce(JSON.stringify(content)).mockResolvedValueOnce(JSON.stringify(narration));
    let prepared: SceneOutline[] = [];
    let checkpoint: PageCheckpointSnapshot | undefined;
    const first = await generateClassroom(input, { preparedOutlines: [outline],
      onOutlinesPrepared: (outlines) => { prepared = JSON.parse(JSON.stringify(outlines)); },
      onSceneCompleted: (outline, scene) => { checkpoint = JSON.parse(JSON.stringify({ pageKey: outline.id, outlineFingerprint: fingerprintSceneOutline(outline), scene })); },
    });
    expect(checkpoint).toBeDefined();
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    mocks.ai.mockClear();
    mocks.sketch.mockClear();
    const restored = await generateClassroom(input, { preparedOutlines: prepared,
      loadSceneCheckpoint: (outline, _index, stageId) => restoreSceneCheckpoint(outline, checkpoint, stageId),
    });
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.sketch).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(restored.scenes[0].id).toBe(first.scenes[0].id);
    expect(restored.scenes[0].stageId).toBe(restored.stage.id);
    expect(restored.scenes[0].stageId).not.toBe(first.stage.id);
    expect(restored.scenes[0].content).toEqual(first.scenes[0].content);
    expect(restored.scenes[0].actions).toEqual(first.scenes[0].actions);
    expect(restored.assetContext.outlines[0].spatialBudget).toEqual(spatialBudget);
  });

});
