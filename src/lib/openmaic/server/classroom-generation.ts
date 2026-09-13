import { planCourseSlideVisuals, fallbackSlideVisualPlan } from "@openmaic/lib/generation/slide-visual-plan";
import { nanoid } from 'nanoid';
import { callLLM } from '@openmaic/lib/ai/llm';
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
import { getStageModel } from '@openmaic/lib/server/model-routes';
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
  assessTtsDurationError,
  buildTtsTimingPlan,
  estimateSpeechDurationSec,
  isActivityTimingCorrectionCloser,
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
  withGenerationRetry,
} from '@openmaic/lib/generation/generation-retry';
import { mapWithConcurrencySettledOnError } from '@openmaic/lib/utils/concurrency';
import {
  getClassroomSceneConcurrency,
} from '@openmaic/lib/server/provider-config';
import { assertRequestedClassroomMediaProviders } from '@openmaic/lib/server/classroom-media-readiness';
import { resolveLlmRequestTimeoutMs } from '@/lib/llm/request-policy';
import { buildVideoManifestFromOutlines } from '@openmaic/lib/media/video-manifest';
import { planMediaForConfirmedOutlines } from '@openmaic/lib/generation/media-planner';
import { buildNarrationContext } from '@openmaic/lib/generation/narration-continuity';
import { auditAndRepairGeneratedCourse } from '@openmaic/lib/generation/course-quality';
import { findMissingRequiredTeachingTools } from '@openmaic/lib/generation/teaching-tool-plan';
import { addStudentActivityPause } from '@openmaic/lib/generation/activity-gate';
import { assertCompleteSceneGeneration } from '@openmaic/lib/generation/generation-completeness';
import type { SceneOutline, UserRequirements } from '@openmaic/lib/types/generation';
import type { Action } from '@openmaic/lib/types/action';
import { validatePblKnowledgeAlignment } from '@/lib/pbl-outline-validation';
import type { Scene, Stage } from '@openmaic/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@openmaic/lib/constants/agent-defaults';

const log = createLogger('Classroom');
const MAX_PAGE_GENERATION_RETRIES = 2;

function getSpeechActionText(actions: ReadonlyArray<Action> | undefined): string {
  return (actions ?? [])
    .filter((action): action is Extract<Action, { type: 'speech' }> => (
      action.type === 'speech' && Boolean(action.text)
    ))
    .map((action) => action.text)
    .join('\n');
}

