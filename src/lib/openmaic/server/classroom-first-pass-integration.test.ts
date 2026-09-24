import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { teachingBlueprintToOutlines } from '@/lib/course-design/teaching-blueprint';
import type { TeachingBlueprint } from '@/lib/session/types';
import { TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION } from '../generation/teaching-contract-version';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
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
  compiledContinuation: vi.fn(),
}));
// Default authoring remains the real native generator. A legacy/explicit-flow
// compiler output can be supplied only by the continuation integration case.
vi.mock('../generation/scene-generator', async (original) => {
  const actual = await original<typeof import('../generation/scene-generator')>();
  return { ...actual, generateSceneContent: async (...args: Parameters<typeof actual.generateSceneContent>) => {
    const generated = await actual.generateSceneContent(...args);
    return generated ? mocks.compiledContinuation(generated, args[0]) ?? generated : generated;
  } };
});
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
vi.mock('../generation/teaching-narration', async (original) => ({
  ...await original<typeof import('../generation/teaching-narration')>(),
  generateTeachingNarration: async ({ outline: saved, aiCall }: {
    outline: SceneOutline;
    aiCall: (system: string, user: string) => Promise<string>;
  }) => {
    const raw = JSON.parse(await aiCall('Independent teaching narration', JSON.stringify(saved.teachingBrief))) as Array<{ type: string; content: string }>;
    return {
      pageId: saved.id,
      segments: raw.filter((item) => item.type === 'text').map((item, index) => ({
        id: `${saved.id}:speech-${index + 1}`, pageId: saved.id,
        text: item.content, semanticIds: [`${saved.id}:teaching`],
      })),
    };
  },
  generateTeachingSectionNarration: async ({ sectionId, pages, aiCall }: {
    sectionId: string;
    pages: Array<{ outline: SceneOutline; content: unknown }>;
    aiCall: (system: string, user: string) => Promise<string>;
  }) => {
    const raw = JSON.parse(await aiCall('Section teaching narration', JSON.stringify(pages))) as Array<{ type: string; content: string }>;
    return { sectionId, pages: pages.map(({ outline: saved }) => ({
      pageId: saved.id,
      segments: raw.filter((item) => item.type === 'text').map((item, index) => ({
        id: `${saved.id}:speech-${index + 1}`, pageId: saved.id,
        text: item.content, semanticIds: [`${saved.id}:teaching`],
      })),
    })) };
  },
}));

import { closeSpatialMeasurementBrowser } from '../generation/slide-spatial-measurement';
afterAll(async () => { await closeSpatialMeasurementBrowser(); });

import { generateClassroom } from './classroom-generation';
import { fingerprintSceneOutline, restoreSceneCheckpoint, restoreSceneStageCheckpoint, type PageCheckpointSnapshot, type SceneStageCheckpointSnapshot } from '@/lib/course-generation/page-checkpoints';
import { TEACHING_ENHANCEMENT_VERSION } from '../generation/teaching-enhancement';
import { TEACHING_NARRATION_VERSION } from '../generation/teaching-narration';
import { COURSE_GENERATION_POLICY_VERSION } from '../generation/course-generation-policy';

const teachingPlan = {
  purpose: '理解证据与结论的关系', priorKnowledge: '学生知道资料可被引用',
  learnerQuestion: '如何区分表达与事实', newContent: '独立证据支持结论',
  reasoningSteps: ['辨识主张', '追溯来源', '按证据范围判断'],
  visibleContent: ['首遍证据'], narrationFocus: ['解释为何需要独立来源'],
  takeaway: '表达流畅不能证明事实成立',
  taskConnection: { mode: 'none' as const, rationale: '独立核验案例更直接，不需要连接最终任务。' },
};
const sharedContext = {
  learningPurpose: '判断一个结论能否由证据支持', caseId: 'evidence-check',
  caseFacts: ['学生核对一个具体事实说法'], fixedWording: ['表达流畅不能证明事实成立'],
  stableTerms: ['事实说法', '独立来源'], conceptBoundaries: ['同源转载不能提供多份独立证据'],
};

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
const authoredContent = { background: { type: 'solid', color: '#ffffff' }, elements: [
  { id: 'native-title', type: 'text', left: 60, top: 45, width: 880, height: 56, content: '<p style="font-size:28px;font-weight:700;color:#1e3a8a">证据如何支持结论</p>' },
  { id: 'native-subtitle', type: 'text', left: 60, top: 110, width: 880, height: 48, content: '<p style="font-size:18px;color:#64748b">先判断来源，再解释证据与结论的关系。</p>' },
  { id: 'native-panel', type: 'shape', left: 60, top: 175, width: 880, height: 230, viewBox: [100, 100], path: 'M 0 0 L 100 0 L 100 100 L 0 100 Z', fill: '#eff6ff' },
  { id: 'native-evidence', type: 'text', left: 80, top: 195, width: 840, height: 80, content: '<p style="font-size:22px;color:#334155"><strong style="color:#1e3a8a">首遍证据：</strong>独立来源能够支持事实判断。</p>' },
  { id: 'native-explanation', type: 'text', left: 80, top: 285, width: 840, height: 80, content: '<p style="font-size:22px;color:#334155">保留首遍编译后的内容，<strong>同源转载</strong>不能当作多个独立来源。</p>' },
] };
const narration = [{ type: 'text', content: '短讲稿。' }, { type: 'action', name: 'wb_draw_latex', params: { latex: '\\frac{x}{', x: 20, y: 20, width: 100, height: 50 } }];
const input = { requirement: '从保存的大纲继续生成', agentMode: 'default' as const, enableImageGeneration: false, enableVideoGeneration: false, enableTTS: false };

