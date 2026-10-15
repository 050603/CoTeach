import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '../types/generation';
import type { Scene } from '../types/stage';
import { fingerprintSceneOutline, restoreSceneCheckpoint, restoreSceneStageCheckpoint,
  type PageCheckpointSnapshot, type SceneStageCheckpointSnapshot } from '@/lib/course-generation/page-checkpoints';
import { restoreAuthoringResponse, type AuthoringResponseCheckpoint } from '@/lib/course-generation/authoring-checkpoints';

const mocks = vi.hoisted(() => ({ ai: vi.fn(), persist: vi.fn(),
  storedPolicy: null as null | 'v23' | 'v22' | 'v21',
}));
// Issue old production fingerprints, then resume under the actual current
// policy. Storage uses the real outline, model and input identity checks.
vi.mock('@/lib/course-generation/page-checkpoints', async (original) => {
  const actual = await original<typeof import('@/lib/course-generation/page-checkpoints')>();
  return { ...actual, fingerprintGenerationValue: (value: unknown) => {
    if (mocks.storedPolicy && value && typeof value === 'object'
      && 'pipeline' in value && value.pipeline === 'adaptive-course-page-v4') {
      if (mocks.storedPolicy === 'v23') return actual.fingerprintGenerationValue({ ...value,
        quizPolicy: 'quizPolicy' in value && value.quizPolicy === null
          ? null : 'grounded-section-quiz-v23-misconception-first-diagnostic-items',
      });
      return actual.fingerprintGenerationValue({ ...value,
        quizPolicy: 'quizPolicy' in value && value.quizPolicy === null ? null : mocks.storedPolicy === 'v22'
          ? 'grounded-section-quiz-v22-source-relations-and-explicit-premises'
          : 'grounded-section-quiz-v21-reference-actions-and-source-answer-catalog',
        teachingNarrationPolicy: mocks.storedPolicy === 'v22'
          ? 'section-continuous-narration-v39-bound-contributions-and-source-relations'
          : 'section-continuous-narration-v38-source-excerpt-duties-and-reference-actions',
        assessmentPolicy: 'predeclared-understanding-standard-v4-reference-actions',
      });
    }
    return actual.fingerprintGenerationValue(value);
  } };
});
vi.mock('./resolve-model', () => ({ resolveModel: async () => ({
  model: {}, modelInfo: { capabilities: { vision: false }, outputWindow: 12000 },
  modelString: 'test-model', providerId: 'openai', apiKey: 'test',
}) }));
vi.mock('./course-generation-ai-call', () => ({
  createCourseGenerationAiCall: () => mocks.ai,
  withCourseGenerationAiCallContext: (call: unknown) => call,
}));
vi.mock('./classroom-media-readiness', () => ({ assertRequestedClassroomMediaProviders: () => {} }));
vi.mock('./classroom-media-generation', () => ({ resolveServerTtsTimingSelection: () => ({
  providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Serena', language: 'zh-CN', speed: 1,
}) }));
vi.mock('./classroom-storage', () => ({ persistClassroom: mocks.persist }));
vi.mock('./provider-config', async (original) => ({
  ...await original<typeof import('./provider-config')>(), getClassroomSceneConcurrency: () => 1,
}));

import { generateClassroom, type GenerateClassroomOptions } from './classroom-generation';
import { closeSpatialMeasurementBrowser } from '../generation/slide-spatial-measurement';
afterAll(async () => { await closeSpatialMeasurementBrowser(); });

const page: SceneOutline = {
  id: 'section-check', type: 'quiz', title: '证据与结论小测', description: '区分来源数量与证据独立性',
  keyPoints: ['同源转载不能提供多份独立证据'], order: 1, lectureSectionId: 'evidence-section',
  knowledgePointIds: ['evidence'], quizConfig: { questionCount: 1, difficulty: 'medium', questionTypes: ['single'] },
};
const input = { requirement: '从当前确认大纲生成节末小测', agentMode: 'default' as const,
  enableImageGeneration: false, enableVideoGeneration: false, enableTTS: false };