export interface GenerateClassroomInput {
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
  qualityReport: import('@openmaic/lib/generation/course-quality').CourseQualityReport;
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
  /** Restore an exact-fingerprint completed page, if one exists. */
  loadSceneCheckpoint?: (
    outline: SceneOutline,
    index: number,
    stageId: string,
  ) => Promise<Scene | null> | Scene | null;
  /** Persist only a fully assembled page, after its timing correction pass. */
  onSceneCompleted?: (
    outline: SceneOutline,
    scene: Scene,
    index: number,
  ) => Promise<void> | void;
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
): SceneOutline[] {
  return outlines.map((outline) => {
    if (outline.audience === 'teacher' || outline.ttsPolicy === 'none') {
      return { ...outline, timingPlan: undefined };
    }
    const activityTargetSec = Math.max(
      1,
      Math.round(outline.targetDurationSec ?? outline.estimatedDuration ?? 60),
    );
    const contentType = inferOutlineContentType(outline);
    const interaction = inferOutlineInteraction(outline);
    const quiz = inferOutlineQuiz(outline);
    const pageTiming = planPblPageTiming({
      activityTargetSec,
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
  } = await resolveModel({ stage: 'generate-classroom' });
  throwIfAborted(options.signal);
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  // The web-search query rewrite is a light, separable stage operators may route
  // to a cheaper model. It defaults to the classroom model and is only
  // re-resolved lazily (inside the web-search branch, and only when a route is
  // configured). This keeps a misconfigured optional route from aborting all
  // classroom generation, and skips the extra resolution when web search is off.
  let searchQueryModel = languageModel;
  let searchQueryThinking = classroomThinking;

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        abortSignal: options.signal,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
      undefined,
      classroomThinking,
    );
    return result.text;
  };

  const sceneAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    // A single pathological page must not hold the entire classroom job
    // indefinitely. Deep-thinking models can legitimately need several minutes
    // for a complex interactive page, so use the conservative long-generation
    // policy instead of the former hard-coded 150-second cutoff. Checkpoint-level
    // recovery will still retry only the missing page if this bounded call fails.
    const pageTimeoutSignal = AbortSignal.timeout(
      resolveLlmRequestTimeoutMs('long-generation'),
    );
    const pageSignal = options.signal
      ? AbortSignal.any([options.signal, pageTimeoutSignal])
      : pageTimeoutSignal;
    const result = await callLLM(
      {
        model: languageModel,
        abortSignal: pageSignal,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxOutputTokens: modelInfo?.outputWindow,
        maxRetries: 0,
      },
      'generate-classroom-scene',
      undefined,
      classroomThinking,
    );
    return result.text;
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: searchQueryModel,
        abortSignal: options.signal,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
      undefined,
      searchQueryThinking,
    );
    return result.text;
  };

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
      // Re-resolve the query-rewrite model only when explicitly routed. If
      // resolution itself fails (e.g. unknown provider in the route), fall back
      // to the classroom model here; a route with a missing key resolves fine
      // and surfaces only later in callLLM, which the outer try/catch below
      // degrades gracefully — either way the pipeline still works.
      const rewriteRoute = getStageModel('web-search-query-rewrite');
      if (rewriteRoute) {
        try {
          const rewriteResolved = await resolveModel({ stage: 'web-search-query-rewrite' });
          searchQueryModel = rewriteResolved.model;
          searchQueryThinking = rewriteResolved.thinkingConfig;
        } catch (err) {
          log.warn(
            `web-search-query-rewrite route "${rewriteRoute}" unavailable; using classroom model for query rewrite`,
            err,
          );
        }
      }
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
  const languageDirective = input.languageDirective || generatedLanguageDirective;
  const courseTitle = input.courseTitle || generatedCourseTitle;
  let baseOutlines = enforcePblOutlineContract(
    preparedOutlines.length > 0
      ? preparedOutlines
      : confirmedOutlines.length > 0
        ? confirmedOutlines
        : generatedOutlines,
    requirements,
  );
  const outlineSource = preparedOutlines.length > 0
    ? 'prepared'
    : confirmedOutlines.length > 0
      ? 'confirmed'
      : 'generated';
  // The selected outline planner owns page cadence. Never inject interaction
  // pages after planning, and always preserve teacher-confirmed scene types.
  if (
    preparedOutlines.length === 0
    && confirmedOutlines.length > 0
    && (input.enableImageGeneration || input.enableVideoGeneration)
  ) {
    try {
      baseOutlines = await withGenerationRetry(
        () => planMediaForConfirmedOutlines(baseOutlines, aiCall, {
          imageEnabled: Boolean(input.enableImageGeneration),
          videoEnabled: Boolean(input.enableVideoGeneration),
          researchContext,
        }),
        {
          label: 'confirmed-outline media planning',
          signal: options.signal,
        },
      );
      log.info(
        `Planned ${baseOutlines.flatMap((outline) => outline.mediaGenerations ?? []).length} optional media assets for confirmed outlines`,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      log.warn('Media planning failed; continuing with confirmed course content:', error);
    }
  }
  // A shared storyboard makes the full deck coherent before independent page workers run.
  if (baseOutlines.some((outline) => outline.type === 'slide' && !outline.visualPlan)) {
    await reportProgress({ step: 'generating_outlines', progress: 28, message: '正在规划每页核心内容、图示与整体构图', scenesGenerated: 0, totalScenes: baseOutlines.length });
    try {
      baseOutlines = await withGenerationRetry(
        () => planCourseSlideVisuals(baseOutlines, aiCall, input.teachingSourceContext ?? requirement),
        { label: 'slide visual storyboards', maxRetries: 1, signal: options.signal },
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      log.warn('Visual storyboarding unavailable; using semantic compositions:', error);
      baseOutlines = baseOutlines.map((outline) => outline.type === 'slide'
        ? { ...outline, visualPlan: outline.visualPlan ?? fallbackSlideVisualPlan(outline) } : outline);
    }
  }
  const ttsTimingSelection = resolveServerTtsTimingSelection({
    providerId: input.ttsProviderId,
    modelId: input.ttsModelId,
    voiceId: input.ttsVoice,
    speed: input.ttsSpeed,
    language: input.ttsLanguage,
  });
  const outlines = repairPblKnowledgeReferences(
    attachTtsTimingPlans(
      normalizeSceneOutlinesForDuration(baseOutlines),
      ttsTimingSelection,
    ),
    input,
  );
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
      agents = await generateAgentProfiles(requirement, languageDirective, aiCall);
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
    style: 'interactive',
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

  // Each worker keeps content -> actions (and the bounded timing correction)
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
      try {
      await reportProgress({
        step: 'generating_scenes',
        // Worker-start events can arrive out of order; keep them at the
        // phase floor so ordered assembly below remains monotonic.
        progress: 31,
        message: `Generating scene ${index + 1}/${outlines.length}: ${safeOutline.title}`,
        scenesGenerated: 0,
        totalScenes: outlines.length,
      });

      const checkpoint = await options.loadSceneCheckpoint?.(safeOutline, index, stageId);
      if (checkpoint) {
        const missingCheckpointTools = findMissingRequiredTeachingTools(safeOutline, {
          sceneType: checkpoint.type,
          content: checkpoint.content,
          actions: checkpoint.actions,
        });
        if (missingCheckpointTools.length === 0) {
          generatedSceneDrafts += 1;
          await reportProgress({
            step: 'generating_scenes',
            progress: completedSceneGenerationProgress(generatedSceneDrafts, outlines.length),
            message: `Restored ${generatedSceneDrafts}/${outlines.length} completed scenes`,
            scenesGenerated: generatedSceneDrafts,
            totalScenes: outlines.length,
          });
          return { outline: safeOutline, scene: checkpoint, index };
        }
        log.warn(
          `Ignoring incomplete scene checkpoint "${safeOutline.title}": missing required tools ${missingCheckpointTools.join(', ')}`,
        );
      }

      const reportSceneRetry = async (
        phase: 'content' | 'actions',
        event: { attempt: number; maxAttempts: number; reason: string },
      ) => {
        const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
        const message = `Retrying scene ${index + 1}/${outlines.length} ${phase} (${nextAttempt}/${event.maxAttempts}): ${safeOutline.title}`;
        log.warn(`${message} — ${event.reason}`);
        await reportProgress({
          step: 'generating_scenes',
          progress: 31,
          message,
          scenesGenerated: 0,
          totalScenes: outlines.length,
        });
      };

      const content = await withGenerationRetry(
        () =>
          generateSceneContent(safeOutline, sceneAiCall, {
            // Content review runs across the completed section in the background;
            // keep the fast draft path bounded to concrete rendering/structure repair.
            reviewSlideContent: false,
            agents,
            languageDirective,
            userRequirements: requirements,
            pblProfile: requirements.pblProfile,
            allowProceduralSkill: vocationalActive,
            signal: options.signal,
          }),
        {
          label: `scene ${index + 1}/${outlines.length} content`,
          maxRetries: MAX_PAGE_GENERATION_RETRIES,
          signal: options.signal,
          shouldRetryResult: (result) => result === null,
          onRetry: (event) => reportSceneRetry('content', event),
        },
      );
      if (!content) {
        const error = new Error(
          `Scene "${safeOutline.title}" returned no usable content after page-level retries`,
        );
        Object.assign(error, { isRetryable: true });
        throw error;
      }
      throwIfAborted(options.signal);

      let actions = await withGenerationRetry(
        () =>
          generateSceneActions(safeOutline, content, sceneAiCall, {
            ctx: buildNarrationContext(outlines, index),
            agents,
            languageDirective,
            pblProfile: requirements.pblProfile,
            teachingConstraints: requirements.teachingConstraints,
            teachingSourceContext: requirements.teachingSourceContext,
          }),
        {
          label: `scene ${index + 1}/${outlines.length} actions`,
          maxRetries: MAX_PAGE_GENERATION_RETRIES,
          signal: options.signal,
          onRetry: (event) => reportSceneRetry('actions', event),
        },
      );
      throwIfAborted(options.signal);

      let missingRequiredTools = findMissingRequiredTeachingTools(safeOutline, {
        sceneType: safeOutline.type,
        content,
        actions,
      });
      if (missingRequiredTools.length > 0) {
        const correction = [
          `The previous action script omitted these required teaching tools: ${missingRequiredTools.join(', ')}.`,
          'Implement the planned trigger, purpose and visible content exactly where the narration reaches it.',
        ].join(' ');
        log.warn(`Correcting required tools for scene "${safeOutline.title}": ${missingRequiredTools.join(', ')}`);
        actions = await withGenerationRetry(
          () => generateSceneActions(safeOutline, content, sceneAiCall, {
            ctx: buildNarrationContext(outlines, index),
            agents,
            languageDirective,
            pblProfile: requirements.pblProfile,
            teachingConstraints: requirements.teachingConstraints,
            teachingSourceContext: requirements.teachingSourceContext,
            teachingToolCorrection: correction,
          }),
          {
            label: `scene ${index + 1}/${outlines.length} required teaching tools`,
            maxRetries: MAX_PAGE_GENERATION_RETRIES,
            signal: options.signal,
            onRetry: (event) => reportSceneRetry('actions', event),
          },
        );
        missingRequiredTools = findMissingRequiredTeachingTools(safeOutline, {
          sceneType: safeOutline.type,
          content,
          actions,
        });
        if (missingRequiredTools.length > 0) {
          const error = new Error(
            `Scene "${safeOutline.title}" is missing required teaching tools after correction: ${missingRequiredTools.join(', ')}`,
          );
          Object.assign(error, { isRetryable: true });
          throw error;
        }
      }

      // A single bounded correction pass keeps the generated script close to
      // the model-specific narration budget without creating an unbounded loop.
      const timingPlan = safeOutline.timingPlan;
      // Include the deterministic fallback feedback that assembly will add
      // when the model omitted a closing speech line. Otherwise correction
      // would underestimate the audio that is actually generated and played.
      const firstSpeechText = getSpeechActionText(
        addStudentActivityPause(safeOutline, actions),
      );
      if (timingPlan && firstSpeechText) {
        const firstEstimatedSec = estimateSpeechDurationSec(firstSpeechText, {
          providerId: timingPlan.providerId,
          modelId: timingPlan.modelId,
          voiceId: timingPlan.voiceId,
          speed: timingPlan.speed,
        });
        const reservedActivitySec = (timingPlan.studentActivitySec ?? 0) + (timingPlan.transitionSec ?? 0);
        const firstAssessment = assessTtsDurationError({
          targetSec: timingPlan.activityTargetDurationSec ?? timingPlan.targetDurationSec,
          actualSec: firstEstimatedSec + reservedActivitySec,
        });
        if (!firstAssessment.withinTolerance && timingPlan.targetDurationSec >= 30) {
          const correctedActions = await withGenerationRetry(
            () => generateSceneActions(safeOutline, content, sceneAiCall, {
              ctx: buildNarrationContext(outlines, index),
              agents,
              languageDirective,
              pblProfile: requirements.pblProfile,
              teachingConstraints: requirements.teachingConstraints,
              teachingSourceContext: requirements.teachingSourceContext,
              timingCorrection: firstAssessment.suggestions.join('；'),
            }),
            {
              label: `scene ${index + 1}/${outlines.length} timing correction`,
              maxRetries: MAX_PAGE_GENERATION_RETRIES,
              signal: options.signal,
              onRetry: (event) => reportSceneRetry('actions', event),
            },
          );
          const correctedText = getSpeechActionText(
            addStudentActivityPause(safeOutline, correctedActions),
          );
          const correctedEstimatedSec = correctedText
            ? estimateSpeechDurationSec(correctedText, {
                providerId: timingPlan.providerId,
                modelId: timingPlan.modelId,
                voiceId: timingPlan.voiceId,
                speed: timingPlan.speed,
              })
            : 0;
          const activityTargetSec =
            timingPlan.activityTargetDurationSec ?? timingPlan.targetDurationSec;
          const correctedMissingTools = findMissingRequiredTeachingTools(safeOutline, {
            sceneType: safeOutline.type,
            content,
            actions: correctedActions,
          });
          if (correctedMissingTools.length === 0 && correctedText && isActivityTimingCorrectionCloser({
            activityTargetSec,
            reservedActivitySec,
            firstNarrationSec: firstEstimatedSec,
            correctedNarrationSec: correctedEstimatedSec,
          })) {
            actions = correctedActions;
          } else if (correctedMissingTools.length > 0) {
            log.warn(
              `Rejected timing correction for scene "${safeOutline.title}" because it omitted required tools: ${correctedMissingTools.join(', ')}`,
            );
          }
          log.warn(
            `Scene timing correction ${safeOutline.title}: activityTarget=${timingPlan.activityTargetDurationSec ?? timingPlan.targetDurationSec}s narrationTarget=${timingPlan.targetDurationSec}s firstTotal=${firstEstimatedSec + reservedActivitySec}s correctedTotal=${correctedEstimatedSec + reservedActivitySec}s`,
          );
        }
      }

      log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);
      // Keep the canonical assembler so restored and fresh pages have the
      // exact same timing pauses, PBL metadata and outline identity.
      const pageStore = createInMemoryStore(stage);
      const pageApi = createStageAPI(pageStore);
      const sceneId = createSceneWithActions(safeOutline, content, actions, pageApi);
      const scene = sceneId
        ? pageStore.getState().scenes.find((candidate) => candidate.id === sceneId) ?? null
        : null;
      if (!scene) {
        const error = new Error(`Scene "${safeOutline.title}" could not be assembled`);
        Object.assign(error, { isRetryable: true });
        throw error;
      }
      const assembledMissingTools = findMissingRequiredTeachingTools(safeOutline, {
        sceneType: scene.type,
        content: scene.content,
        actions: scene.actions,
      });
      if (assembledMissingTools.length > 0) {
        const error = new Error(
          `Assembled scene "${safeOutline.title}" is missing required teaching tools: ${assembledMissingTools.join(', ')}`,
        );
        Object.assign(error, { isRetryable: true });
        throw error;
      }
      await options.onSceneCompleted?.(safeOutline, scene, index);
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
        throw contextualizeGenerationError(
          error,
          `Scene ${index + 1}/${outlines.length} "${safeOutline.title}" failed`,
        );
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
  if (qualityResult.report.corrections.length > 0) {
    log.warn(`Course quality corrections: ${qualityResult.report.corrections.join(' | ')}`);
  }
  if (qualityResult.report.warnings.length > 0) {
    log.warn(`Course quality warnings: ${qualityResult.report.warnings.join(' | ')}`);
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
    qualityReport: qualityResult.report,
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
