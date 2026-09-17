import { nanoid } from 'nanoid';
import {
  createCourseGenerationAiCall,
  withCourseGenerationAiCallContext,
} from './course-generation-ai-call';
import { prepareVideoTimingRequests } from './video-timing-plan';
import { allocateTeachingStageTiming } from './teaching-stage-timing-plan';
import type { VideoProviderId } from '@openmaic/lib/media/types';
import { createStageAPI } from '@openmaic/lib/api/stage-api';
import type { StageStore } from '@openmaic/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  normalizeSceneOutlinesForDuration,
  enforcePblOutlineContract,
  generateSceneOutlinesFromRequirements,
} from '@openmaic/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@openmaic/lib/generation/scene-generator';
import type { AICallFn } from '@openmaic/lib/generation/pipeline-types';
import type { AgentInfo } from '@openmaic/lib/generation/pipeline-types';
import { getDefaultAgents } from '@openmaic/lib/orchestration/registry/store';
import { createLogger } from '@openmaic/lib/logger';
import { isProviderKeyRequired } from '@openmaic/lib/ai/providers';
import { resolveClassroomWebSearchConfig } from '@openmaic/lib/server/web-search-config';
import { resolveModel } from '@openmaic/lib/server/resolve-model';
import { resolveVocationalActive } from '@openmaic/lib/config/feature-flags';
import { buildSearchQuery } from '@openmaic/lib/server/search-query-builder';
import { formatSearchResultsAsContext, searchWeb } from '@openmaic/lib/web-search';
import type { BaiduSubSources, WebSearchProviderId } from '@openmaic/lib/web-search/types';
import { persistClassroom } from '@openmaic/lib/server/classroom-storage';
import {
  resolveServerTtsTimingSelection,
  type ServerTtsTimingSelection,
} from '@openmaic/lib/server/classroom-media-generation';
import {
  buildTtsTimingPlan,
} from '@openmaic/lib/audio/tts-timing';
import {
  planPblPageTiming,
  type PblActivityContentType,
  type PblActivityTimingInput,
  type PblInteractionType,
} from '@/lib/pbl-time-estimation';
import {
  contextualizeGenerationError,
  throwIfAborted,
} from '@openmaic/lib/generation/generation-retry';
import { mapWithConcurrencySettledOnError } from '@openmaic/lib/utils/concurrency';
import {
  getClassroomSceneConcurrency,
  getServerVideoProviders,
} from '@openmaic/lib/server/provider-config';
import { assertRequestedClassroomMediaProviders } from '@openmaic/lib/server/classroom-media-readiness';
import {
  resolveLlmRequestTimeoutMs,
  resolveLlmStreamMaxDurationMs,
} from '@/lib/llm/request-policy';
import { buildVideoManifestFromOutlines } from '@openmaic/lib/media/video-manifest';
import { buildNarrationContext } from '@openmaic/lib/generation/narration-continuity';
import { findMissingRequiredTeachingTools } from '@openmaic/lib/generation/teaching-tool-plan';
import { assertCompleteSceneGeneration } from '@openmaic/lib/generation/generation-completeness';
import {
  auditAndRepairGeneratedCourse,
  type CourseQualityReport,
} from '@openmaic/lib/generation/course-quality';
import {
  auditAndRepairSlideOnce,
  auditSlideDensity,
  auditSlideLayout,
  slideKnowledgeCoverage,
} from '@openmaic/lib/generation/slide-layout-audit';
import {
  auditCourseVisualConsistency,
} from '@openmaic/lib/generation/course-visual-theme';
import { OPENMAIC_GENERATION_BASELINE } from '@openmaic/lib/generation/openmaic-baseline';
import {
  auditNarrationLanguage,
  narrationLanguageRepairDirective,
  resolveCourseLanguagePolicy,
} from '@openmaic/lib/generation/course-language';
import {
  enhanceTeachingBriefs,
  hasCompleteTeachingBrief,
  TEACHING_ENHANCEMENT_VERSION,
} from '@openmaic/lib/generation/teaching-enhancement';
import {
  naturalizeKnowledgeNarration,
  NATURAL_NARRATION_VERSION,
} from '@openmaic/lib/generation/narration-style';
import type {
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  GeneratedQuizContent,
  GeneratedSlideContent,
  SceneOutline,
  UserRequirements,
} from '@openmaic/lib/types/generation';
import { validatePblKnowledgeAlignment } from '@/lib/pbl-outline-validation';
import type { Scene, Stage } from '@openmaic/lib/types/stage';
import type { Action } from '@openmaic/lib/types/action';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@openmaic/lib/constants/agent-defaults';
import {
  fingerprintGenerationValue,
  type SceneGenerationCheckpointStage,
} from '@/lib/course-generation/page-checkpoints';

const log = createLogger('Classroom');
type GeneratedSceneContent = GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent;
/** Page orchestration never retries a completed model response. Requests own fault retries. */
export function contentRetryBudget(_type: SceneOutline['type']): number { return 0; }

export interface GenerateClassroomInput {
  /** Exact teacher-selected LLM locked when the generation job is created. */
  generationModelString?: string;
  teachingSourceContext?: string;
  requirement: string;
  generationMode?: UserRequirements['generationMode'];
  pblProfile?: UserRequirements['pblProfile'];
  pblTeachingActivities?: UserRequirements['pblTeachingActivities'];
  pblActivityCatalog?: UserRequirements['pblActivityCatalog'];
  knowledgePoints?: Array<{ id: string; name?: string }>;
  teachingConstraints?: UserRequirements['teachingConstraints'];
  courseTitle?: string;
  languageDirective?: string;
  sceneOutlines?: SceneOutline[];
  pdfContent?: { text: string; images: string[] };
  enableWebSearch?: boolean;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  baiduSubSources?: BaiduSubSources;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
  ttsLanguage?: string;
  agentMode?: 'default' | 'generate';
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
  activePages?: Array<{
    index: number;
    title: string;
    stage: SceneGenerationCheckpointStage | 'restoring' | 'assembling';
    startedAt: number;
    queueMs?: number;
    requestStartedAt?: number;
    executionMs?: number;
    retryCount?: number;
    lastOutputAt?: number;
  }>;
  stage?: SceneGenerationCheckpointStage | 'restoring' | 'assembling';
}

export function completedSceneGenerationProgress(completed: number, total: number): number {
  return Math.min(90, 30 + Math.floor((completed / Math.max(total, 1)) * 60));
}

export interface GenerateClassroomResult {
  id: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
  qualityReport: CourseQualityReport;
  /** Server-only context consumed by the post-response media task. */
  assetContext: {
    outlines: SceneOutline[];
    enableImageGeneration: boolean;
    enableVideoGeneration: boolean;
    enableTTS: boolean;
    isPblCourse: boolean;
    ttsTimingSelection: ServerTtsTimingSelection;
  };
}

export interface GenerateClassroomOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  /** Final normalized/media-planned/timed outlines from an interrupted run. */
  preparedOutlines?: SceneOutline[];
  /** Persist final outlines before the first page starts. */
  onOutlinesPrepared?: (outlines: SceneOutline[]) => Promise<void> | void;
  loadTeachingSectionCheckpoint?: (
    sectionKey: string,
    inputFingerprint: string,
    modelFingerprint: string,
  ) => Promise<Array<[string, unknown]> | null> | Array<[string, unknown]> | null;
  onTeachingSectionCompleted?: (
    sectionKey: string,
    inputFingerprint: string,
    modelFingerprint: string,
    briefs: Array<[string, unknown]>,
  ) => Promise<void> | void;
  /** Restore an exact-fingerprint completed page, if one exists. */
  loadSceneCheckpoint?: (
    outline: SceneOutline,
    index: number,
    stageId: string,
    modelFingerprint: string,
    inputFingerprint: string,
  ) => Promise<Scene | null> | Scene | null;
  /** Persist only a fully assembled page, without a second content or timing pass. */
  onSceneCompleted?: (
    outline: SceneOutline,
    scene: Scene,
    index: number,
    modelFingerprint: string,
    inputFingerprint: string,
  ) => Promise<void> | void;
  /** Restore a validated partial page without repeating successful model work. */
  loadSceneStageCheckpoint?: (
    outline: SceneOutline,
    stage: SceneGenerationCheckpointStage,
    modelFingerprint: string,
    inputFingerprint?: string,
  ) => Promise<unknown | null> | unknown | null;
  /** Persist content, review, actions and narration as independent stages. */
  onSceneStageCompleted?: (
    outline: SceneOutline,
    stage: SceneGenerationCheckpointStage,
    payload: unknown,
    modelFingerprint: string,
    inputFingerprint?: string,
  ) => Promise<void> | void;
  /** Persist attempts before transport starts so restarts cannot reset retries. */
  loadSceneStageAttemptCount?: (
    outline: SceneOutline,
    stage: SceneGenerationCheckpointStage,
    modelFingerprint: string,
    inputFingerprint?: string,
  ) => Promise<number> | number;
  onSceneStageAttempt?: (
    outline: SceneOutline,
    stage: SceneGenerationCheckpointStage,
    attemptsStarted: number,
    modelFingerprint: string,
    inputFingerprint?: string,
  ) => Promise<void> | void;
}