const teaching: SceneOutline = { id: 'evidence-teaching', type: 'slide', title: '证据独立性', description: '解释转载与独立来源',
  keyPoints: ['同源转载不能提供多份独立证据'], order: 0, lectureSectionId: page.lectureSectionId,
  knowledgePointIds: ['evidence'], targetDurationSec: 31, estimatedDuration: 31 };
const preparedOutlines = () => structuredClone([teaching, page]);
function savedTeachingScene(outline: SceneOutline, stageId: string): Scene {
  return { id: 'paid-teaching-scene', outlineId: outline.id, stageId, type: 'slide', title: outline.title, order: outline.order,
    content: { type: 'slide', canvas: { id: 'paid-canvas', viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: [], fontColor: '#000000', fontName: 'Arial' },
      elements: [{ id: 'evidence-label', type: 'text', left: 60, top: 100, width: 880, height: 80,
        defaultFontName: 'Arial', defaultColor: '#000000', rotate: 0,
        content: '<p>同源转载不能提供多份独立证据。</p>' }] } },
    actions: [{ id: 'paid-teaching-speech', type: 'speech',
      text: '多家媒体转发同一份研究仍然共用一个原始来源。同源转载不能提供多份独立证据；核验还需要独立观察。',
      audioUrl: '/preserved-teaching.wav' }], createdAt: 1, updatedAt: 1 };
}
function quizScene(scenes: Scene[]): Scene {
  const scene = scenes.find((candidate) => candidate.outlineId === page.id);
  if (!scene) throw new Error('Expected the section quiz');
  return scene;
}

function quizResponse(id: string) {
  return JSON.stringify({ questions: [{ id, type: 'single', question: '三家媒体转发同一研究数据，下一步核验应优先做什么？',
    options: [{ value: 'a', label: '比较三家媒体的发布时间' }, { value: 'b', label: '查找研究以外的独立观察' },
      { value: 'c', label: '核对三家媒体是否使用同一表述' }, { value: 'd', label: '检查研究报告所列的图表数目' }],
    answer: 'b', analysis: '三家媒体共享同一份原始研究，不增加独立证据。独立观察才能用于交叉核验。',
    knowledgePointIds: ['evidence'],
  }], phaseNarration: [
    { type: 'text', phase: 'intro', content: '请判断以下证据核验情境。' },
    { type: 'text', phase: 'review-guidance', content: '提交后，请核对来源与证据独立性的区别。' },
    { type: 'text', phase: 'handoff', content: '请带着证据范围的判断结束本节。' },
  ] });
}

function checkpointStore() {
  const pages = new Map<string, PageCheckpointSnapshot>();
  const stages = new Map<string, SceneStageCheckpointSnapshot>();
  const responses = new Map<string, AuthoringResponseCheckpoint>();
  const callbacks: GenerateClassroomOptions = {
    onSceneCompleted: (outline, scene, _index, modelFingerprint, inputFingerprint) => {
      pages.set(outline.id, structuredClone({ pageKey: outline.id, outlineFingerprint: fingerprintSceneOutline(outline),
        scene, modelFingerprint, inputFingerprint }));
    },
    loadSceneCheckpoint: (outline, _index, stageId, modelFingerprint, inputFingerprint) => outline.type === 'slide'
      ? savedTeachingScene(outline, stageId)
      : restoreSceneCheckpoint(outline, pages.get(outline.id), stageId, modelFingerprint, inputFingerprint),
    onSceneStageCompleted: (outline, stage, payload, modelFingerprint, inputFingerprint) => {
      stages.set(`${outline.id}:${stage}`, structuredClone({ schemaVersion: 1, pageKey: outline.id, stage,
        outlineFingerprint: fingerprintSceneOutline(outline), payload, modelFingerprint, inputFingerprint }));
    },
    loadSceneStageCheckpoint: (outline, stage, modelFingerprint, inputFingerprint) => restoreSceneStageCheckpoint({
      outline, stage, modelFingerprint, inputFingerprint, checkpoint: stages.get(`${outline.id}:${stage}`),
    }),
    onStageAuthoringResponse: (record) => {
      responses.set(`${record.outline.id}:${record.stage}`, {
        schemaVersion: 1, pageKey: record.outline.id, stage: record.stage,
        outlineFingerprint: fingerprintSceneOutline(record.outline), modelFingerprint: record.modelFingerprint,
        inputFingerprint: record.inputFingerprint, text: record.text, complete: record.complete, source: record.source,
        systemCharacters: record.system.length, promptCharacters: record.prompt.length,
      });
    },
    loadStageAuthoringResponse: (outline, stage, modelFingerprint, inputFingerprint) => restoreAuthoringResponse({
      outline, stage, modelFingerprint, inputFingerprint, checkpoint: responses.get(`${outline.id}:${stage}`),
    }),
  };
  return { pages, stages, responses, callbacks };
}

