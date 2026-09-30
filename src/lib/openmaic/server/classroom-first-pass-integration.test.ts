import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { teachingBlueprintToOutlines } from '@/lib/course-design/teaching-blueprint';
import type { TeachingBlueprint } from '@/lib/session/types';
import { TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION } from '../generation/teaching-contract-version';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import type { Scene } from '../types/stage';
import type { SlideSpatialBudget } from '../generation/slide-spatial-types';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import * as sourceGrounding from '../generation/source-grounding';
import { restoreSourceContentCheckpoint, type SourceContentRecoveryCheckpoint } from '@/lib/course-generation/source-content-acceptance';

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
  contentFailure: vi.fn(),
  replan: vi.fn(),
  narrationInput: vi.fn(),
  insertionInput: vi.fn(),
  contentInput: vi.fn(),
  callContext: vi.fn(),
}));
// Default authoring remains the real native generator. A legacy/explicit-flow
// compiler output can be supplied only by the continuation integration case.
vi.mock('../generation/scene-generator', async (original) => {
  const actual = await original<typeof import('../generation/scene-generator')>();
  return { ...actual, generateSceneContent: async (...args: Parameters<typeof actual.generateSceneContent>) => {
    mocks.contentInput(args[0], args[2]);
    const failure = mocks.contentFailure(args[0]);
    if (failure) { args[2]?.onFailure?.(failure); return null; }
    const generated = await actual.generateSceneContent(...args);
    return generated ? mocks.compiledContinuation(generated, args[0]) ?? generated : generated;
  } };
});
vi.mock('../generation/section-capacity-replanner', async (original) => {
  const actual = await original<typeof import('../generation/section-capacity-replanner')>();
  return { ...actual, replanMeasuredTeachingSection: mocks.replan };
});
vi.mock('./resolve-model', () => ({ resolveModel: mocks.resolve }));
vi.mock('./course-generation-ai-call', () => ({
  createCourseGenerationAiCall: (options: unknown) => mocks.createAiCall(options),
  withCourseGenerationAiCallContext: (aiCall: unknown, context: unknown) => mocks.callContext(aiCall, context) ?? aiCall,
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
  generateTeachingSourceNarrationInsertions: async (...args: Parameters<typeof import('../generation/teaching-narration').generateTeachingSourceNarrationInsertions>) => {
    mocks.insertionInput(args[0]);
    const actual = await original<typeof import('../generation/teaching-narration')>();
    return actual.generateTeachingSourceNarrationInsertions(...args);
  },
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
  generateTeachingSectionNarration: async (input: {
    sectionId: string;
    pages: Array<{ outline: SceneOutline; content: unknown }>;
    aiCall: (system: string, user: string) => Promise<string>;
  }) => {
    mocks.narrationInput(input);
    const { sectionId, pages, aiCall } = input;
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
import { fingerprintGenerationValue, fingerprintSceneOutline, restoreSceneCheckpoint, restoreSceneStageCheckpoint, type PageCheckpointSnapshot, type SceneStageCheckpointSnapshot } from '@/lib/course-generation/page-checkpoints';
import { TEACHING_ENHANCEMENT_VERSION } from '../generation/teaching-enhancement';
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

function capacityPage(id: string, section = 'capacity-section'): SceneOutline {
  return { ...outline, id, spatialParentId: undefined, spatialBudget: undefined, lectureSectionId: section,
    generationPurpose: 'knowledge-teaching', knowledgePointIds: ['evidence'],
    plannedTiming: { role: 'teaching', narrationSec: 31, learnerActivitySec: 0, transitionSec: 0 },
    teachingBrief: { schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, sharedContext, teachingPlan,
      explanation: '独立证据支持结论。', examples: [], conditions: [], evidence: [], assessmentFocus: '判断事实。' } };
}

function capacityStageStore() {
  const stages = new Map<string, SceneStageCheckpointSnapshot>();
  const writes: Array<{ id: string; stage: SceneStageCheckpointSnapshot['stage'] }> = [];
  return { stages, writes, callbacks: {
    onSceneStageCompleted: (page: SceneOutline, stage: SceneStageCheckpointSnapshot['stage'], payload: unknown,
      modelFingerprint: string, inputFingerprint?: string) => {
      writes.push({ id: page.id, stage });
      stages.set(`${page.id}:${stage}`, JSON.parse(JSON.stringify({ schemaVersion: 1, pageKey: page.id, stage,
        outlineFingerprint: fingerprintSceneOutline(page), payload, modelFingerprint, inputFingerprint })));
    },
    loadSceneStageCheckpoint: (page: SceneOutline, stage: SceneStageCheckpointSnapshot['stage'],
      modelFingerprint: string, inputFingerprint?: string) => restoreSceneStageCheckpoint({ outline: page, stage,
      modelFingerprint, inputFingerprint, checkpoint: stages.get(`${page.id}:${stage}`) }),
  } };
}

const sourceLabels = ['先让学生熟悉生成式AI的应用场景', '根据学生的认知能力调整项目任务的复杂程度', '在实践的同时引入道德伦理思考'];
function sourceFixture() {
  const page = capacityPage('source-page', 'source-section');
  page.keyPoints = [...sourceLabels];
  page.teachingBrief = { ...page.teachingBrief!, teachingPlan: { ...teachingPlan, visibleContent: [...sourceLabels], presentationContent: ['首遍证据'] } };
  const sourceEvidence: CourseEvidenceSnapshot = {
    schemaVersion: 2, version: 1, fingerprint: 'original-book-source', createdAt: '2026-09-30T00:00:00Z',
    retrievalMode: 'lexical-degraded', selections: [{ revisionId: 'book-revision', primary: true, sectionIds: [] }],
    items: [{ id: 'original-evidence', kind: 'source-block', title: '生成式AI教学建议', content: sourceLabels.join('。'),
      source: { textbookId: 'book', textbookTitle: '采用的原始教材', revisionId: 'book-revision', revisionVersion: 1,
        sectionPath: ['生成式AI教学建议'], quote: sourceLabels.join('。') } }], mappings: [], warnings: [],
  };
  const contracts: FigureSequenceContract[] = [{ resourceId: 'original-source-list', required: true,
    knowledgePointIds: ['evidence'], orderedSteps: sourceLabels.map((label, index) => ({ order: index + 1, label })),
    sequenceSemantics: 'enumerated-items', scope: 'knowledge-point' }];
  return { page, sourceOptions: { sourceEvidence, sourceKnowledgePoints: [{ id: 'evidence', evidenceItemIds: ['original-evidence'] }],
    sourceSequenceContracts: contracts } };
}

function completedPageStore() {
  const pages = new Map<string, PageCheckpointSnapshot>();
  return { pages, callbacks: {
    onSceneCompleted: (page: SceneOutline, scene: Scene, _index: number, modelFingerprint: string, inputFingerprint?: string) => {
      pages.set(page.id, structuredClone({ pageKey: page.id, outlineFingerprint: fingerprintSceneOutline(page), scene, modelFingerprint, inputFingerprint }));
    },
    loadSceneCheckpoint: (page: SceneOutline, _index: number, stageId: string, modelFingerprint: string, inputFingerprint?: string) =>
      restoreSceneCheckpoint(page, pages.get(page.id), stageId, modelFingerprint, inputFingerprint),
  } };
}

function sourceCheckpointStore() {
  const checkpoints = new Map<string, SourceContentRecoveryCheckpoint>();
  return { checkpoints, callbacks: {
    loadSourceContentCheckpoint: (sectionId: string, sourceFingerprint: string, inputFingerprint: string, modelFingerprint: string) =>
      restoreSourceContentCheckpoint(checkpoints.get(sectionId), { sectionId, sourceFingerprint, inputFingerprint, modelFingerprint }),
    onSourceContentCheckpoint: (checkpoint: SourceContentRecoveryCheckpoint) => { checkpoints.set(checkpoint.sectionId, structuredClone(checkpoint)); },
  } };
}




describe('classroom first-pass orchestration and checkpoint integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ai.mockReset();
    mocks.compiledContinuation.mockReset();
    mocks.contentFailure.mockReset();
    mocks.replan.mockReset();
    mocks.createAiCall.mockReset().mockImplementation(() => mocks.ai);
    mocks.callContext.mockReset();
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
    mocks.layout.mockReset().mockResolvedValue({ status: 'checked', issues: [] });
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

  it('sends original adopted sources to both first calls while accepting concise slides and complete natural narration', async () => {
    const { page, sourceOptions } = sourceFixture();
    const recovery = sourceCheckpointStore();
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify([{ type: 'text', content: `我们先看实际课堂。教材提出${sourceLabels.join('；')}。以项目任务为例，难度要跟学生已有能力匹配。` }]));
    const result = await generateClassroom({ ...input, sceneOutlines: [page] }, {
      preparedOutlines: [page], ...sourceOptions, ...recovery.callbacks,
    });
    expect(mocks.ai.mock.calls.filter(([system]) => system.includes('# Slide Content Generator'))).toHaveLength(1);
    expect(mocks.ai.mock.calls.filter(([system]) => system === 'Section teaching narration')).toHaveLength(1);
    expect(mocks.contentInput.mock.calls[0][1]).toMatchObject(sourceOptions);
    expect(mocks.narrationInput.mock.calls[0][0]).toMatchObject(sourceOptions);
    expect(mocks.narrationInput.mock.calls[0][0].sourceAuthoringPageIds).toBeUndefined();
    const firstBodyPrompt = mocks.ai.mock.calls.find(([system]) => system.includes('# Slide Content Generator'))![1];
    expect(firstBodyPrompt).toContain('采用的原始教材');
    expect(firstBodyPrompt).toContain(sourceLabels[2]);
    expect(recovery.checkpoints.size).toBe(0);
    expect(mocks.replan).not.toHaveBeenCalled();
    expect(result.scenes[0].content.type).toBe('slide');
    if (result.scenes[0].content.type === 'slide') {
      expect(JSON.stringify(result.scenes[0].content.canvas.elements)).not.toContain(sourceLabels[2]);
    }
    expect(result.scenes[0].actions?.some((action) => action.type === 'speech' && action.text.includes(sourceLabels[2]))).toBe(true);
  });

  it('reuses source-valid stage caches when only derived source IDs change while retaining the guard for changed original book facts', async () => {
    const { page, sourceOptions } = sourceFixture();
    const store = capacityStageStore();
    const complete = completedPageStore();
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify([{ type: 'text', content: `我们结合一个项目来理解教材建议。${sourceLabels.join('；')}。` }]));
    const original = await generateClassroom({ ...input, sceneOutlines: [page] }, {
      preparedOutlines: [page], ...store.callbacks, ...complete.callbacks, ...sourceOptions,
    });
    const originalNarration = structuredClone(store.stages.get(`${page.id}:narration`));
    expect(originalNarration?.inputFingerprint).toBeTruthy();
    const originalSourceResolver = sourceGrounding.pageOriginalTeachingSources;
    const derivedCatalog = vi.spyOn(sourceGrounding, 'pageOriginalTeachingSources').mockImplementation((current, options) => {
      const sources = originalSourceResolver(current, options);
      return { ...sources, authoritativeAnchors: sources.authoritativeAnchors.map((anchor, index) => ({
        ...anchor, id: `renumbered-source-${index + 101}`,
      })) };
    });
    try {
      mocks.ai.mockClear();
      const resumed = await generateClassroom({ ...input, sceneOutlines: [page] }, {
        preparedOutlines: original.assetContext.outlines, ...store.callbacks, ...complete.callbacks, ...sourceOptions,
        hasSceneContentCheckpoint: () => true,
      });
      expect(derivedCatalog).toHaveBeenCalled();
      expect(mocks.ai).not.toHaveBeenCalled();
      expect(store.stages.get(`${page.id}:narration`)).toEqual(originalNarration);
      expect(resumed.scenes[0].content).toEqual(original.scenes[0].content);
      expect(resumed.scenes[0].actions).toEqual(original.scenes[0].actions);

      const newCondition = '在涉及个人数据的任务中，还需要说明数据隐私保护的必要条件。';
      const evidence = sourceOptions.sourceEvidence;
      const changedEvidence: CourseEvidenceSnapshot = { ...evidence, version: 2, fingerprint: 'original-book-source-v2',
        selections: [{ revisionId: 'book-revision-v2', primary: true, sectionIds: [] }],
        items: evidence.items.map((item) => ({ ...item, content: `${item.content}${newCondition}`,
          source: { ...item.source, revisionId: 'book-revision-v2', revisionVersion: 2,
            quote: `${item.source.quote}${newCondition}` } })),
      };
      mocks.ai.mockResolvedValue(JSON.stringify([{ type: 'text', content: `${sourceLabels.join('；')}。${newCondition}` }]));
      const revised = await generateClassroom({ ...input, sceneOutlines: [page] }, {
        preparedOutlines: resumed.assetContext.outlines, ...store.callbacks, ...complete.callbacks,
        ...sourceOptions, sourceEvidence: changedEvidence, hasSceneContentCheckpoint: () => true,
      });
      expect(mocks.ai).toHaveBeenCalledOnce();
      expect(mocks.ai.mock.calls[0][0]).toBe('Section teaching narration');
      expect(mocks.narrationInput.mock.calls.at(-1)![0].sourceEvidence).toEqual(changedEvidence);
      expect(mocks.narrationInput.mock.calls.at(-1)![0].sourceAuthoringPageIds).toBeUndefined();
      expect(store.stages.get(`${page.id}:narration`)?.inputFingerprint).not.toBe(originalNarration?.inputFingerprint);
      expect(revised.scenes[0].content).toEqual(original.scenes[0].content);
      expect(revised.scenes[0].actions?.some((action) => action.type === 'speech' && action.text.includes(newCondition))).toBe(true);
    } finally {
      derivedCatalog.mockRestore();
    }
  });

  it('restores an audited legacy section input with unchanged page, body and model without rewriting speech or audio', async () => {
    const { page, sourceOptions } = sourceFixture();
    const store = capacityStageStore();
    const complete = completedPageStore();
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify([{ type: 'text', content: `先看这个具体项目。${sourceLabels.join('；')}。这个条件解释了为什么不能直接套用同一任务难度。` }]));
    const original = await generateClassroom({ ...input, sceneOutlines: [page] }, {
      preparedOutlines: [page], ...store.callbacks, ...complete.callbacks, ...sourceOptions,
    });
    const narrationStage = store.stages.get(`${page.id}:narration`)!;
    // The authenticated envelope supplies the exact historical stage hash;
    // it need not be guessed from today's derived authoring metadata.
    const historicalInput = fingerprintGenerationValue({ historicalSectionContext: narrationStage.inputFingerprint });
    narrationStage.inputFingerprint = historicalInput;
    for (const action of complete.pages.get(page.id)!.scene.actions ?? []) {
      if (action.type === 'speech') action.audioUrl = `/preserved-legacy-audio/${action.id}.wav`;
    }
    const before = structuredClone(complete.pages.get(page.id)!.scene.actions);
    const baseline = { scenes: original.scenes, outlines: original.assetContext.outlines,
      narrationInputFingerprints: { [page.lectureSectionId!]: [historicalInput] } };
    mocks.ai.mockClear();
    mocks.narrationInput.mockClear();
    const restored = await generateClassroom({ ...input, sceneOutlines: [page] }, {
      preparedOutlines: original.assetContext.outlines, ...store.callbacks, ...complete.callbacks, ...sourceOptions,
      sourceNarrationBaseline: baseline, hasSceneContentCheckpoint: () => true,
    });
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.narrationInput).not.toHaveBeenCalled();
    expect(mocks.insertionInput).not.toHaveBeenCalled();
    expect(restored.scenes[0].actions).toEqual(before);
    expect(store.stages.get(`${page.id}:narration`)!.payload).toEqual(narrationStage.payload);
    expect(store.stages.get(`${page.id}:narration`)!.inputFingerprint).not.toBe(historicalInput);
  });

  it.each(['outline', 'body', 'model', 'missing-page', 'missing-fingerprint'] as const)(
    'rejects legacy input recovery when its authenticated %s no longer matches the section', async (mismatch) => {
      const { page, sourceOptions } = sourceFixture();
      const store = capacityStageStore();
      mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
        ? JSON.stringify(authoredContent) : JSON.stringify([{ type: 'text', content: sourceLabels.join('；') }]));
      const original = await generateClassroom({ ...input, sceneOutlines: [page] }, {
        preparedOutlines: [page], ...store.callbacks, ...sourceOptions,
      });
      const stage = store.stages.get(`${page.id}:narration`)!;
      const historicalInput = fingerprintGenerationValue({ historicalSectionContext: stage.inputFingerprint });
      stage.inputFingerprint = historicalInput;
      const baseline = { scenes: structuredClone(original.scenes), outlines: structuredClone(original.assetContext.outlines),
        narrationInputFingerprints: { [page.lectureSectionId!]: [historicalInput] } };
      if (mismatch === 'outline') baseline.outlines[0].keyPoints.push('另一项实际教学责任');
      if (mismatch === 'body' && baseline.scenes[0].content.type === 'slide') baseline.scenes[0].content.canvas.elements.pop();
      if (mismatch === 'model') stage.modelFingerprint = 'different-generation-model';
      if (mismatch === 'missing-page') baseline.outlines = [];
      if (mismatch === 'missing-fingerprint') baseline.narrationInputFingerprints[page.lectureSectionId!] = [];
      mocks.ai.mockClear();
      mocks.narrationInput.mockClear();
      await generateClassroom({ ...input, sceneOutlines: [page] }, {
        preparedOutlines: original.assetContext.outlines, ...store.callbacks, ...sourceOptions,
        sourceNarrationBaseline: baseline, hasSceneContentCheckpoint: () => true,
      });
      expect(mocks.ai).toHaveBeenCalledOnce();
      expect(mocks.narrationInput).toHaveBeenCalledOnce();
      expect(mocks.insertionInput).not.toHaveBeenCalled();
      expect(mocks.narrationInput.mock.calls[0][0].sourceAuthoringPageIds).toBeUndefined();
    },
  );

  it('stops on invalid saved source narration without rewriting bodies, speech or another section', async () => {
    const { page, sourceOptions } = sourceFixture();
    const other = { ...capacityPage('other', 'other-section'), order: 1 };
    const store = capacityStageStore();
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify(narration));
    await generateClassroom(input, { preparedOutlines: [page, other], ...store.callbacks });
    const original = structuredClone([...store.stages]);
    mocks.ai.mockClear();
    await expect(generateClassroom(input, { preparedOutlines: [page, other], ...store.callbacks, ...sourceOptions }))
      .rejects.toThrow(/已保存讲稿未通过来源验收/);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.insertionInput).not.toHaveBeenCalled();
    expect([...store.stages]).toEqual(original);
  });

  it('persists a failed first narration and revalidates it on resume without another author call', async () => {
    const { page, sourceOptions } = sourceFixture();
    const store = capacityStageStore();
    const raw = new Map<string, string>();
    const rawCallbacks = {
      onStageAuthoringResponse: (record: { outline: SceneOutline; stage: string; text: string }) => { raw.set(`${record.outline.id}:${record.stage}`, record.text); },
      loadStageAuthoringResponse: (page: SceneOutline, stage: string) => raw.get(`${page.id}:${stage}`) ?? null,
    };
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify(narration));
    await expect(generateClassroom(input, { preparedOutlines: [page], ...store.callbacks, ...rawCallbacks, ...sourceOptions }))
      .rejects.toThrow(/讲稿首稿未通过来源验收/);
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(raw.has(`${page.id}:narration`)).toBe(true);
    expect(store.stages.has(`${page.id}:narration`)).toBe(false);
    const body = structuredClone(store.stages.get(`${page.id}:content`));
    mocks.ai.mockClear();
    await expect(generateClassroom(input, { preparedOutlines: [page], ...store.callbacks, ...rawCallbacks, ...sourceOptions }))
      .rejects.toThrow(/讲稿首稿未通过来源验收/);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(store.stages.get(`${page.id}:content`)).toEqual(body);
  });

  it('stops profile generation on auxiliary persistence failure without silently using defaults', async () => {
    mocks.ai.mockResolvedValue(JSON.stringify({ agents: [{ name: 'Teacher', role: 'teacher', persona: '解释概念' },
      { name: 'Student', role: 'student', persona: '提出问题' }] }));
    const onAuxiliaryAuthoringResponse = vi.fn(() => { throw new Error('aux storage unavailable'); });
    await expect(generateClassroom({ ...input, agentMode: 'generate' }, { preparedOutlines: [outline], onAuxiliaryAuthoringResponse }))
      .rejects.toThrow('辅助阶段 agent-profiles 首稿未完成');
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('does not replace an invalid explicit profile draft with defaults', async () => {
    mocks.ai.mockResolvedValue('{"agents":[]}');
    const onAuxiliaryAuthoringResponse = vi.fn();
    await expect(generateClassroom({ ...input, agentMode: 'generate' }, { preparedOutlines: [outline], onAuxiliaryAuthoringResponse }))
      .rejects.toThrow('Expected at least 2 agents');
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(onAuxiliaryAuthoringResponse).toHaveBeenCalledOnce();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('restores accepted raw agent profiles before authoring any pages', async () => {
    mocks.ai.mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify(narration));
    const onAuxiliaryAuthoringResponse = vi.fn();
    await generateClassroom({ ...input, agentMode: 'generate' }, { preparedOutlines: [outline], onAuxiliaryAuthoringResponse,
      loadAuxiliaryAuthoringState: (identity) => ({ ...identity, attemptsStarted: 1,
        rawResponse: JSON.stringify({ agents: [{ name: 'Teacher', role: 'teacher', persona: '解释概念' },
          { name: 'Student', role: 'student', persona: '提出问题' }] }) }),
    });
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls.some(([system]) => String(system).includes('Generate agent profiles'))).toBe(false);
    expect(onAuxiliaryAuthoringResponse).not.toHaveBeenCalled();
  });

  it.each(['{"elements":[', JSON.stringify(authoredContent)])('preserves truncated raw text and never accepts it or buys another response: %s', async (rawResponse) => {
    const adapter = await vi.importActual<typeof import('./course-generation-ai-call')>('./course-generation-ai-call');
    const llm = await import('../ai/llm');
    const truncated = Object.assign(new Error('stream truncated after output'), {
      code: 'LLM_STREAM_TRUNCATED', isRetryable: false, rawResponse,
    });
    const stream = vi.spyOn(llm, 'callStreamingLLMText').mockRejectedValue(truncated);
    mocks.createAiCall.mockImplementation(adapter.createCourseGenerationAiCall);
    mocks.callContext.mockImplementation(adapter.withCourseGenerationAiCallContext);
    const raw = new Map<string, { text: string; complete?: boolean }>();
    const onStageAuthoringResponse = vi.fn((record: { outline: SceneOutline; stage: string; inputFingerprint: string; text: string; complete?: boolean }) => {
      raw.set(`${record.outline.id}:${record.stage}:${record.inputFingerprint}`, { text: record.text, complete: record.complete });
    });
    const onStageAuthoringValidated = vi.fn();
    const options = { preparedOutlines: [outline], onStageAuthoringResponse, onStageAuthoringValidated,
      loadStageAuthoringResponse: (page: SceneOutline, stage: string, _model: string, fingerprint: string) =>
        raw.get(`${page.id}:${stage}:${fingerprint}`) ?? null };
    try {
      await expect(generateClassroom(input, options)).rejects.toThrow('stream truncated');
      expect(onStageAuthoringResponse).toHaveBeenCalledOnce();
      expect(onStageAuthoringResponse.mock.calls[0]![0].text).toBe(rawResponse);
      expect(onStageAuthoringResponse.mock.calls[0]![0].complete).toBe(false);
      expect(onStageAuthoringValidated).not.toHaveBeenCalled();
      await expect(generateClassroom(input, options)).rejects.toThrow('首稿响应被截断');
      expect(stream).toHaveBeenCalledOnce();
      expect(onStageAuthoringResponse).toHaveBeenCalledOnce();
      expect(onStageAuthoringValidated).not.toHaveBeenCalled();
    } finally { stream.mockRestore(); }
  });

  it('persists a completed adapter response once per stage without a wrapper duplicate', async () => {
    const adapter = await vi.importActual<typeof import('./course-generation-ai-call')>('./course-generation-ai-call');
    const llm = await import('../ai/llm');
    const stream = vi.spyOn(llm, 'callStreamingLLMText')
      .mockResolvedValueOnce(JSON.stringify(authoredContent)).mockResolvedValueOnce(JSON.stringify(narration));
    mocks.createAiCall.mockImplementation(adapter.createCourseGenerationAiCall);
    mocks.callContext.mockImplementation(adapter.withCourseGenerationAiCallContext);
    const onStageAuthoringResponse = vi.fn();
    try {
      await generateClassroom(input, { preparedOutlines: [outline], onStageAuthoringResponse });
      expect(onStageAuthoringResponse).toHaveBeenCalledTimes(2);
      expect(onStageAuthoringResponse.mock.calls.map(([record]) => record.stage)).toEqual(['content', 'actions']);
      expect(onStageAuthoringResponse.mock.calls.every(([record]) => record.complete === true)).toBe(true);
    } finally { stream.mockRestore(); }
  });

  it('stops before parsing when raw-response persistence fails instead of replaying the model', async () => {
    mocks.ai.mockResolvedValue(JSON.stringify(authoredContent));
    const onSceneCompleted = vi.fn();
    const onStageAuthoringValidated = vi.fn();
    await expect(generateClassroom(input, { preparedOutlines: [outline], onSceneCompleted, onStageAuthoringValidated,
      onStageAuthoringResponse: async () => { throw new Error('raw storage unavailable'); },
    })).rejects.toThrow('raw storage unavailable');
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(onSceneCompleted).not.toHaveBeenCalled();
    expect(onStageAuthoringValidated).not.toHaveBeenCalled();
  });

  it('does not classify validation-observer persistence failure as rejected authoring or replay the provider', async () => {
    mocks.ai.mockResolvedValue(JSON.stringify(authoredContent));
    const onStageAuthoringValidated = vi.fn().mockRejectedValue(new Error('validation storage unavailable'));
    await expect(generateClassroom(input, { preparedOutlines: [outline], onStageAuthoringValidated }))
      .rejects.toThrow('validation storage unavailable');
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(onStageAuthoringValidated).toHaveBeenCalledOnce();
    expect(onStageAuthoringValidated.mock.calls[0][0]).toMatchObject({ stage: 'content', accepted: true });
  });

  it('does not revive an old pending source-repair budget into a new model call', async () => {
    const { page, sourceOptions } = sourceFixture();
    const store = capacityStageStore();
    const recovery = sourceCheckpointStore();
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify(narration));
    await generateClassroom(input, { preparedOutlines: [page], ...store.callbacks });
    mocks.ai.mockClear();
    for (let attempt = 0; attempt < 2; attempt += 1) await expect(generateClassroom(input,
      { preparedOutlines: [page], ...store.callbacks, ...sourceOptions, ...recovery.callbacks }))
      .rejects.toThrow(/已保存讲稿未通过来源验收/);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(recovery.checkpoints.get(page.lectureSectionId!)?.status).toBe('infeasible');
  });

  it('rejects a malformed content response after one call while preserving its raw draft', async () => {
    const responses: string[] = [];
    const onStageAuthoringValidated = vi.fn();
    mocks.ai.mockResolvedValue('{"invalid":true}');
    await expect(generateClassroom(input, { preparedOutlines: [outline], onStageAuthoringValidated,
      onStageAuthoringResponse: ({ text }) => { responses.push(text); },
    })).rejects.toThrow(/invalid content/);
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(responses).toEqual(['{"invalid":true}']);
    expect(onStageAuthoringValidated).toHaveBeenCalledOnce();
    expect(onStageAuthoringValidated.mock.calls[0][0]).toMatchObject({ stage: 'content', accepted: false, issues: [expect.stringMatching(/invalid content/)] });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('persists a failed selected placement unchanged and replays its failure with zero extra authoring calls', async () => {
    const page = capacityPage('invalid-native-placement');
    const raw = JSON.stringify({ layoutCandidateId: 'native-text-v1-unknown', elements: [],
      components: [{ kind: 'textBox', placementRef: 'adopted-content-1' }] });
    const saved = new Map<string, string>();
    const onStageAuthoringValidated = vi.fn();
    const callbacks = {
      onStageAuthoringResponse: (record: { outline: SceneOutline; stage: string; text: string }) => {
        saved.set(`${record.outline.id}:${record.stage}`, record.text);
      },
      loadStageAuthoringResponse: (outline: SceneOutline, stage: string) => saved.get(`${outline.id}:${stage}`) ?? null,
    };
    mocks.ai.mockResolvedValue(raw);
    await expect(generateClassroom(input, { preparedOutlines: [page], ...callbacks, onStageAuthoringValidated }))
      .rejects.toThrow(/Native text placement/);
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(saved.get(`${page.id}:content`)).toBe(raw);
    expect(onStageAuthoringValidated).toHaveBeenCalledWith(expect.objectContaining({ stage: 'content', accepted: false }));
    mocks.ai.mockClear();
    await expect(generateClassroom(input, { preparedOutlines: [page], ...callbacks }))
      .rejects.toThrow(/Native text placement/);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('stops on an incorrect source count without insertion or replacement calls', async () => {
    const { page, sourceOptions } = sourceFixture();
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify([{ type: 'text', content: '这里只有两个步骤。' }]));
    await expect(generateClassroom(input, { preparedOutlines: [page], ...sourceOptions })).rejects.toThrow(/来源验收/);
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.insertionInput).not.toHaveBeenCalled();
  });

  it('projects adopted legacy display points locally without a teaching-design model request', async () => {
    const page = capacityPage('legacy-projection');
    const onTeachingSectionCompleted = vi.fn();
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify(narration));
    const result = await generateClassroom(input, { preparedOutlines: [page], onTeachingSectionCompleted });
    expect(result.assetContext.outlines[0].teachingBrief?.teachingPlan?.presentationContent).toEqual(page.keyPoints);
    expect(result.assetContext.outlines[0].teachingBrief?.explanation).toBe(page.teachingBrief?.explanation);
    expect(mocks.ai).toHaveBeenCalledTimes(2);
    expect(mocks.ai.mock.calls[0][0]).toContain('# Slide Content Generator');
    expect(onTeachingSectionCompleted).not.toHaveBeenCalled();
  });

  it('retains completed content when a later compiler capacity diagnosis stops the first pass', async () => {
    const saved = [capacityPage('complete'), { ...capacityPage('overflow'), order: 1 }];
    const store = capacityStageStore();
    mocks.ai.mockResolvedValue(JSON.stringify(authoredContent));
    mocks.contentFailure.mockImplementation((page: SceneOutline) => page.id === 'overflow'
      ? { category: 'section-overload', detail: 'Measured teaching units need extra pages' } : undefined);
    await expect(generateClassroom(input, { preparedOutlines: saved, ...store.callbacks })).rejects.toThrow('Measured teaching units');
    expect(store.stages.has('complete:content')).toBe(true);
    expect(store.stages.has('overflow:content')).toBe(false);
    expect(mocks.replan).not.toHaveBeenCalled();
    expect(mocks.ai).toHaveBeenCalledOnce();
  });

  it('stops at preflight before any page request when a section cannot fit', async () => {
    const page = capacityPage('preflight-overflow');
    page.keyPoints = Array.from({ length: 40 }, (_, index) => `必须保留的条件${index}：依据真实资料完整解释不同学习任务中的观察与推理。`);
    page.teachingBrief = { ...page.teachingBrief!, teachingPlan: { ...page.teachingBrief!.teachingPlan!, presentationContent: page.keyPoints } };
    mocks.replan.mockResolvedValue({ status: 'infeasible', reason: 'No complete measured layout', assessments: [] });
    await expect(generateClassroom(input, { preparedOutlines: [page] })).rejects.toThrow(/首稿容量预检/);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.replan).not.toHaveBeenCalled();
  });

  it('does not execute legacy capacity recovery after an authored compiler failure', async () => {
    const page = capacityPage('legacy-capacity');
    mocks.contentFailure.mockReturnValue({ category: 'page-capacity', detail: 'Indivisible complete teaching unit' });
    const loadSectionCapacityCheckpoint = vi.fn();
    const onSectionCapacityCheckpoint = vi.fn();
    await expect(generateClassroom(input, { preparedOutlines: [page], loadSectionCapacityCheckpoint, onSectionCapacityCheckpoint }))
      .rejects.toThrow('Indivisible complete teaching unit');
    expect(mocks.replan).not.toHaveBeenCalled();
    expect(loadSectionCapacityCheckpoint).not.toHaveBeenCalled();
    expect(onSectionCapacityCheckpoint).not.toHaveBeenCalled();
  });

  it('restores completed legacy content for unchanged prepared pages using exact old progression fingerprints', async () => {
    const prepared = Array.from({ length: 6 }, (_, index) => ({ ...capacityPage(`saved-body-${index}`, `saved-section-${index}`), order: index }));
    const confirmed = prepared.map((page) => ({ ...page, title: `原确认标题 ${page.id}` }));
    const store = capacityStageStore();
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('# Slide Content Generator')) return JSON.stringify(authoredContent);
      throw new Error('interrupt before narration');
    });
    await expect(generateClassroom(input, { preparedOutlines: prepared, ...store.callbacks })).rejects.toThrow('interrupt before narration');
    const legacy = new Map(store.stages);
    expect(legacy.size).toBe(6);
    mocks.ai.mockClear().mockImplementation(async (system: string) => {
      if (system.includes('# Slide Content Generator')) throw new Error('successful content must remain unchanged');
      return JSON.stringify(narration);
    });
    const resumed = await generateClassroom({ ...input, sceneOutlines: confirmed }, { preparedOutlines: prepared, ...store.callbacks });
    expect(resumed.scenes).toHaveLength(6);
    expect(mocks.replan).not.toHaveBeenCalled();
    expect(mocks.ai.mock.calls.some(([system]) => system.includes('# Slide Content Generator'))).toBe(false);
    for (const page of prepared) {
      const old = legacy.get(`${page.id}:content`)!;
      const current = store.stages.get(`${page.id}:content`)!;
      expect(current.outlineFingerprint).toBe(old.outlineFingerprint);
      expect(current.modelFingerprint).toBe(old.modelFingerprint);
      expect(current.payload).toEqual(old.payload);
      expect(current.inputFingerprint).not.toBe(old.inputFingerprint);
    }
  });

  it('does not follow a model page-count hint by commissioning a new page', async () => {
    const page = capacityPage('page-count-hint');
    mocks.contentFailure.mockReturnValue({ category: 'section-overload', requestedPageCount: 99, detail: 'Authored group needs 99 pages' });
    await expect(generateClassroom(input, { preparedOutlines: [page] })).rejects.toThrow('99 pages');
    expect(mocks.contentInput).toHaveBeenCalledOnce();
    expect(mocks.replan).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('runs the source and timing adoption guard before the first content request', async () => {
    const validateReplannedOutlines = vi.fn().mockRejectedValue(new Error('source or timing adoption rejected'));
    await expect(generateClassroom(input, { preparedOutlines: [capacityPage('guarded')], validateReplannedOutlines }))
      .rejects.toThrow('source or timing adoption rejected');
    expect(validateReplannedOutlines).toHaveBeenCalledOnce();
    expect(mocks.ai).not.toHaveBeenCalled();
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

  it('authors a section quiz against the next section first slide and assembles two ordered waits', async () => {
    const first: SceneOutline = { ...outline, id: 'first-teaching', title: '抽样与偏差',
      order: 0, spatialParentId: 'first-teaching', lectureSectionId: 'section-a' };
    const check: SceneOutline = { id: 'section-a-check', type: 'quiz', title: '第一节 · 节末小测',
      description: '检验抽样依据', keyPoints: ['识别抽样偏差'], order: 1,
      lectureSectionId: 'section-a', knowledgePointIds: ['sampling'], quizConfig: { questionCount: 1, difficulty: 'medium', questionTypes: ['single'] }, timingPlan: { studentActivitySec: 80, transitionSec: 3 } as SceneOutline['timingPlan'] };
    const next: SceneOutline = { ...outline, id: 'next-teaching', title: '实验中的对照条件',
      order: 2, spatialParentId: 'next-teaching', lectureSectionId: 'section-b' };
    const savedSlide = (saved: SceneOutline, stageId: string): Scene => ({
      id: `completed-${saved.id}`, stageId, outlineId: saved.id,
      type: 'slide', title: saved.title, order: saved.order,
      content: { type: 'slide', canvas: { id: `canvas-${saved.id}`, viewportSize: 1000,
        viewportRatio: 0.5625, elements: content.elements } },
      actions: [{ id: `speech-${saved.id}`, type: 'speech', text: saved.id === first.id
        ? '抽样方式决定谁有机会进入样本。' : '实验设计首先要控制其他因素。' }],
      createdAt: 1, updatedAt: 1,
    } as unknown as Scene);
    mocks.ai.mockImplementation(async (system: string) => {
      if (system.includes('# Quiz Narration Generator')) return JSON.stringify({ questions: [{ id: 'q1', type: 'single', question: '怎样降低抽样偏差？', options: [{ value: 'a', label: '随机抽取' }, { value: 'b', label: '只问熟人' }, { value: 'c', label: '只看主动答题者' }, { value: 'd', label: '只问同桌' }], answer: 'a', knowledgePointIds: ['sampling'], analysis: '随机抽取让总体成员获得入样机会。' }], phaseNarration: [
        { type: 'text', phase: 'intro', content: '刚才讨论了入样机会，现在独立完成几道题。' },
        { type: 'text', phase: 'review-guidance', content: '解析显示后，请核对推理依据，读完再确认理解。' },
        { type: 'text', phase: 'handoff', content: '入样判断之后，还要看怎样排除其他因素。' },
      ] });
      throw new Error(`Unexpected generation prompt: ${system.slice(0, 80)}`);
    });

    const result = await generateClassroom(input, {
      preparedOutlines: [first, check, next],
      loadSceneCheckpoint: (saved, _index, stageId) => saved.type === 'slide' ? savedSlide(saved, stageId) : null,

    });

    const quizPrompt = mocks.ai.mock.calls.find(([system]) => system.includes('# Quiz Narration Generator'))?.[1] as string;
    expect(quizPrompt).toContain('抽样方式决定谁有机会进入样本。');
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(result.scenes.find((scene) => scene.outlineId === check.id)?.content).toMatchObject({ questions: [{ analysis: '随机抽取让总体成员获得入样机会。' }] });
    expect(quizPrompt).toContain('实验设计首先要控制其他因素。');
    const quizActions = result.scenes.find((scene) => scene.outlineId === check.id)?.actions ?? [];
    expect(quizActions.map((action) => action.type === 'speech'
      ? action.quizNarrationPhase || ('activityPausePurpose' in action ? action.activityPausePurpose : 'transition')
      : action.type)).toEqual([
      'intro', 'quiz-submit', 'review-guidance', 'quiz', 'handoff', 'transition',
    ]);
    expect(mocks.ai).toHaveBeenCalledTimes(1);
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

  it('requires adopted teaching design before authoring a missing knowledge page (1)', async () => {
    const page: SceneOutline = { ...outline, id: 'missing-design-0', generationPurpose: 'knowledge-teaching', lectureSectionId: 'missing' };
    await expect(generateClassroom(input, { preparedOutlines: [page] })).rejects.toThrow(/缺少已确认的完整教学设计/);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
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
    expect(mocks.narrationInput.mock.calls.at(-1)![0].sourceAuthoringPageIds).toBeUndefined();
    expect(result.scenes[0]?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'speech',
        text: expect.stringContaining('独立来源'),
      }),
    ]));
  });

  it('requires adopted teaching design before authoring a missing knowledge page (2)', async () => {
    const page: SceneOutline = { ...outline, id: 'missing-design-1', generationPurpose: 'knowledge-teaching', lectureSectionId: 'missing' };
    await expect(generateClassroom(input, { preparedOutlines: [page] })).rejects.toThrow(/缺少已确认的完整教学设计/);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('requires adopted teaching design before authoring a missing knowledge page (3)', async () => {
    const page: SceneOutline = { ...outline, id: 'missing-design-2', generationPurpose: 'knowledge-teaching', lectureSectionId: 'missing' };
    await expect(generateClassroom(input, { preparedOutlines: [page] })).rejects.toThrow(/缺少已确认的完整教学设计/);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
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

  it('keeps an already completed page checkpoint and stops at the next malformed first draft', async () => {
    mocks.ai
      .mockResolvedValueOnce(JSON.stringify(authoredContent))
      .mockResolvedValueOnce(JSON.stringify(narration))
      .mockResolvedValueOnce('{"invalid":true}')
      .mockResolvedValueOnce('{"invalid":true}');
    const onSceneCompleted = vi.fn();
    await expect(generateClassroom(input, { preparedOutlines: [outline, { ...outline, id: 'invalid-page', order: 1 }], onSceneCompleted })).rejects.toThrow();
    expect(mocks.ai).toHaveBeenCalledTimes(3);
    const failedPagePrompts = mocks.ai.mock.calls.filter(([system]) => system.includes('# Slide Content Generator')).slice(1);
    expect(failedPagePrompts).toHaveLength(1);
    expect(failedPagePrompts[0]?.[1]).not.toContain('上一次页面草稿的自动校验结果');
    expect(onSceneCompleted).toHaveBeenCalledOnce();
    expect(onSceneCompleted.mock.calls[0][0].id).toBe(outline.id);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('preserves a collision draft and stops without an automatic layout rewrite', async () => {
    mocks.ai.mockResolvedValue(JSON.stringify(authoredContent));
    mocks.layout.mockResolvedValue({ status: 'checked', findings: [{ id: 'body:collision-text', title: '文字重叠', evidence: '同一行相互覆盖' }] });
    const onStageAuthoringResponse = vi.fn();
    const onSceneStageCompleted = vi.fn();
    await expect(generateClassroom(input, { preparedOutlines: [outline], onStageAuthoringResponse, onSceneStageCompleted }))
      .rejects.toThrow(/文字重叠/);
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(onStageAuthoringResponse).toHaveBeenCalledOnce();
    expect(onSceneStageCompleted).not.toHaveBeenCalled();
  });

  it('rejects an authored continuation instead of silently changing the confirmed page plan', async () => {
    mocks.ai.mockResolvedValue(JSON.stringify(authoredContent));
    mocks.compiledContinuation.mockImplementation((generated: GeneratedSlideContent) => ({ ...generated, continuationPages: [generated] }));
    const onOutlinesPrepared = vi.fn();
    await expect(generateClassroom(input, { preparedOutlines: [outline], onOutlinesPrepared })).rejects.toThrow(/不自动拆页/);
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(onOutlinesPrepared).toHaveBeenCalledOnce();
    expect(mocks.replan).not.toHaveBeenCalled();
  });

  it('stops at the first off-canvas native draft without pagination', async () => {
    mocks.layout.mockResolvedValueOnce({ status: 'checked', issues: ['画布溢出'],
      findings: [{ id: `${outline.id}:overflow:bottom-text`, title: '文字超出画布',
        evidence: '文本框排到了页外', elementId: 'bottom-text' }] });
    mocks.layout.mockResolvedValueOnce({ status: 'checked', issues: ['画布溢出'],
      findings: [{ id: `${outline.id}:overflow:bottom-text`, title: '文字超出画布',
        evidence: '重排后坐标仍在页外', elementId: 'bottom-text' }] });
    mocks.ai.mockImplementation(async (system: string) => system.includes('# Slide Content Generator')
      ? JSON.stringify(authoredContent) : JSON.stringify(narration));
    await expect(generateClassroom(input, { preparedOutlines: [outline] }))
      .rejects.toThrow(/文字超出画布/);
    const calls = mocks.ai.mock.calls.filter(([system]) => system.includes('# Slide Content Generator'));
    expect(calls).toHaveLength(1);
    expect(calls.every(([system]) => !system.includes('The compiler chooses balanced page breaks'))).toBe(true);
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

  it('replays saved raw content through the same validators without calling the provider', async () => {
    mocks.ai.mockResolvedValue(JSON.stringify(narration));
    const onStageAuthoringResponse = vi.fn();
    await generateClassroom(input, { preparedOutlines: [outline], onStageAuthoringResponse,
      loadStageAuthoringResponse: (_page, stage) => stage === 'content' ? JSON.stringify(authoredContent) : null,
    });
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(mocks.ai.mock.calls[0][0]).not.toContain('# Slide Content Generator');
    expect(onStageAuthoringResponse).toHaveBeenCalledOnce();
    expect(onStageAuthoringResponse.mock.calls[0][0].stage).toBe('actions');
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
      if (system.includes('# Slide Content Generator')) return JSON.stringify({ ...authoredContent,
        elements: authoredContent.elements.map((element) => element.id === 'native-evidence'
          ? { ...element, contentRef: 'adopted-content-1' } : element) });
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