function isGeneratedSceneContent(value: unknown, type: SceneOutline['type']): value is GeneratedSceneContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (type === 'slide') return Array.isArray(record.elements);
  if (type === 'quiz') return Array.isArray(record.questions);
  if (type === 'interactive') return typeof record.html === 'string';
  return Boolean(record.projectV2 && typeof record.projectV2 === 'object');
}

function isActionList(value: unknown): value is Action[] {
  return Array.isArray(value) && value.every((item) =>
    Boolean(item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string'),
  );
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

const SCENE_OUTLINE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

export function normalizeSceneOutlinesForGeneration(outlines?: SceneOutline[]): SceneOutline[] {
  if (!Array.isArray(outlines)) return [];
  return outlines.map((outline, index) => {
    const raw = outline as SceneOutline & Record<string, unknown>;
    const type = SCENE_OUTLINE_TYPES.has(raw.type) ? raw.type : 'slide';
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `Scene ${index + 1}`;
    return {
      ...raw,
      id: typeof raw.id === 'string' && raw.id ? raw.id : `scene-${index + 1}`,
      type: type as SceneOutline['type'],
      title,
      description:
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim()
          : title,
      keyPoints: Array.isArray(raw.keyPoints)
        ? raw.keyPoints.filter((x): x is string => typeof x === 'string')
        : [],
      estimatedDuration:
        typeof raw.estimatedDuration === 'number' ? raw.estimatedDuration : 300,
      parentActivityId:
        typeof raw.parentActivityId === 'string' && raw.parentActivityId.trim()
          ? raw.parentActivityId.trim()
          : typeof raw.activityId === 'string' && raw.activityId.trim()
            ? raw.activityId.trim()
            : undefined,
      detailKind:
        typeof raw.detailKind === 'string'
          ? (raw.detailKind as SceneOutline['detailKind'])
          : undefined,
      knowledgePointIds: Array.isArray(raw.knowledgePointIds)
        ? raw.knowledgePointIds.filter(
            (x): x is string => typeof x === 'string' && Boolean(x.trim()),
          )
        : [],
      targetDurationSec:
        typeof raw.targetDurationSec === 'number' && Number.isFinite(raw.targetDurationSec)
          ? Math.max(0, Math.round(raw.targetDurationSec))
          : undefined,
      ttsPolicy:
        raw.ttsPolicy === 'none' || raw.ttsPolicy === 'target-duration'
          ? raw.ttsPolicy
          : undefined,
      order: index,
    };
  });
}

function inferOutlineContentType(outline: SceneOutline): PblActivityContentType {
  if (outline.type === 'quiz' || outline.quizConfig) return 'quiz';
  if (outline.type === 'interactive') {
    if (outline.widgetType === 'code') return 'technical-explanation';
    if (outline.widgetType === 'diagram') return 'technical-explanation';
    return 'interaction';
  }
  const text = `${outline.title} ${outline.description} ${(outline.keyPoints ?? []).join(' ')}`.toLowerCase();
  if (/case|案例|情境|证据|判断/.test(text)) return 'case-analysis';
  if (/code|technical|技术|代码|编程|步骤|实现/.test(text)) return 'technical-explanation';
  if (outline.detailKind === 'reflection-transfer') return 'reflection';
  return 'theory';
}

function inferOutlineInteraction(outline: SceneOutline): PblActivityTimingInput['interaction'] {
  if (outline.type !== 'interactive') return undefined;
  const widget = outline.widgetOutline && typeof outline.widgetOutline === 'object'
    ? outline.widgetOutline as Record<string, unknown>
    : undefined;
  const widgetType = outline.widgetType;
  const type: PblInteractionType = widgetType === 'code'
    ? 'code'
    : widgetType === 'diagram'
      ? 'diagram'
      : widgetType === 'game'
        ? 'game'
        : widgetType === 'simulation'
          ? 'simulation'
          : 'custom';
  const stepCount = Array.isArray(widget?.steps)
    ? widget.steps.length
    : Array.isArray(widget?.interactions)
      ? widget.interactions.length
      : 1;
  return { type, stepCount, difficulty: 'standard' };
}

function inferOutlineQuiz(outline: SceneOutline): PblActivityTimingInput['quiz'] {
  if (outline.type !== 'quiz' && !outline.quizConfig) return undefined;
  const config = outline.quizConfig;
  return {
    questionCount: Math.max(1, Math.round(config?.questionCount ?? 3)),
    questionTypes: config?.questionTypes,
    difficulty: config?.difficulty === 'hard' ? 'advanced' : config?.difficulty === 'easy' ? 'introductory' : 'standard',
  };
}

/** Attach fresh model-specific timing plans immediately before scene generation. */
export function attachTtsTimingPlans(
  outlines: SceneOutline[],
  selection: ServerTtsTimingSelection,
  videoProviderId?: VideoProviderId,
): SceneOutline[] {
  const selectedVideoProvider = videoProviderId ?? (outlines.some((outline) =>
    outline.mediaGenerations?.some((request) => request.type === 'video'))
    ? Object.keys(getServerVideoProviders())[0] as VideoProviderId | undefined : undefined);
  const planned = outlines.map((sourceOutline) => {
    const { outline, videoSec } = prepareVideoTimingRequests(sourceOutline, selectedVideoProvider);
    const activityTargetSec = Math.max(
      1,
      Math.round(outline.targetDurationSec ?? outline.estimatedDuration ?? 60),
    );
    if (videoSec >= activityTargetSec) {
      throw Object.assign(new Error(`视频前置时长计算失败：${outline.id} 视频占用 ${videoSec} 秒，页面总预算仅 ${activityTargetSec} 秒，没有讲解或活动余量`), { isRetryable: false });
    }
    if (outline.audience === 'teacher' || outline.ttsPolicy === 'none') {
      return { ...outline, timingPlan: undefined };
    }
    const contentType = inferOutlineContentType(outline);
    const interaction = inferOutlineInteraction(outline);
    const quiz = inferOutlineQuiz(outline);
    const pageTiming = planPblPageTiming({
      activityTargetSec: activityTargetSec - videoSec,
      pageKind: outline.type === 'quiz'
        ? 'quiz'
        : outline.type === 'interactive'
          ? 'interactive'
          : 'slide',
      contentType,
      interaction,
      quiz,
    });
    return {
      ...outline,
      timingPlan: buildTtsTimingPlan({
        targetDurationSec: pageTiming.narrationSec,
        activityTargetDurationSec: activityTargetSec,
        videoSec,
        providerId: selection.providerId,
        modelId: selection.modelId,
        voiceId: selection.voiceId,
        // Course audio is generated at the provider's natural rate. Duration
        // is controlled by content and activity budgets, never rate fitting.
        speed: 1,
        naturalSpeedLocked: true,
        language: selection.language,
        contentType,
        pageKind: pageTiming.pageKind,
        readingThinkingSec: pageTiming.readingThinkingSec,
        operationSec: pageTiming.operationSec,
        studentActivitySec: pageTiming.studentActivitySec,
        feedbackSec: pageTiming.feedbackSec,
        transitionSec: pageTiming.transitionSec,
        taskComplexity: pageTiming.taskComplexity,
        recommendedStudentActivitySec: pageTiming.recommendedStudentActivitySec,
        taskFitsBudget: pageTiming.taskFitsBudget,
        timingRationale: pageTiming.rationale,
      }),
    };
  });
  return allocateTeachingStageTiming(planned);
}

/**
 * 修复学生 AI 授知页面缺失的知识点关联。
 *
 * 备课阶段的大纲校验只要求"知识点全覆盖",允许导学等概述型页面不带
 * knowledgePointIds;而课堂内容生成的校验(requireReferences)要求每个
 * 学生授知页面都必须关联知识点。两级校验不一致会让已通过备课并经教师
 * 确认的大纲在制作计划阶段硬失败,且重试也无法恢复(确认的大纲不变)。
 * 这里在校验前把缺失关联的页面自动继承其所属课程模块的知识点;模块也
 * 没有知识点时回退为关联全部已确认知识点,保证后续父模块一致性校验通过。
 */
function repairPblKnowledgeReferences(
  outlines: SceneOutline[],
  input: GenerateClassroomInput,
): SceneOutline[] {
  if (input.pblProfile?.generationTemplate !== 'pbl-six-stage') return outlines;
  const catalog = input.pblActivityCatalog ?? [];
  let repaired = 0;
  const result = outlines.map((outline) => {
    if (outline.audience !== 'student' || outline.stageKey !== 'ai-learning') return outline;
    if ((outline.knowledgePointIds ?? []).length > 0) return outline;
    const parent = catalog.find((activity) => activity.activityId === outline.parentActivityId);
    const inherited = (parent?.knowledgePointIds ?? []).filter(Boolean);
    const fallbackIds = inherited.length > 0
      ? inherited
      : (input.knowledgePoints ?? []).map((point) => point.id).filter(Boolean);
    if (fallbackIds.length === 0) return outline;
    repaired += 1;
    return { ...outline, knowledgePointIds: fallbackIds };
  });
  if (repaired > 0) {
    log.info(`Repaired ${repaired} outline(s) missing knowledge point references (inherited from parent module)`);
  }
  return result;
}

function validateConfirmedPblDetails(
  outlines: SceneOutline[],
  input: GenerateClassroomInput,
): void {
  if (input.pblProfile?.generationTemplate !== 'pbl-six-stage') return;
  const catalog = input.pblActivityCatalog ?? [];
  if (catalog.length === 0) return;

  const catalogIds = new Set(catalog.map((activity) => activity.activityId));
  const orphanDetails = outlines.filter(
    (outline) => !outline.parentActivityId || !catalogIds.has(outline.parentActivityId),
  );
  if (orphanDetails.length > 0) {
    throw new Error(
      `课程大纲层级校验失败：${orphanDetails
        .slice(0, 3)
        .map((outline) => outline.title)
        .join('、')} 未关联有效的一级活动。`,
    );
  }

  if (input.knowledgePoints?.length) {
    const studentDetails = outlines
      .filter((outline) => outline.audience === 'student' && outline.stageKey === 'ai-learning')
      .map((outline) => ({
        id: outline.id,
        title: outline.title,
        stageKey: outline.stageKey,
        knowledgePointIds: outline.knowledgePointIds,
      }));
    const validation = validatePblKnowledgeAlignment(
      studentDetails,
      input.knowledgePoints,
      { requireReferences: true, requireCoverage: true },
    );
    if (validation.issues.length > 0) {
      throw new Error(
        `课程大纲知识点校验失败：${validation.issues
          .slice(0, 3)
          .map((issue) => issue.message)
        .join('；')}`,
      );
    }
    const parentKnowledgeViolations = studentDetails.flatMap((detail) => {
      const sourceOutline = outlines.find((outline) => outline.id === detail.id);
      const parent = catalog.find(
        (activity) => activity.activityId === sourceOutline?.parentActivityId,
      );
      const isTerminalMasteryAssessment = sourceOutline?.type === 'quiz'
        && outlines.filter(
          (outline) => outline.audience === 'student'
            && outline.stageKey === 'ai-learning'
            && outline.type === 'quiz',
        ).length === 1;
      const allowedIds = new Set(
        isTerminalMasteryAssessment
          ? input.knowledgePoints?.map((point) => point.id)
          : parent?.knowledgePointIds ?? [],
      );
      if (allowedIds.size === 0) return [];
      const invalidIds = (detail.knowledgePointIds ?? []).filter((id) => !allowedIds.has(id));
      return invalidIds.length > 0 ? [{ detail, invalidIds }] : [];
    });
    if (parentKnowledgeViolations.length > 0) {
      const violation = parentKnowledgeViolations[0];
      throw new Error(
        `课程大纲知识点与课程模块不一致：${violation.detail.title ?? violation.detail.id} 使用了 ${violation.invalidIds.join('、')}。`,
      );
    }
  }
}

async function generateAgentProfiles(
  requirement: string,
  languageDirective: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: GenerateClassroomOptions,
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;
  assertRequestedClassroomMediaProviders(input);

  const reportProgress = async (progress: ClassroomGenerationProgress) => {
    throwIfAborted(options.signal);
    await options.onProgress?.(progress);
    throwIfAborted(options.signal);
  };

  await reportProgress({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
    thinkingConfig: classroomThinking,
  } = await resolveModel({ modelString: input.generationModelString });
  const generationModelFingerprint = fingerprintGenerationValue({
    modelString,
    providerId,
    outputWindow: modelInfo?.outputWindow ?? null,
    thinking: classroomThinking ?? null,
    pipeline: 'classic-course-page-v2',
  });
  throwIfAborted(options.signal);
  log.info(`Using teacher-selected generation model for all course authoring calls: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  const generationVision = modelInfo?.capabilities?.vision === true;
  const aiCall = createCourseGenerationAiCall({
    model: languageModel, vision: generationVision,
    source: 'generate-classroom', signal: options.signal,
    // Reasoning tokens and visible JSON share the provider's output budget.
    // DeepSeek V4.1 Flash used 6.5k reasoning tokens for a two-page teaching
    // design in production, so a 16k cap can end before a slide JSON closes.
    // Preserve the selected model's declared window, as the stable baseline did.
    maxOutputTokens: modelInfo?.outputWindow,
    thinking: classroomThinking,
    timeoutMs: resolveLlmRequestTimeoutMs('long-generation'),
    streamMaxDurationMs: resolveLlmStreamMaxDurationMs(),
    maxRetries: 2,
    // Long-reasoning slide calls can exceed the gateway's five-minute response
    // header limit before a non-streaming body exists. Streaming establishes
    // the response early; the full model output window above prevents the
    // truncation that the former 16k streamed configuration caused.
    streamResponse: true,
  });
  const teachingEnhancementAiCall = createCourseGenerationAiCall({
    model: languageModel,
    vision: false,
    source: 'classroom-section-teaching-design',
    signal: options.signal,
    maxOutputTokens: modelInfo?.outputWindow,
    thinking: classroomThinking,
    timeoutMs: resolveLlmRequestTimeoutMs('long-generation'),
    maxRetries: 2,
    streamResponse: true,
    streamMaxDurationMs: resolveLlmStreamMaxDurationMs(),
  });
  const narrationRewriteAiCall = createCourseGenerationAiCall({
    model: languageModel,
    vision: false,
    source: 'classroom-natural-narration',
    signal: options.signal,
    maxOutputTokens: modelInfo?.outputWindow,
    thinking: classroomThinking,
    timeoutMs: resolveLlmRequestTimeoutMs('long-generation'),
    maxRetries: 2,
    streamResponse: true,
    streamMaxDurationMs: resolveLlmStreamMaxDurationMs(),
  });
  // Interactive widgets return a full HTML/CSS/JS document and routinely need
  // longer than a normal slide JSON response. Keep the exact same resolved
  // teacher model, but use one bounded long request instead of three 180-second
  // attempts that can fail a nearly completed course after many minutes.
  const interactiveContentAiCall = createCourseGenerationAiCall({
    model: languageModel,
    vision: generationVision,
    source: 'generate-classroom-interactive',
    signal: options.signal,
    maxOutputTokens: modelInfo?.outputWindow,
    thinking: classroomThinking,
    timeoutMs: resolveLlmRequestTimeoutMs('long-generation'),
    maxRetries: 2,
    streamResponse: true,
    streamMaxDurationMs: resolveLlmStreamMaxDurationMs(),
  });
  // Page content, action scripts, agent profiles, and repair drafts all use
  // this exact model. Vision is a capability of that selection, never a reason
  // to switch models behind the teacher's back.
  const resolveSceneContentCall = async (outlineType: SceneOutline['type']) => ({
    aiCall: outlineType === 'interactive' ? interactiveContentAiCall : aiCall,
    vision: generationVision,
    model: languageModel,
    thinking: classroomThinking,
  });
  const getSceneActionsAiCall = async () => aiCall;
  const getAgentProfilesAiCall = async () => aiCall;

  const searchQueryAiCall: AICallFn = (systemPrompt, userPrompt) => createCourseGenerationAiCall({
    model: languageModel, vision: false, source: 'web-search-query-rewrite',
    signal: options.signal, maxOutputTokens: 256, thinking: classroomThinking,
    timeoutMs: resolveLlmRequestTimeoutMs('page-generation'),
  })(systemPrompt, userPrompt);

  const requirements: UserRequirements = {
    requirement,
    teachingSourceContext: input.teachingSourceContext,
    generationMode: input.generationMode,
    pblProfile: input.pblProfile,
    pblTeachingActivities: input.pblTeachingActivities,
    pblActivityCatalog: input.pblActivityCatalog,
    knowledgePoints: input.knowledgePoints,
    teachingConstraints: input.teachingConstraints,
  };
  const vocationalActive = resolveVocationalActive(requirements);
  const pdfText = pdfContent?.text || undefined;

  await reportProgress({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const webSearchConfig = resolveClassroomWebSearchConfig(input);
    if (webSearchConfig) {
      try {
        throwIfAborted(options.signal);
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

        log.info('Running web search for classroom generation', {
          hasPdfContext: searchQuery.hasPdfContext,
          rawRequirementLength: searchQuery.rawRequirementLength,
          rewriteAttempted: searchQuery.rewriteAttempted,
          finalQueryLength: searchQuery.finalQueryLength,
        });

        const searchResult = await searchWeb({
          providerId: webSearchConfig.providerId,
          query: searchQuery.query,
          apiKey: webSearchConfig.apiKey,
          baseUrl: webSearchConfig.baseUrl,
          signal: options.signal,
          baiduSubSources: webSearchConfig.baiduSubSources,
        });
        throwIfAborted(options.signal);
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        if (options.signal?.aborted) throw e;
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no web search API key configured, skipping web search');
    }
  }
  if (researchContext) {
    requirements.requirement = `${requirements.requirement}\n\n已联网核验的资料上下文（只能据此补充事实并保留来源名称，不得覆盖教师确认的知识图谱）：\n${researchContext}`;
  }

  await reportProgress({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  const preparedOutlines = normalizeSceneOutlinesForGeneration(options.preparedOutlines);
  const confirmedOutlines = normalizeSceneOutlinesForGeneration(input.sceneOutlines);
  const isStructuredPbl =
    input.pblProfile?.generationTemplate === 'pbl-six-stage' ||
    Boolean(input.pblActivityCatalog?.length);
  if (isStructuredPbl && preparedOutlines.length === 0 && confirmedOutlines.length === 0) {
    throw new Error('课程生成必须使用已确认的课程大纲，当前未收到有效课程大纲内容。');
  }

  let generatedLanguageDirective = '';
  let generatedCourseTitle: string | undefined;
  let generatedOutlines: SceneOutline[] = [];
  if (preparedOutlines.length === 0 && confirmedOutlines.length === 0) {
    const outlinesResult = await generateSceneOutlinesFromRequirements(
      requirements,
      pdfText,
      undefined,
      aiCall,
      undefined,
      {
        imageGenerationEnabled: input.enableImageGeneration,
        videoGenerationEnabled: input.enableVideoGeneration,
        researchContext,
        // NO teacherContext — agents haven't been generated yet
      },
    );

    throwIfAborted(options.signal);
    if (!outlinesResult.success || !outlinesResult.data) {
      log.error('Failed to generate outlines:', outlinesResult.error);
      throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
    }

    generatedLanguageDirective = outlinesResult.data.languageDirective;
    generatedCourseTitle = outlinesResult.data.courseTitle;
    generatedOutlines = outlinesResult.data.outlines;
  }
  const courseTitle = input.courseTitle || generatedCourseTitle;
  const baseOutlines = enforcePblOutlineContract(
    preparedOutlines.length > 0
      ? preparedOutlines
      : confirmedOutlines.length > 0
        ? confirmedOutlines
        : generatedOutlines,
    requirements,
  );
  const courseLanguage = resolveCourseLanguagePolicy({
    explicitDirective: input.languageDirective,
    generatedDirective: generatedLanguageDirective,
    ttsLanguage: input.ttsLanguage,
    requirement,
    courseTitle,
    outlineText: baseOutlines.flatMap((outline) => [
      outline.title,
      outline.description,
      ...(outline.keyPoints ?? []),
    ]),
  });
  const languageDirective = courseLanguage.directive;
  log.info(
    `Resolved course language: ${courseLanguage.locale} (${courseLanguage.source})`,
  );
  const outlineSource = preparedOutlines.length > 0
    ? 'prepared'
    : confirmedOutlines.length > 0
      ? 'confirmed'
      : 'generated';
  // The official outline planner owns media choices. Confirmed outlines keep
  // exactly the mediaGenerations it produced (or the teacher retained); a
  // second CoTeach media-planning call changed page composition after outline
  // approval and made this path diverge from OpenMAIC one-click generation.
  const ttsTimingSelection = resolveServerTtsTimingSelection({
    providerId: input.ttsProviderId,
    modelId: input.ttsModelId,
    voiceId: input.ttsVoice,
    speed: input.ttsSpeed,
    language: input.ttsLanguage,
  });
  let outlines = preparedOutlines.length ? baseOutlines : repairPblKnowledgeReferences(
    attachTtsTimingPlans(
      normalizeSceneOutlinesForDuration(baseOutlines),
      ttsTimingSelection,
    ),
    input,
  );
  const shouldEnhanceTeaching = preparedOutlines.length === 0 || outlines.some((outline) => (
    outline.generationPurpose === 'knowledge-teaching'
    && (outline.type === 'slide' || outline.type === 'interactive')
    && !hasCompleteTeachingBrief(outline)
  ));
  if (shouldEnhanceTeaching) {
    let teachingDesignProgress = { completedSections: 0, totalSections: 0 };
    const reportTeachingDesignProgress = () => reportProgress({
      step: 'generating_outlines',
      progress: teachingDesignProgress.totalSections > 0
        ? 18 + Math.floor((teachingDesignProgress.completedSections / teachingDesignProgress.totalSections) * 10)
        : 18,
      message: teachingDesignProgress.totalSections > 0
        ? `正在生成分小节教学设计（${teachingDesignProgress.completedSections}/${teachingDesignProgress.totalSections}）`
        : '正在检查分小节教学设计',
      scenesGenerated: 0,
      totalScenes: outlines.length,
    });
    const heartbeat = setInterval(() => {
      void reportTeachingDesignProgress().catch((error) => {
        if (!options.signal?.aborted) log.warn('Could not persist teaching-design heartbeat:', error);
      });
    }, 15_000);
    try {
      outlines = await enhanceTeachingBriefs({
        outlines,
        courseTitle,
        requirement: requirements.requirement,
        sourceContext: requirements.teachingSourceContext || pdfText || researchContext,
        aiCall: teachingEnhancementAiCall,
        concurrency: getClassroomSceneConcurrency(),
        onProgress: async (progress) => {
          teachingDesignProgress = progress;
          log.info(
            `Teaching design sections completed: ${progress.completedSections}/${progress.totalSections}`,
          );
          await reportTeachingDesignProgress();
        },
        onWarning: (warning) => {
          log.warn(warning);
        },
        modelFingerprint: generationModelFingerprint,
        loadSectionCheckpoint: options.loadTeachingSectionCheckpoint,
        onSectionCompleted: options.onTeachingSectionCompleted,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  throwIfAborted(options.signal);
  validateConfirmedPblDetails(outlines, input);
  await options.onOutlinesPrepared?.(outlines);
  throwIfAborted(options.signal);
  log.info(
    outlineSource === 'generated'
      ? `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`
      : `Using ${outlines.length} ${outlineSource} scene outlines (courseTitle: ${courseTitle ?? 'n/a'})`,
  );

    await reportProgress({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  // Resolve agents based on agentMode — now AFTER outlines so we can use languageDirective
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      agents = await generateAgentProfiles(
        requirement,
        languageDirective,
        await getAgentProfilesAiCall(),
      );
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      if (options.signal?.aborted) throw e;
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }

  const stageId = nanoid(10);
  const stage: Stage = {
    id: stageId,
    name: courseTitle || outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    languageDirective,
    videoManifest: buildVideoManifestFromOutlines(outlines),
    style: 'professional',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // For LLM-generated agents, embed full configs so the client can
    // hydrate the agent registry without prior IndexedDB data.
    // For default agents, just record IDs — the client already has them.
    ...(agentMode === 'generate'
      ? {
          generatedAgentConfigs: agents.map((a, i) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            persona: a.persona || '',
            avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
            color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
            priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
          })),
        }
      : {
          agentIds: agents.map((a) => a.id),
        }),
  };

  log.info('Stage 2: Generating scene content and actions...');
  const sceneConcurrency = getClassroomSceneConcurrency();
  log.info(`Generating scenes with bounded concurrency: ${sceneConcurrency}`);
  let generatedSceneDrafts = 0;
  const layoutAuditPages: NonNullable<CourseQualityReport['layoutAudit']>['pages'] = [];
  const activePages = new Map<number, NonNullable<ClassroomGenerationProgress['activePages']>[number]>();
  const activePageSnapshot = () => [...activePages.values()]
    .map((page) => ({
      ...page,
      executionMs: page.requestStartedAt
        ? Math.max(page.executionMs ?? 0, Date.now() - page.requestStartedAt)
        : page.executionMs,
    }))
    .sort((left, right) => left.index - right.index);
  const reportPageStage = async (
    index: number,
    title: string,
    pageStage: NonNullable<ClassroomGenerationProgress['stage']>,
  ) => {
    const previous = activePages.get(index);
    activePages.set(index, {
      ...previous,
      index: index + 1,
      title,
      stage: pageStage,
      startedAt: previous?.stage === pageStage ? previous.startedAt : Date.now(),
    });
    const labels: Record<NonNullable<ClassroomGenerationProgress['stage']>, string> = {
      restoring: '恢复断点',
      content: '生成页面正文',
      'reviewed-content': '检查版式与知识覆盖',
      actions: '生成讲稿与教学动作',
      narration: '校验课堂口语',
      assembling: '组装并保存页面',
    };
    await reportProgress({
      step: 'generating_scenes',
      progress: completedSceneGenerationProgress(generatedSceneDrafts, outlines.length),
      message: `第 ${index + 1}/${outlines.length} 页：${labels[pageStage]} · ${title}`,
      scenesGenerated: generatedSceneDrafts,
      totalScenes: outlines.length,
      stage: pageStage,
      activePages: activePageSnapshot(),
    });
  };
  const pageCallContext = async (
    index: number,
    pageStage: SceneGenerationCheckpointStage,
    inputFingerprint?: string,
  ) => {
    const attemptsStarted = Math.max(0, await options.loadSceneStageAttemptCount?.(
      outlines[index]!,
      pageStage,
      generationModelFingerprint,
      inputFingerprint,
    ) ?? 0);
    return {
      attemptsStarted,
      onQueued: async ({ totalAttempt }: { totalAttempt: number }) => {
        const page = activePages.get(index);
        if (page) activePages.set(index, { ...page, retryCount: totalAttempt - 1 });
        await options.onSceneStageAttempt?.(
          outlines[index]!,
          pageStage,
          totalAttempt,
          generationModelFingerprint,
          inputFingerprint,
        );
      },
      onStarted: ({ totalAttempt, queueMs, startedAt }: {
        totalAttempt: number;
        queueMs: number;
        startedAt: number;
      }) => {
        const page = activePages.get(index);
        if (page) activePages.set(index, {
          ...page,
          queueMs,
          requestStartedAt: startedAt,
          executionMs: 0,
          retryCount: totalAttempt - 1,
        });
      },
      onActivity: ({ at }: { at: number }) => {
        const page = activePages.get(index);
        if (page) activePages.set(index, {
          ...page,
          lastOutputAt: at,
          executionMs: page.requestStartedAt ? at - page.requestStartedAt : page.executionMs,
        });
      },
      onRetry: async ({ attempt }: { attempt: number }) => {
        const page = activePages.get(index);
        if (page) activePages.set(index, { ...page, retryCount: attempt });
        await reportPageStage(index, outlines[index]?.title ?? `Page ${index + 1}`, pageStage);
      },
      onSettled: ({ durationMs }: { durationMs: number }) => {
        const page = activePages.get(index);
        if (page) activePages.set(index, { ...page, executionMs: durationMs });
      },
    };
  };

  // Each worker generates content -> actions once
  // sequential. Only independent scenes run concurrently; drafts are
  // assembled into the stage below in the original outline order.
  const sceneDrafts = await mapWithConcurrencySettledOnError(
    outlines,
    sceneConcurrency,
    async (outline, index) => {
      throwIfAborted(options.signal);
      const safeOutline = applyOutlineFallbacks(outline, true, {
        allowProceduralSkill: vocationalActive,
        personalProject: requirements.pblProfile?.projectMode === 'personal',
      });
      const requiresNaturalNarration = courseLanguage.locale === 'zh-CN'
        && safeOutline.generationPurpose === 'knowledge-teaching'
        && hasCompleteTeachingBrief(safeOutline);
      const pageInputFingerprint = fingerprintGenerationValue({
        courseTitle: courseTitle ?? null,
        courseLanguage,
        languageDirective,
        requirements,
        agents,
        outlineContext: outlines,
        generationVision,
        narrationPolicy: requiresNaturalNarration ? NATURAL_NARRATION_VERSION : null,
        pipeline: 'classic-course-page-v2',
      });
      let pageHeartbeat: ReturnType<typeof setInterval> | undefined;
      try {
      await reportPageStage(index, safeOutline.title, 'restoring');
      pageHeartbeat = setInterval(() => {
        const current = activePages.get(index);
        void reportProgress({
          step: 'generating_scenes',
          progress: completedSceneGenerationProgress(generatedSceneDrafts, outlines.length),
          message: current
            ? `第 ${index + 1}/${outlines.length} 页仍在${current.stage}：${safeOutline.title}`
            : `正在制作第 ${index + 1}/${outlines.length} 页：${safeOutline.title}`,
          scenesGenerated: generatedSceneDrafts,
          totalScenes: outlines.length,
          stage: current?.stage,
          activePages: activePageSnapshot(),
        }).catch((error) => {
          if (!options.signal?.aborted) log.warn(`Could not persist page heartbeat for "${safeOutline.title}":`, error);
        });
      }, 15_000);

      const checkpoint = await options.loadSceneCheckpoint?.(
        safeOutline,
        index,
        stageId,
        generationModelFingerprint,
        pageInputFingerprint,
      );
      if (checkpoint) {
        const checkpointLanguageIssues = auditNarrationLanguage(
          checkpoint.actions,
          courseLanguage.locale,
        );
        if (checkpointLanguageIssues.length > 0) {
          log.warn(
            `Ignoring checkpoint "${safeOutline.title}" because ${checkpointLanguageIssues.length} narration segment(s) do not match ${courseLanguage.locale}`,
          );
        } else if (
          requiresNaturalNarration
          && checkpoint.narrationRevision !== NATURAL_NARRATION_VERSION
        ) {
          log.warn(
            `Ignoring checkpoint "${safeOutline.title}" because its narration did not pass ${NATURAL_NARRATION_VERSION}`,
          );
        } else {
          if (safeOutline.type === 'slide') {
            if (checkpoint.content.type !== 'slide') {
              log.warn(`Ignoring checkpoint "${safeOutline.title}" because its content type is not slide`);
            } else {
              const checkpointContent = {
                elements: checkpoint.content.canvas.elements,
                background: checkpoint.content.canvas.background,
                theme: checkpoint.content.canvas.theme,
              };
              const checkpointLayout = await auditSlideLayout(
                checkpointContent,
                safeOutline.id,
              );
              const checkpointDensity = auditSlideDensity(safeOutline, checkpointContent);
              const checkpointKnowledgeCoverage = slideKnowledgeCoverage(
                safeOutline.keyPoints,
                checkpointContent.elements,
              );
              // Completed checkpoints are durable work. Density and semantic
              // coverage are quality findings, not proof that the saved page
              // is corrupt; reauthoring it on every continuation wastes model
              // calls and can make a late single-page failure restart the deck.
              // Only structural or rendered layout defects block reuse.
              const checkpointBlockingIssues = checkpointLayout.issues;
              if (checkpointBlockingIssues.length === 0) {
                layoutAuditPages[index] = {
                  outlineId: safeOutline.id,
                  title: safeOutline.title,
                  status: checkpointLayout.status,
                  initialIssues: checkpointLayout.issues,
                  finalIssues: checkpointLayout.issues,
                  repairAttempted: false,
                  adopted: 'checkpoint',
                  initialKnowledgeCoverage: checkpointKnowledgeCoverage,
                  finalKnowledgeCoverage: checkpointKnowledgeCoverage,
                  initialDensityIssues: checkpointDensity.issues,
                  finalDensityIssues: checkpointDensity.issues,
                  initialVisibleTextCharacters: checkpointDensity.visibleTextCharacters,
                  finalVisibleTextCharacters: checkpointDensity.visibleTextCharacters,
                  initialVerticalSpan: checkpointDensity.verticalSpan,
                  finalVerticalSpan: checkpointDensity.verticalSpan,
                  initialContentAreaUtilization: checkpointDensity.contentAreaUtilization,
                  finalContentAreaUtilization: checkpointDensity.contentAreaUtilization,
                  initialMaxBlankBand: checkpointDensity.maxBlankBand,
                  finalMaxBlankBand: checkpointDensity.maxBlankBand,
                  initialHasDeepBlueTitle: checkpointDensity.hasDeepBlueTitle,
                  finalHasDeepBlueTitle: checkpointDensity.hasDeepBlueTitle,
                  initialHasSubtitle: checkpointDensity.hasSubtitle,
                  finalHasSubtitle: checkpointDensity.hasSubtitle,
                  semanticStructureRequired: checkpointDensity.semanticStructureRequired,
                  initialSemanticStructures: checkpointDensity.semanticStructures,
                  finalSemanticStructures: checkpointDensity.semanticStructures,
                  initialSemanticStructureSatisfied: checkpointDensity.semanticStructureSatisfied,
                  finalSemanticStructureSatisfied: checkpointDensity.semanticStructureSatisfied,
                  initialPaletteDeviationCount: checkpointDensity.paletteDeviationCount,
                  finalPaletteDeviationCount: checkpointDensity.paletteDeviationCount,
                  initialElementCount: checkpointDensity.elementCount,
                  finalElementCount: checkpointDensity.elementCount,
                  initialSemanticElementCount: checkpointDensity.semanticElementCount,
                  finalSemanticElementCount: checkpointDensity.semanticElementCount,
                  initialQualityScore: undefined,
                  finalQualityScore: undefined,
                  reason: checkpointLayout.reason,
                };
                generatedSceneDrafts += 1;
                await reportProgress({
                  step: 'generating_scenes', progress: completedSceneGenerationProgress(generatedSceneDrafts, outlines.length),
                  message: `Restored ${generatedSceneDrafts}/${outlines.length} audited scenes`,
                  scenesGenerated: generatedSceneDrafts, totalScenes: outlines.length,
                });
                return { outline: safeOutline, scene: checkpoint, index };
              }
              log.warn(
                `Ignoring checkpoint "${safeOutline.title}" because the resumed page failed structural/layout audit: ${checkpointBlockingIssues.join(' | ')}`,
              );
            }
          } else {
            generatedSceneDrafts += 1;
            await reportProgress({
              step: 'generating_scenes', progress: completedSceneGenerationProgress(generatedSceneDrafts, outlines.length),
              message: `Restored ${generatedSceneDrafts}/${outlines.length} completed scenes`,
              scenesGenerated: generatedSceneDrafts, totalScenes: outlines.length,
            });
            return { outline: safeOutline, scene: checkpoint, index };
          }
        }
      }

      const contentCall = await resolveSceneContentCall(safeOutline.type);
      const websiteReferenceContext = safeOutline.type === 'slide'
        ? {
            courseTitle,
            slideTitles: outlines
              .filter((item) => item.type === 'slide')
              .map((item) => item.title),
          }
        : undefined;
      const loadStage = (checkpointStage: SceneGenerationCheckpointStage, inputFingerprint?: string) =>
        options.loadSceneStageCheckpoint?.(
          safeOutline,
          checkpointStage,
          generationModelFingerprint,
          inputFingerprint,
        );
      const saveStage = (
        checkpointStage: SceneGenerationCheckpointStage,
        payload: unknown,
        inputFingerprint?: string,
      ) => options.onSceneStageCompleted?.(
        safeOutline,
        checkpointStage,
        payload,
        generationModelFingerprint,
        inputFingerprint,
      );

      await reportPageStage(index, safeOutline.title, 'content');
      const restoredContentPayload = await loadStage('content', pageInputFingerprint);
      let content = restoredContentPayload
        && typeof restoredContentPayload === 'object'
        && isGeneratedSceneContent(
          (restoredContentPayload as { content?: unknown }).content,
          safeOutline.type,
        )
        ? (restoredContentPayload as { content: GeneratedSceneContent }).content
        : null;
      if (!content) {
        content = await generateSceneContent(
          safeOutline,
          withCourseGenerationAiCallContext(
            contentCall.aiCall,
            await pageCallContext(index, 'content', pageInputFingerprint),
          ),
          {
          agents, languageDirective, userRequirements: requirements,
          pblProfile: requirements.pblProfile, allowProceduralSkill: vocationalActive,
          signal: options.signal, visionEnabled: contentCall.vision,
          languageModel: contentCall.model, thinkingConfig: contentCall.thinking,
          ...(websiteReferenceContext ? { websiteReferenceContext } : {}),
          },
        );
        if (!content) throw Object.assign(new Error(`Scene "${safeOutline.title}" returned invalid content`), { isRetryable: false });
        await saveStage('content', { content }, pageInputFingerprint);
      }
      throwIfAborted(options.signal);
      const rawContentFingerprint = fingerprintGenerationValue(content);
      const reviewInputFingerprint = fingerprintGenerationValue({
        rawContentFingerprint,
        auditPolicy: 'browser-density-knowledge-v2',
      });
      await reportPageStage(index, safeOutline.title, 'reviewed-content');
      const restoredReviewedPayload = await loadStage('reviewed-content', reviewInputFingerprint);
      const restoredReviewed = restoredReviewedPayload && typeof restoredReviewedPayload === 'object'
        ? restoredReviewedPayload as { content?: unknown; layoutAuditPage?: unknown }
        : null;
      let restoredReviewedValid = false;
      if (restoredReviewed && isGeneratedSceneContent(restoredReviewed.content, safeOutline.type)) {
        restoredReviewedValid = true;
        content = restoredReviewed.content;
        if (restoredReviewed.layoutAuditPage) {
          layoutAuditPages[index] = restoredReviewed.layoutAuditPage as NonNullable<CourseQualityReport['layoutAudit']>['pages'][number];
        }
      } else if (safeOutline.type === 'slide' && 'elements' in content) {
        // The pinned OpenMAIC generator owns the first draft. A measured defect
        // may invoke its own edit mode exactly once with the same teacher-picked
        // model. The candidate is accepted only when browser/density evidence
        // improves and the confirmed knowledge coverage is preserved.
        const reviewed = await auditAndRepairSlideOnce({
          outline: safeOutline,
          content,
          regenerate: async (editDirective, baselineContent) => {
            try {
              const candidate = await generateSceneContent(
                safeOutline,
                withCourseGenerationAiCallContext(
                  contentCall.aiCall,
                  await pageCallContext(index, 'reviewed-content', reviewInputFingerprint),
                ),
                {
                  agents, languageDirective, userRequirements: requirements,
                  pblProfile: requirements.pblProfile,
                  allowProceduralSkill: vocationalActive,
                  signal: options.signal,
                  visionEnabled: contentCall.vision,
                  languageModel: contentCall.model,
                  thinkingConfig: contentCall.thinking,
                  editDirective,
                  baselineContent,
                  ...(websiteReferenceContext ? { websiteReferenceContext } : {}),
                },
              );
              return candidate && 'elements' in candidate ? candidate : null;
            } catch (error) {
              if (options.signal?.aborted) throw error;
              log.warn(
                `Keeping the OpenMAIC first draft because the optional single page edit failed for "${safeOutline.title}":`,
                error,
              );
              return null;
            }
          },
        });
        content = reviewed.content;
        layoutAuditPages[index] = {
          outlineId: safeOutline.id,
          title: safeOutline.title,
          status: reviewed.finalAudit.status,
          initialIssues: reviewed.initialAudit.issues,
          finalIssues: reviewed.finalAudit.issues,
          repairAttempted: reviewed.repairAttempted,
          adopted: reviewed.adopted,
          initialKnowledgeCoverage: reviewed.initialKnowledgeCoverage,
          finalKnowledgeCoverage: reviewed.finalKnowledgeCoverage,
          initialDensityIssues: reviewed.initialDensityIssues,
          finalDensityIssues: reviewed.finalDensityIssues,
          initialVisibleTextCharacters: reviewed.initialVisibleTextCharacters,
          finalVisibleTextCharacters: reviewed.finalVisibleTextCharacters,
          initialVerticalSpan: reviewed.initialVerticalSpan,
          finalVerticalSpan: reviewed.finalVerticalSpan,
          initialContentAreaUtilization: reviewed.initialContentAreaUtilization,
          finalContentAreaUtilization: reviewed.finalContentAreaUtilization,
          initialMaxBlankBand: reviewed.initialMaxBlankBand,
          finalMaxBlankBand: reviewed.finalMaxBlankBand,
          initialHasDeepBlueTitle: reviewed.initialHasDeepBlueTitle,
          finalHasDeepBlueTitle: reviewed.finalHasDeepBlueTitle,
          initialHasSubtitle: reviewed.initialHasSubtitle,
          finalHasSubtitle: reviewed.finalHasSubtitle,
          semanticStructureRequired: reviewed.semanticStructureRequired,
          initialSemanticStructures: reviewed.initialSemanticStructures,
          finalSemanticStructures: reviewed.finalSemanticStructures,
          initialSemanticStructureSatisfied: reviewed.initialSemanticStructureSatisfied,
          finalSemanticStructureSatisfied: reviewed.finalSemanticStructureSatisfied,
          initialPaletteDeviationCount: reviewed.initialPaletteDeviationCount,
          finalPaletteDeviationCount: reviewed.finalPaletteDeviationCount,
          initialElementCount: reviewed.initialElementCount,
          finalElementCount: reviewed.finalElementCount,
          initialSemanticElementCount: reviewed.initialSemanticElementCount,
          finalSemanticElementCount: reviewed.finalSemanticElementCount,
          initialQualityScore: reviewed.initialQualityScore,
          finalQualityScore: reviewed.finalQualityScore,
          reason: reviewed.finalAudit.reason,
        };
      }
      if (!restoredReviewedValid) {
        await saveStage('reviewed-content', {
          content,
          ...(layoutAuditPages[index] ? { layoutAuditPage: layoutAuditPages[index] } : {}),
        }, reviewInputFingerprint);
      }
      throwIfAborted(options.signal);
      const actionAiCall = await getSceneActionsAiCall();
      const actionOptions = {
        ctx: buildNarrationContext(outlines, index),
        agents,
        pblProfile: requirements.pblProfile,
        teachingConstraints: requirements.teachingConstraints,
        teachingSourceContext: requirements.teachingSourceContext,
      };
      const reviewedContentFingerprint = fingerprintGenerationValue({
        content,
        pageInputFingerprint,
        actionPolicy: 'scene-actions-v2',
      });
      const contextualActionAiCall = withCourseGenerationAiCallContext(
        actionAiCall,
        await pageCallContext(index, 'actions', reviewedContentFingerprint),
      );
      await reportPageStage(index, safeOutline.title, 'actions');
      const restoredActionsPayload = await loadStage('actions', reviewedContentFingerprint);
      let actions = restoredActionsPayload
        && typeof restoredActionsPayload === 'object'
        && isActionList((restoredActionsPayload as { actions?: unknown }).actions)
        ? (restoredActionsPayload as { actions: Action[] }).actions
        : null;
      const restoredActionsValid = actions !== null;
      if (!actions) {
        actions = await generateSceneActions(
          safeOutline,
          content,
          contextualActionAiCall,
          {
            ...actionOptions,
            languageDirective,
          },
        );
      }
      let narrationLanguageIssues = auditNarrationLanguage(
        actions,
        courseLanguage.locale,
      );
      if (narrationLanguageIssues.length > 0) {
        log.warn(
          `Repairing ${narrationLanguageIssues.length} wrong-language narration segment(s) for "${safeOutline.title}"`,
        );
        actions = await generateSceneActions(
          safeOutline,
          content,
          contextualActionAiCall,
          {
            ...actionOptions,
            languageDirective: narrationLanguageRepairDirective(
              courseLanguage,
              narrationLanguageIssues,
            ),
          },
        );
        narrationLanguageIssues = auditNarrationLanguage(
          actions,
          courseLanguage.locale,
        );
        if (narrationLanguageIssues.length > 0) {
          const error = new Error(
            `Scene "${safeOutline.title}" narration remained in the wrong language after one correction`,
          );
          Object.assign(error, { isRetryable: false });
          throw error;
        }
      }
      if (!restoredActionsValid) {
        await saveStage('actions', { actions }, reviewedContentFingerprint);
      }
      if (requiresNaturalNarration) {
        await reportPageStage(index, safeOutline.title, 'narration');
        const actionsFingerprint = fingerprintGenerationValue({
          actions,
          pageInputFingerprint,
          narrationPolicy: NATURAL_NARRATION_VERSION,
        });
        const restoredNarrationPayload = await loadStage('narration', actionsFingerprint);
        if (
          restoredNarrationPayload
          && typeof restoredNarrationPayload === 'object'
          && isActionList((restoredNarrationPayload as { actions?: unknown }).actions)
        ) {
          actions = (restoredNarrationPayload as { actions: Action[] }).actions;
        } else {
          actions = await naturalizeKnowledgeNarration({
            outline: safeOutline,
            actions,
            aiCall: withCourseGenerationAiCallContext(
              narrationRewriteAiCall,
              await pageCallContext(index, 'narration', actionsFingerprint),
            ),
            context: actionOptions.ctx,
          });
          await saveStage('narration', { actions }, actionsFingerprint);
        }
      }
      throwIfAborted(options.signal);

      log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);
      await reportPageStage(index, safeOutline.title, 'assembling');
      // Keep the canonical assembler so restored and fresh pages have the
      // exact same timing pauses, PBL metadata and outline identity.
      const pageStore = createInMemoryStore(stage);
      const pageApi = createStageAPI(pageStore);
      const sceneId = createSceneWithActions(safeOutline, content, actions, pageApi);
      const assembledScene = sceneId
        ? pageStore.getState().scenes.find((candidate) => candidate.id === sceneId) ?? null
        : null;
      if (!assembledScene) {
        const error = new Error(`Scene "${safeOutline.title}" could not be assembled`);
        Object.assign(error, { isRetryable: false });
        throw error;
      }
      const scene = requiresNaturalNarration
        ? { ...assembledScene, narrationRevision: NATURAL_NARRATION_VERSION }
        : assembledScene;
      const assembledMissingTools = findMissingRequiredTeachingTools(safeOutline, {
        sceneType: scene.type,
        content: scene.content,
        actions: scene.actions,
      });
      if (assembledMissingTools.length > 0) {
        const error = new Error(
          `Assembled scene "${safeOutline.title}" is missing required teaching tools: ${assembledMissingTools.join(', ')}`,
        );
        Object.assign(error, { isRetryable: false });
        throw error;
      }
      await options.onSceneCompleted?.(
        safeOutline,
        scene,
        index,
        generationModelFingerprint,
        pageInputFingerprint,
      );
      throwIfAborted(options.signal);
      generatedSceneDrafts += 1;
      await reportProgress({
        step: 'generating_scenes',
        progress: completedSceneGenerationProgress(generatedSceneDrafts, outlines.length),
        message: `Generated ${generatedSceneDrafts}/${outlines.length} scenes`,
        scenesGenerated: generatedSceneDrafts,
        totalScenes: outlines.length,
      });
      return { outline: safeOutline, scene, index };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Scene ${index + 1}/${outlines.length} "${safeOutline.title}" failed: ${message}`);
        await reportProgress({
          step: 'generating_scenes',
          progress: completedSceneGenerationProgress(generatedSceneDrafts, outlines.length),
          message: `第 ${index + 1}/${outlines.length} 页失败，正在等待其他活动页安全保存后报告失败`,
          scenesGenerated: generatedSceneDrafts,
          totalScenes: outlines.length,
          stage: activePages.get(index)?.stage,
          activePages: activePageSnapshot(),
        }).catch((progressError) => {
          log.warn('Could not persist the page-failure drain state:', progressError);
        });
        throw contextualizeGenerationError(
          error,
          `Scene ${index + 1}/${outlines.length} "${safeOutline.title}" failed`,
        );
      } finally {
        if (pageHeartbeat) clearInterval(pageHeartbeat);
        activePages.delete(index);
      }
    },
    { shouldContinue: () => !options.signal?.aborted },
  );

  throwIfAborted(options.signal);
  const failedContentTitles = sceneDrafts.flatMap((draft, index) =>
    draft ? [] : [outlines[index]?.title ?? `scene-${index + 1}`],
  );
  assertCompleteSceneGeneration({
    expectedCount: outlines.length,
    generatedCount: sceneDrafts.length - failedContentTitles.length,
    failedTitles: failedContentTitles,
    phase: 'content',
  });
  const assembledScenes = sceneDrafts.flatMap((draft) => draft ? [draft.scene] : []);

  assertCompleteSceneGeneration({
    expectedCount: outlines.length,
    generatedCount: assembledScenes.length,
    failedTitles: sceneDrafts.flatMap((draft, index) => (
      draft ? [] : [outlines[index]?.title ?? `scene-${index + 1}`]
    )),
    phase: 'assembly',
  });

  const qualityResult = auditAndRepairGeneratedCourse(
    outlines,
    assembledScenes,
    requirements.teachingConstraints,
  );
  const scenes = qualityResult.scenes;
  const visualConsistency = auditCourseVisualConsistency(outlines, scenes);
  if (!visualConsistency.passed) {
    qualityResult.report.warnings.push(
      `全课 PPT 未达到 OpenMAIC 参考视觉规范：深蓝标题 ${visualConsistency.deepBlueTitleCount}/${visualConsistency.slideCount}，副标题 ${visualConsistency.subtitleCount}/${visualConsistency.slideCount}，语义结构 ${visualConsistency.semanticStructurePageCount}/${visualConsistency.semanticStructureRequiredCount}，参考色板偏离 ${visualConsistency.paletteDeviationCount} 处，平均可见字符 ${visualConsistency.averageVisibleTextCharacters}、元素 ${visualConsistency.averageElementCount}`,
    );
  }
  const pages = layoutAuditPages.filter(Boolean);
  const unavailablePages = pages.filter((page) => page.status === 'unavailable');
  const uncheckedPages = pages.filter((page) => page.status === 'checkpoint-not-rechecked');
  const unresolvedLayoutPages = pages.filter((page) => page.finalIssues.length > 0);
  const unresolvedDensityPages = pages.filter((page) => (page.finalDensityIssues?.length ?? 0) > 0);
  if (unavailablePages.length > 0) {
    qualityResult.report.warnings.push(`有 ${unavailablePages.length} 页未能完成浏览器布局审计`);
  }
  if (uncheckedPages.length > 0) {
    qualityResult.report.warnings.push(`有 ${uncheckedPages.length} 个断点恢复页面未在本轮重新审计`);
  }
  if (unresolvedLayoutPages.length > 0) {
    qualityResult.report.warnings.push(`有 ${unresolvedLayoutPages.length} 页在单次修复后仍有可见布局问题`);
  }
  if (unresolvedDensityPages.length > 0) {
    qualityResult.report.warnings.push(`有 ${unresolvedDensityPages.length} 页在单次修复后仍有信息覆盖或画布密度问题`);
  }
  const layoutStatus = pages.length > 0 && unavailablePages.length === pages.length
    ? 'unavailable' as const
    : unavailablePages.length > 0 || uncheckedPages.length > 0
      ? 'partial' as const
      : 'completed' as const;
  const disposition = unavailablePages.length > 0
    ? 'audit-unavailable' as const
    : unresolvedLayoutPages.length > 0
      || unresolvedDensityPages.length > 0
      || !visualConsistency.passed
      || qualityResult.report.warnings.length > 0
      ? 'needs-review' as const
      : 'ready' as const;
  const qualityReport: CourseQualityReport = {
    ...qualityResult.report,
    ok: qualityResult.report.warnings.length === 0,
    baselineVersion: `${OPENMAIC_GENERATION_BASELINE.release}@${OPENMAIC_GENERATION_BASELINE.releaseCommit.slice(0, 7)}/${OPENMAIC_GENERATION_BASELINE.package}@${OPENMAIC_GENERATION_BASELINE.version}`,
    generationMethod: 'classic-one-click',
    generationModelString: modelString,
    referenceProfileVersion: OPENMAIC_GENERATION_BASELINE.referenceProfileVersion,
    teachingEnhancementVersion: TEACHING_ENHANCEMENT_VERSION,
    narrationEnhancementVersion: NATURAL_NARRATION_VERSION,
    disposition,
    visualConsistency,
    layoutAudit: { status: layoutStatus, pages },
  };
  if (qualityReport.corrections.length > 0) {
    log.warn(`Course quality corrections: ${qualityReport.corrections.join(' | ')}`);
  }
  if (qualityReport.warnings.length > 0) {
    log.warn(`Course quality warnings: ${qualityReport.warnings.join(' | ')}`);
  }
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  await reportProgress({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom content',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });
  throwIfAborted(options.signal);

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
    },
  );
  throwIfAborted(options.signal);

  log.info(`Classroom persisted: ${persisted.id}`);

  await reportProgress({
    step: 'completed',
    progress: 100,
    message: 'Classroom content ready; media continues in background',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
    qualityReport,
    assetContext: {
      outlines,
      enableImageGeneration: Boolean(input.enableImageGeneration),
      enableVideoGeneration: Boolean(input.enableVideoGeneration),
      enableTTS: Boolean(input.enableTTS),
      isPblCourse:
        input.pblProfile?.generationTemplate === 'pbl-six-stage' ||
        Boolean(input.pblTeachingActivities?.length),
      ttsTimingSelection,
    },
  };
}