function questions(scene: Scene) {
  if (scene.content.type !== 'quiz') throw new Error('Expected a quiz scene');
  return scene.content.questions;
}

describe('quiz policy checkpoint boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedPolicy = null;
    mocks.persist.mockImplementation(async (classroom) => classroom);
  });

  it.each(['page', 'stages', 'raw', 'trial-page', 'trial-stages', 'trial-raw'] as const)(
    'authors fresh questions instead of migrating an older %s quiz checkpoint', async (recovery) => {
      for (const policy of ['v23', 'v22', 'v21'] as const) {
        const store = checkpointStore();
        mocks.storedPolicy = policy;
        mocks.ai.mockResolvedValue(quizResponse(`old-${policy}`));
        const old = await generateClassroom(input, { preparedOutlines: preparedOutlines(), ...store.callbacks });
        expect(questions(quizScene(old.scenes))[0].id).toBe(`old-${policy}`);
        if (recovery.endsWith('stages') || recovery.endsWith('raw')) store.pages.clear();
        if (recovery.endsWith('raw')) store.stages.clear();
        mocks.storedPolicy = null;
        mocks.ai.mockClear();
        mocks.ai.mockResolvedValue(quizResponse('fresh-current-policy'));
        const fresh = await generateClassroom(input, { preparedOutlines: preparedOutlines(), ...store.callbacks,
          ...(recovery.startsWith('trial') ? { completedTestLesson: {
            target: { sectionId: page.lectureSectionId!, sectionTitle: '已完成试课',
              sceneOutlineIds: [teaching.id, page.id], durationSeconds: 60 },
            outlines: old.assetContext.outlines, progression: old.assetContext.narrationProgression,
          } } : {}),
        });
        expect(mocks.ai).toHaveBeenCalledOnce();
        expect(questions(quizScene(fresh.scenes))[0].id).toBe('fresh-current-policy');
        expect(fresh.scenes[0].actions).toEqual(old.scenes[0].actions);
      }
    },
  );

  it.each(['page', 'stages', 'raw'] as const)('resumes a current-policy %s checkpoint without another model call', async (recovery) => {
    const store = checkpointStore();
    mocks.ai.mockResolvedValue(quizResponse('paid-current-policy'));
    const first = await generateClassroom(input, { preparedOutlines: preparedOutlines(), ...store.callbacks });
    if (recovery !== 'page') store.pages.clear();
    if (recovery === 'raw') store.stages.clear();
    mocks.ai.mockClear();
    mocks.ai.mockRejectedValue(new Error('current-policy quiz should be reused'));
    const resumed = await generateClassroom(input, { preparedOutlines: preparedOutlines(), ...store.callbacks });
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(questions(quizScene(resumed.scenes))).toEqual(questions(quizScene(first.scenes)));
  });

  it('records missing authoring evidence as diagnostics and completes after one model call', async () => {
    mocks.ai.mockResolvedValue(quizResponse('usable-first-draft'));
    const store = checkpointStore();
    const result = await generateClassroom(input, { preparedOutlines: preparedOutlines(), ...store.callbacks });
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(questions(quizScene(result.scenes))[0].id).toBe('usable-first-draft');
    expect(result.qualityReport).toMatchObject({ status: 'not-checked', ok: true });
    expect(result.qualityReport.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('assessmentEvidence'), expect.stringContaining('optionReasoning'),
    ]));
    expect(quizScene(result.scenes).content).not.toHaveProperty('qualityDiagnostics');
  });
});