describe('classroom first-pass orchestration and checkpoint integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ai.mockReset();
    mocks.compiledContinuation.mockReset();
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
      returnedCheckpoint = { id: 'completed-page', stageId, type: 'slide', title: outline.title, order: 0, content: { type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625, elements: content.elements } }, actions: [{ id: 'saved-speech', type: 'speech', text: '已保存讲稿。' }], createdAt: 1, updatedAt: 1 } as unknown as Scene;
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

  it('keeps the full formal outline as page input while generating only the requested test lesson pages', async () => {
    const second = { ...outline, id: 'saved-page--spatial-2', title: '第二个正式页面', order: 1 };
    const prepared = [outline, second];
    const checkpoint = (savedOutline: SceneOutline, stageId: string): Scene => ({
      id: `completed-${savedOutline.id}`,
      stageId,
      outlineId: savedOutline.id,
      type: 'slide',
      title: savedOutline.title,
      order: savedOutline.order,
      content: { type: 'slide', canvas: { id: `canvas-${savedOutline.id}`, viewportSize: 1000, viewportRatio: 0.5625, elements: content.elements } },
      actions: [{ id: 'saved-speech', type: 'speech', text: '已保存讲稿。' }],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Scene);
    const testFingerprints = new Map<string, string | undefined>();
    const formalFingerprints = new Map<string, string | undefined>();
    const onOutlinesPrepared = vi.fn();

    const testResult = await generateClassroom(input, {
      preparedOutlines: prepared,
      generationOutlineIds: [second.id],
      onOutlinesPrepared,
      loadSceneCheckpoint: (savedOutline, _index, stageId, _model, inputFingerprint) => {
        testFingerprints.set(savedOutline.id, inputFingerprint);
        return checkpoint(savedOutline, stageId);
      },
    });
    const formalResult = await generateClassroom(input, {
      preparedOutlines: prepared,
      loadSceneCheckpoint: (savedOutline, _index, stageId, _model, inputFingerprint) => {
        formalFingerprints.set(savedOutline.id, inputFingerprint);
        return checkpoint(savedOutline, stageId);
      },
    });

    expect(onOutlinesPrepared.mock.calls[0][0].map((item: SceneOutline) => item.id)).toEqual(prepared.map((item) => item.id));
    expect(testResult.assetContext.outlines.map((item) => item.id)).toEqual([second.id]);
    expect(formalResult.assetContext.outlines.map((item) => item.id)).toEqual(prepared.map((item) => item.id));
    expect(testFingerprints.get(second.id)).toBe(formalFingerprints.get(second.id));
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it('enhances only the generically selected test section while preserving the full outline for promotion', async () => {
    const first: SceneOutline = {
      ...outline,
      id: 'formal-section-a-page',
      title: '第一小节概念讲解',
      generationPurpose: 'knowledge-teaching',
      lectureSectionId: 'section-a',
      lectureSectionTitle: '第一小节',
    };
    const second: SceneOutline = {
      ...outline,
      id: 'formal-section-b-page',
      title: '教师重点对应的小节',
      order: 1,
      generationPurpose: 'knowledge-teaching',
      lectureSectionId: 'section-b',
      lectureSectionTitle: '教师重点小节',
    };
    mocks.ai.mockImplementation(async (system: string, user: string) => {
      if (system.includes('课程小节的教学设计师')) {
        expect(user).toContain(second.id);
        return JSON.stringify({ sharedContext, pages: [{
          outlineId: second.id,
          explanation: '只为所选完整小节补充可制作的实质解释。',
          examples: ['用一个具体材料说明所选知识。'],
          conditions: ['结论只适用于给定条件。'],
          assessmentFocus: '说明判断及理由。',
          evidenceQuotes: [],
          teachingPlan,
        }] });
      }
      if (system.includes('# Slide Content Generator')) return JSON.stringify(authoredContent);
      if (system.includes('Slide Action Generator') || system === 'Section teaching narration') return JSON.stringify(narration);
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });
    const onOutlinesPrepared = vi.fn();
    const onProgress = vi.fn();

    const result = await generateClassroom({ ...input, sceneOutlines: [first, second] }, {
      generationOutlineIds: [second.id],
      onOutlinesPrepared,
      onProgress,
      loadSceneCheckpoint: () => null,
    });

    expect(result.assetContext.outlines.map((item) => item.id)).toEqual([second.id]);
    const persisted = onOutlinesPrepared.mock.calls[0]?.[0] as SceneOutline[];
    expect(persisted.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(persisted[0]?.teachingBrief).toBeUndefined();
    expect(persisted[1]?.teachingBrief?.explanation).toContain('所选完整小节');
    expect(mocks.ai.mock.calls.filter(([system]) => system.includes('课程小节的教学设计师'))).toHaveLength(1);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      step: 'generating_outlines',
      message: '正在生成分小节教学设计（1/1）',
      totalScenes: 1,
    }));
  });

  it.each([undefined, 'natural-teacher-speech-v2'])('invalidates knowledge checkpoints carrying old narration policy %s', async (legacyPolicy) => {
    const enhancedOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      audience: 'student',
      teachingBrief: {
        schemaVersion: 1,
        designVersion: TEACHING_ENHANCEMENT_VERSION,
        sharedContext,
        teachingPlan,
        explanation: '证据支持结论，语言流畅不能证明事实正确。',
        examples: ['核对一个具体年份。'],
        conditions: ['同源转载不是独立来源。'],
        evidence: [],
        assessmentFocus: '说明核验步骤和理由。',
      },
    };
    const legacyCheckpoint = {
      narrationRevision: legacyPolicy,
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
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('# Slide Content Generator')) return JSON.stringify(authoredContent);
      if (system.includes('Slide Action Generator') || system === 'Section teaching narration') return JSON.stringify(narration);
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });

    const result = await generateClassroom(input, {
      preparedOutlines: [enhancedOutline],
      loadSceneCheckpoint: () => legacyCheckpoint,
    });

    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls.some(([system]) => system.includes('中文课堂讲稿编辑'))).toBe(false);
    expect(result.scenes[0]?.id).not.toBe('legacy-first-draft');
    expect(result.scenes[0]?.narrationRevision).toBe(COURSE_GENERATION_POLICY_VERSION);
  });

  it('restores a structurally complete slide without running layout review', async () => {
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
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('课程小节的教学设计师')) {
        return JSON.stringify({ sharedContext, pages: [{
          outlineId: themedOutline.id,
          explanation: '解释两个概念之间的证据关系。',
          examples: ['用一个具体判断任务逐步说明。'],
          conditions: ['结论只能落在已有证据范围内。'],
          assessmentFocus: '说明判断和理由。',
          evidenceQuotes: [],
          teachingPlan,
        }] });
      }
      if (system.includes('# Slide Content Generator')) return JSON.stringify(authoredContent);
      if (system.includes('Slide Action Generator') || system === 'Section teaching narration') return JSON.stringify(narration);
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
          elements: content.elements,
        },
      },
      actions: [{ id: 'saved-speech', type: 'speech', text: '已保存讲稿。' }],
      narrationRevision: COURSE_GENERATION_POLICY_VERSION,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Scene;

    const result = await generateClassroom(input, {
      preparedOutlines: [themedOutline],
      loadSceneCheckpoint: () => checkpoint,
    });

    expect(mocks.ai).not.toHaveBeenCalled();
    expect(result.scenes[0]?.id).toBe('sparse-checkpoint');
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.layout).not.toHaveBeenCalled();
    expect(mocks.density).not.toHaveBeenCalled();
    expect(result.qualityReport).toMatchObject({ status: 'not-checked', disposition: 'ready' });
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
      actions: [{ id: 'saved-speech', type: 'speech', text: '已保存讲稿。' }],
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
    expect(mocks.density).not.toHaveBeenCalled();
    expect(result.qualityReport).toMatchObject({ status: 'not-checked', disposition: 'ready' });
  });

  it('ignores the saved legacy spatial plan and uses the official prompt once', async () => {
    mocks.ai.mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify(narration));
    const onSceneCompleted = vi.fn();
    const result = await generateClassroom(input, { preparedOutlines: [outline], loadSceneCheckpoint: () => null, onSceneCompleted });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.sketch).not.toHaveBeenCalled();
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls[0][0]).toContain('# Slide Content Generator');
    expect(mocks.ai.mock.calls[0][1]).not.toContain('browser-renderer-fonts-v1');
    expect(mocks.ai.mock.calls[0][1]).not.toContain('Course-wide visual theme contract');
    expect(mocks.ai.mock.calls[0][2]).toBeUndefined();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(result.scenes[0].content.type).toBe('slide');
    if (result.scenes[0].content.type !== 'slide') throw new Error('Expected a slide');
    const elements = result.scenes[0].content.canvas.elements;
    expect(elements).toHaveLength(authoredContent.elements.length);
    expect(elements.filter((element) => element.type === 'text').map((element) => element.content).join('')).toContain('首遍证据');
    expect(elements.map((element) => [element.type, element.left, element.top, element.width, 'height' in element ? element.height : undefined])).toEqual(
      authoredContent.elements.map((element) => [element.type, element.left, element.top, element.width, element.height]),
    );
    expect(elements.find((element) => element.type === 'shape')).toMatchObject({ fill: '#eff6ff' });
    expect(elements.filter((element) => element.type === 'text').map((element) => element.content).join('')).toContain('<strong');
    expect(elements.filter((element) => element.type === 'text').map((element) => element.content).join('')).toContain('#1e3a8a');
    expect(result.scenes[0].actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'speech', text: expect.stringContaining('短讲稿。') })]));
    expect(onSceneCompleted).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it('waits for the slide response before writing section narration', async () => {
    const knowledgeOutline: SceneOutline = {
      ...outline, generationPurpose: 'knowledge-teaching',
      teachingBrief: {
        schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, sharedContext, teachingPlan,
        explanation: '证据支持结论。', examples: [], conditions: [], evidence: [], assessmentFocus: '说明判断理由。',
      },
    };
    let finishSlide!: (value: string) => void;
    const slideResponse = new Promise<string>((resolve) => { finishSlide = resolve; });
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('# Slide Content Generator')) return slideResponse;
      if (system === 'Section teaching narration') return JSON.stringify(narration);
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });
    const pending = generateClassroom(input, { preparedOutlines: [knowledgeOutline] });
    await vi.waitFor(() => expect(mocks.ai.mock.calls.some(([system]) => system.includes('# Slide Content Generator'))).toBe(true));
    expect(mocks.ai.mock.calls.some(([system]) => system === 'Section teaching narration')).toBe(false);
    finishSlide(JSON.stringify(authoredContent));
    const result = await pending;
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls.some(([system]) => system === 'Section teaching narration')).toBe(true);
    expect(mocks.ai.mock.calls.some(([system]) => system.includes('Slide Action Generator'))).toBe(false);
    expect(result.scenes[0]?.actions?.some((action) => action.type === 'speech' && action.text.includes('短讲稿。'))).toBe(true);
  });

  it('resumes after independent narration failure without regenerating completed content', async () => {
    const resumableOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      teachingBrief: {
        schemaVersion: 1,
        designVersion: TEACHING_ENHANCEMENT_VERSION,
        sharedContext,
        teachingPlan,
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
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('# Slide Content Generator')) return JSON.stringify(authoredContent);
      if (system === 'Section teaching narration') {
        if (!narrationAvailable) throw Object.assign(new Error('Receive batching backend response failed'), { code: 'InternalError' });
        return JSON.stringify([{ type: 'text', content: '判断信息是否可靠，要回到独立来源核对事实、证据和适用条件。' }]);
      }
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });
    const onProgress = vi.fn();
    const callbacks = {
      preparedOutlines: [resumableOutline],
      loadSceneCheckpoint: () => null,
      onProgress,
      loadSceneStageCheckpoint: (_saved: SceneOutline, stage: string) => stages.get(stage) ?? null,
      onSceneStageCompleted: async (
        _saved: SceneOutline,
        stage: string,
        payload: unknown,
      ) => { stages.set(stage, payload); },
    };

    await expect(generateClassroom(input, callbacks)).rejects.toThrow(/batching backend/);
    expect([...stages.keys()]).toEqual(['content']);
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    const failedNarration = [...onProgress.mock.calls]
      .reverse()
      .map(([progress]) => progress)
      .find((progress) => progress.stageProgress?.some((stage: { stage: string; failedPages: unknown[] }) => stage.stage === 'narration' && stage.failedPages.length > 0));
    expect(failedNarration?.stageProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'content', completedPages: [1] }),
      expect.objectContaining({ stage: 'narration', failedPages: [expect.objectContaining({ index: 1 })] }),
    ]));

    narrationAvailable = true;
    const result = await generateClassroom(input, callbacks);

    expect(mocks.ai).toHaveBeenCalledTimes(3);
    expect(mocks.ai.mock.calls.filter(([system]) => system.includes('# Slide Content Generator'))).toHaveLength(1);
    expect(mocks.ai.mock.calls.filter(([system]) => system.includes('Slide Action Generator'))).toHaveLength(0);
    expect(mocks.review).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(JSON.stringify({ sharedContext, pages: [{
        outlineId: outline.id,
        explanation: '解释两个概念之间的证据关系。',
        examples: ['用一个具体判断任务逐步说明。'],
        conditions: ['结论只能落在已有证据范围内。'],
        assessmentFocus: '说明判断和理由。',
        evidenceQuotes: [],
        teachingPlan,
      }] }))
      .mockResolvedValueOnce(JSON.stringify(authoredContent))
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
    const completedProgress = [...onProgress.mock.calls]
      .reverse()
      .map(([progress]) => progress)
      .find((progress) => progress.step === 'completed');
    expect(completedProgress?.stageProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'content', total: 1, completedPages: [1] }),
      expect.objectContaining({ stage: 'actions', total: 1, completedPages: [1] }),
      expect.objectContaining({ stage: 'assembling', total: 1, completedPages: [1] }),
    ]));
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
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('课程小节的教学设计师')) {
        return JSON.stringify({ sharedContext, pages: [{
          outlineId: enhancedOutline.id,
          explanation: '证据支持结论，表达流畅本身不能证明事实正确。',
          examples: ['先标出年份主张，再查找独立原始资料并记录差异。'],
          conditions: ['同源转载不能当作多个独立来源。'],
          assessmentFocus: '说明核验步骤以及每一步的理由。',
          evidenceQuotes: [],
          teachingPlan,
        }] });
      }
      if (system.includes('# Slide Content Generator')) return JSON.stringify(authoredContent);
      if (system.includes('Slide Action Generator') || system === 'Section teaching narration') return JSON.stringify(narration);
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });

    const result = await generateClassroom({
      ...input,
      sceneOutlines: [enhancedOutline],
      courseTitle: '人工智能信息核验',
      languageDirective: '使用简体中文授课',
    }, { loadSceneCheckpoint: () => null });

    expect(mocks.ai).toHaveBeenCalledTimes(3);
    const contentCall = mocks.ai.mock.calls.find(([system]) => system.includes('# Slide Content Generator'));
    const narrationCall = mocks.ai.mock.calls.find(([system]) => system === 'Section teaching narration');
    expect(contentCall?.[0]).toContain('CoTeach teaching enhancement adapter');
    expect(contentCall?.[1]).toContain('同源转载不能当作多个独立来源');
    expect(narrationCall?.[1]).toContain('说明核验步骤以及每一步的理由');
    expect(result.assetContext.outlines[0]?.teachingBrief?.examples).toEqual([
      '先标出年份主张，再查找独立原始资料并记录差异。',
    ]);
    expect(result.scenes[0]?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'speech', text: '短讲稿。' }),
    ]));
    expect(result.scenes[0]?.narrationRevision).toBe(COURSE_GENERATION_POLICY_VERSION);
    expect(result.qualityReport.teachingEnhancementVersion).toBe(TEACHING_ENHANCEMENT_VERSION);
    expect(result.qualityReport.narrationEnhancementVersion).toBe(TEACHING_NARRATION_VERSION);
    expect(result.qualityReport.reviewMode).toBeUndefined();
    expect(result.qualityReport.reviewPolicyVersion).toBe(COURSE_GENERATION_POLICY_VERSION);
  });

  it('preserves the initial playable speech without a style review pass', async () => {
    const originalText = '同学们好，欢迎来到今天的课堂。这一页的核心观点是核验信息。';
    mocks.ai.mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify([
      { type: 'text', content: originalText },
    ]));

    const result = await generateClassroom(input, {
      preparedOutlines: [outline],
      loadSceneCheckpoint: () => null,
    });

    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls.some(([system]) => system.includes('中文课堂讲稿编辑'))).toBe(false);
    expect(result.scenes[0].actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'speech', text: expect.stringContaining(originalText) }),
    ]));
    expect(result.scenes[0]!.actions?.find((action) => action.type === 'speech')).toMatchObject({
      type: 'speech', text: expect.stringMatching(/感谢大家的认真参与，同学们再见。$/),
    });
    expect(result.qualityReport.warnings).toEqual([]);
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it('resolves the teacher-selected model once and reuses it for every authoring call', async () => {
    mocks.resolve.mockResolvedValue({
      model: {},
      modelInfo: { capabilities: { vision: true }, outputWindow: 393_216 },
      modelString: 'deepseek:teacher-selected',
      providerId: 'deepseek',
      apiKey: 'test',
    });
    mocks.ai.mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify(narration));
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
      maxRetries: 1,
      streamResponse: true,
    }));
    for (const source of [
      'generate-classroom',
      'classroom-section-teaching-design',
    ]) {
      const structuredCall = mocks.createAiCall.mock.calls.find(([options]) => (
        (options as { source?: string }).source === source
      ));
      expect(structuredCall?.[0]).toEqual(expect.objectContaining({
        source,
        timeoutMs: 600_000,
        outputBudget: expect.any(Function),
        maxRetries: 1,
      }));
      expect((structuredCall?.[0] as { streamResponse?: boolean }).streamResponse).toBe(true);
    }
    const selectedModel = mocks.createAiCall.mock.calls[0]?.[0]?.model;
    expect(mocks.createAiCall.mock.calls.slice(0, 4).every(([options]) => options.model === selectedModel))
      .toBe(true);
  });

  it('does not run layout review after a structurally usable first draft', async () => {
    mocks.review.mockImplementationOnce(async (options: { content: typeof content; regenerate?: unknown }) => {
      expect(options.regenerate).toBeTypeOf('function');
      await expect((options.regenerate as () => Promise<null>)()).resolves.toBeNull();
      return {
        content: options.content,
        initialAudit: { status: 'checked', issues: ['text overlaps the diagram'] },
        finalAudit: { status: 'checked', issues: ['text overlaps the diagram'] },
        repairAttempted: false,
        adopted: 'first-draft',
        initialKnowledgeCoverage: 1,
        finalKnowledgeCoverage: 1,
        initialDensityIssues: ['普通讲授页可见教学文字低于基线'],
        finalDensityIssues: ['普通讲授页可见教学文字低于基线'],
      };
    });
    mocks.ai.mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify(narration));

    const result = await generateClassroom({ ...input, generationModelString: 'deepseek:teacher-selected' }, {
      preparedOutlines: [outline],
      loadSceneCheckpoint: () => null,
    });

    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls.some(([, user]) => user.includes('## EDIT MODE'))).toBe(false);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(result.qualityReport).toMatchObject({ status: 'not-checked', disposition: 'ready' });
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it('keeps the official first draft without invoking an unavailable audit', async () => {
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
    mocks.ai.mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify(narration));

    const result = await generateClassroom(input, { preparedOutlines: [outline] });

    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(result.qualityReport).toMatchObject({
      generationMethod: 'classic-one-click',
      generationModelString: 'test-model',
      status: 'not-checked',
      disposition: 'ready',
    });
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('keeps a parseable narration draft without a language rewrite call', async () => {
    mocks.ai
      .mockResolvedValueOnce(JSON.stringify(authoredContent))
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

    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(result.scenes[0].actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'speech',
        text: expect.stringContaining('Today we will explain'),
      }),
    ]));
  });

  it('does not invoke the obsolete spatial sketch browser', async () => {
    mocks.sketch.mockRejectedValue(Object.assign(new Error('browser page crashed'), { code: 'SPATIAL_MEASUREMENT_UNAVAILABLE' }));
    mocks.ai.mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify(narration));
    const result = await generateClassroom(input, { preparedOutlines: [outline] });
    expect(result.scenes).toHaveLength(1);
    expect(mocks.ai.mock.calls[0][2]).toBeUndefined();
    expect(mocks.sketch).not.toHaveBeenCalled();
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it('keeps an already completed page checkpoint while retrying a later malformed output once', async () => {
    mocks.ai
      .mockResolvedValueOnce(JSON.stringify(authoredContent))
      .mockResolvedValueOnce(JSON.stringify(narration))
      .mockResolvedValueOnce('{"invalid":true}')
      .mockResolvedValueOnce('{"invalid":true}');
    const onSceneCompleted = vi.fn();
    await expect(generateClassroom(input, { preparedOutlines: [outline, { ...outline, id: 'invalid-page', order: 1 }], onSceneCompleted })).rejects.toThrow();
    expect(mocks.ai).toHaveBeenCalledTimes(4);
    expect(onSceneCompleted).toHaveBeenCalledOnce();
    expect(onSceneCompleted.mock.calls[0][0].id).toBe(outline.id);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('round-trips real outline fingerprints through persistence and resumes without reauthoring', async () => {
    mocks.ai.mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify(narration));
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

  it('expands previously compiled continuation pages before one section narration while retaining timing, stable IDs and media through promotion', async () => {
    const saved: SceneOutline = {
      ...outline, id: 'flow-observation', spatialParentId: undefined, generationPurpose: 'knowledge-teaching', lectureSectionId: 'observations',
      targetDurationSec: 61, estimatedDuration: 61,
      teachingBrief: { schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, sharedContext, teachingPlan,
        explanation: '先观察证据，再解释判断。', examples: [], conditions: [], evidence: [], assessmentFocus: '依据证据解释。' },
      mediaGenerations: [{ type: 'image', elementId: 'gen_img_observation', prompt: '观察形态差异', aspectRatio: '16:9' }],
      visualIntent: { observationGoal: '观察可见结构的差异', representation: 'mixed', resourceRefs: [
        { kind: 'generated-image', resourceId: 'gen_img_observation', required: true, reason: '比较可见形态' },
      ] },
    };
    const later: SceneOutline = { ...saved, id: 'later-observation', lectureSectionId: 'later-observations', order: 1 };
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('# Slide Content Generator')) return JSON.stringify({
        ...authoredContent, elements: [...authoredContent.elements,
          { id: 'gen_img_observation', type: 'image', src: 'gen_img_observation', left: 760, top: 420, width: 120, height: 70 },
        ],
      });
      if (system === 'Section teaching narration') return JSON.stringify(narration);
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });
    // Native authoring no longer splits a page by default. Keep the downstream
    // integration regression using an already compiled continuation payload,
    // as produced by an explicit flow caller or a saved compiler checkpoint.
    // Both sections expand: the later expansion must not re-time accepted pages.
    mocks.compiledContinuation.mockImplementation((generated: GeneratedSlideContent, page: SceneOutline) => ({
      ...generated, teachingText: ['观察图像中的可见结构差异。'],
      continuationPages: [{
        elements: generated.elements.filter((element) => element.type !== 'image' && element.type !== 'video')
          .map((element) => ({ ...element, id: `${page.id}-continuation-${element.id}` })),
        teachingText: ['依据可见差异说明判断所依据的证据，以及结论适用的条件。'],
      }],
    }));
    const onOutlinesPrepared = vi.fn();
    const stages = new Map<string, SceneStageCheckpointSnapshot>();
    const completedPages = new Map<string, PageCheckpointSnapshot>();
    const stageCallbacks = {
      onSceneCompleted: (page: SceneOutline, scene: Scene, _index: number, modelFingerprint: string, inputFingerprint?: string) => {
        completedPages.set(page.id, JSON.parse(JSON.stringify({ pageKey: page.id, outlineFingerprint: fingerprintSceneOutline(page), scene, modelFingerprint, inputFingerprint })));
      },
      loadSceneCheckpoint: (page: SceneOutline, _index: number, stageId: string, modelFingerprint: string, inputFingerprint?: string) => restoreSceneCheckpoint(
        page, completedPages.get(page.id), stageId, modelFingerprint, inputFingerprint,
      ),
      onSceneStageCompleted: (page: SceneOutline, stage: SceneStageCheckpointSnapshot['stage'], payload: unknown, modelFingerprint: string, inputFingerprint?: string) => {
        stages.set(`${page.id}:${stage}`, JSON.parse(JSON.stringify({ schemaVersion: 1, pageKey: page.id, stage,
          outlineFingerprint: fingerprintSceneOutline(page), payload, modelFingerprint, inputFingerprint })));
      },
      loadSceneStageCheckpoint: (page: SceneOutline, stage: SceneStageCheckpointSnapshot['stage'], modelFingerprint: string, inputFingerprint?: string) => restoreSceneStageCheckpoint({
        outline: page, stage, modelFingerprint, inputFingerprint, checkpoint: stages.get(`${page.id}:${stage}`),
      }),
    };
    const result = await generateClassroom({ ...input, enableImageGeneration: true }, {
      preparedOutlines: [saved, later], generationOutlineIds: [saved.id], onOutlinesPrepared, ...stageCallbacks,
    });
    expect(result.scenes).toHaveLength(2);
    const narrationCalls = mocks.ai.mock.calls.filter(([system]) => system === 'Section teaching narration');
    expect(narrationCalls).toHaveLength(1);
    const narrated = JSON.parse(narrationCalls[0][1]) as Array<{ outline: SceneOutline }>;
    expect(narrated.map(({ outline: page }) => page.id)).toEqual(['flow-observation', 'flow-observation--continuation-2']);
    expect(result.assetContext.outlines.reduce((total, page) => total + (page.targetDurationSec ?? 0), 0)).toBe(61);
    expect(result.assetContext.outlines.map((page) => page.mediaGenerations?.length ?? 0)).toEqual([1, 0]);
    expect(result.assetContext.outlines[1].visualIntent?.resourceRefs).toHaveLength(0);
    expect(result.assetContext.outlines[0].keyPoints).toContain('观察图像中的可见结构差异。');
    expect(result.scenes.every((scene) => scene.actions?.some((action) => action.type === 'speech'))).toBe(true);
    const targets = result.scenes.flatMap((scene) => scene.content.type === 'slide' ? scene.content.canvas.elements.map((element) => element.id) : []);
    expect(new Set(targets).size).toBe(targets.length);
    const lastSaved = onOutlinesPrepared.mock.calls.at(-1)?.[0] as SceneOutline[];
    expect(lastSaved.map((page) => page.id)).toEqual([...result.assetContext.outlines.map((page) => page.id), later.id]);
    for (const page of completedPages.values()) {
      for (const action of page.scene.actions ?? []) if (action.type === 'speech' && action.text.trim()) {
        action.audioUrl = `/api/openmaic/classroom-media/accepted-test/audio/${action.id}.wav`;
      }
    }
    mocks.ai.mockClear();
    const resumed = await generateClassroom({ ...input, enableImageGeneration: true }, {
      preparedOutlines: JSON.parse(JSON.stringify(lastSaved)), generationOutlineIds: [saved.id], ...stageCallbacks,
    });
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(resumed.scenes.map(page => page.id)).toEqual(result.scenes.map(page => page.id));
    const spokenMedia = (scenes: Scene[]) => scenes.flatMap(page => (page.actions ?? []).flatMap(action => action.type === 'speech' && action.text.trim() ? [{ id: action.id, text: action.text, url: action.audioUrl }] : []));
    expect(spokenMedia(resumed.scenes).every(action => action.url?.includes('/accepted-test/'))).toBe(true);
    const promoted = await generateClassroom({ ...input, enableImageGeneration: true }, {
      preparedOutlines: JSON.parse(JSON.stringify(lastSaved)), ...stageCallbacks,
    });
    expect(mocks.ai.mock.calls.filter(([system]) => system.includes('# Slide Content Generator'))).toHaveLength(1);
    expect(mocks.ai.mock.calls.filter(([system]) => system === 'Section teaching narration')).toHaveLength(1);
    expect(promoted.scenes.slice(0, 2).map(page => page.id)).toEqual(result.scenes.map(page => page.id));
    expect(spokenMedia(promoted.scenes.slice(0, 2))).toEqual(spokenMedia(resumed.scenes));
  });

  it('executes a compiled current blueprint without a second section teaching-design request', async () => {
    const blueprint: TeachingBlueprint = {
      schemaVersion: 3, inputFingerprint: 'compiled-design', assessmentMode: 'adaptive', createdAt: '2026-09-23T00:00:00Z',
      budget: { totalDurationSec: 70, teachingDurationSec: 60, learnerActivityDurationSec: 0, assessmentDurationSec: 10,
        teachingRatio: 60 / 70, assessmentRatio: 10 / 70 },
      sections: [{ id: 'compiled-section', title: '证据支持结论', order: 0, learningObjective: '依据独立证据作出判断',
        sharedContext, knowledgePointIds: ['evidence'],
        units: [{ id: 'evidence-unit', title: '独立证据', knowledgePointIds: ['evidence'], learningOutcome: '说明证据如何支持判断',
          explanation: '独立证据为事实判断提供依据。', mechanism: '先核对来源，再判断结论。', workedExample: '',
          conditions: [], misconceptions: [], sourceKind: 'course-source', evidenceQuotes: [],
          explanationNodes: [{ id: 'evidence-concept', kind: 'concept', content: '独立证据为事实判断提供依据。',
            knowledgePointIds: ['evidence'], prerequisiteNodeIds: [], provenance: 'course-source' }],
        }],
        pages: [{ id: 'compiled-page', type: 'slide', title: '独立证据的作用', unitIds: ['evidence-unit'], knowledgePointIds: ['evidence'],
          description: '说明独立证据支持结论的关系。', keyPoints: ['独立证据为事实判断提供依据。'], teachingObjective: '解释证据与结论的关系',
          introducesNodeIds: ['evidence-concept'], taskConnection: { mode: 'none', rationale: '直接理解证据概念。' },
        }],
        assessmentFocus: ['说明证据与结论的关系'], understandingCriteria: { goals: ['解释独立证据'], answerEssentials: ['追溯原始来源'], misconceptions: ['转载数量等于证据数量'], supportingUnitIds: ['evidence-unit'] },
        teachingDurationSec: 60, learnerActivityDurationSec: 0, assessmentDurationSec: 10,
      }],
    };
    const compiled = teachingBlueprintToOutlines(blueprint, '使用简体中文').filter((page) => page.type === 'slide');
    expect(compiled[0].teachingBrief?.designVersion).toBe(TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION);
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('# Slide Content Generator')) return JSON.stringify(authoredContent);
      if (system === 'Section teaching narration') return JSON.stringify(narration);
      throw new Error(`Unexpected additional teaching-design request: ${system.slice(0, 80)}`);
    });
    const result = await generateClassroom({ ...input, sceneOutlines: compiled }, {});
    expect(result.scenes).toHaveLength(1);
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls.some(([system]) => system.includes('课程小节的教学设计师'))).toBe(false);
    expect(result.assetContext.outlines[0].teachingBrief?.designVersion).toBe(TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION);
    expect(result.scenes[0].actions?.some((action) => action.type === 'speech')).toBe(true);
  });

});
