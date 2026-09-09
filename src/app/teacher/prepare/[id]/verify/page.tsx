"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  List,
  Map,
  Network,
  RotateCw,
  Save,
  X,
  Zap,
  Check,
  RefreshCw,
  Plus,
  Sparkles,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { normalizeKnowledgeGraphForDisplay } from "@/components/knowledge-graph";
import { KnowledgeGraphFlow } from "@/components/knowledge-graph-flow";
import { WizardStepper } from "@/components/wizard-stepper";
import { Card, FlowActionBar, Pill, PrimaryButton, toast } from "@/components/ui";
import { ProjectCoverImage } from "@/components/visuals";
import { generateProjectSkeleton, type ProjectSkeletonResult } from "@/lib/teaching-ai/client-api";
import { useSession, useCourse, useHydrated } from "@/lib/session/store";
import type {
  Course,
  CourseContent,
  KnowledgeGraph,
  LessonOutlineSection,
  OpenMaicSceneOutlineSnapshot,
  TeachingOutlineSection,
} from "@/lib/session/types";
import { DEFAULT_EVALUATION_FLOWS } from "@/lib/session/types";
import { resolveDimensionRole } from "@/lib/evaluation/responsibility";
import type {
  CourseGenerationMode,
  SceneOutline,
} from "@/lib/openmaic/types/generation";
import { normalizeTeachingToolPlan } from "@/lib/openmaic/generation/teaching-tool-plan";
import type { AgentInfo } from "@/lib/openmaic/generation/generation-pipeline";
import { I18nProvider } from "@/lib/openmaic/hooks/use-i18n";
import { OutlinesEditor } from "@/components/openmaic/generation/outlines-editor";
import { cn } from "@/lib/utils";
import {
  DEFAULT_PBL_EVIDENCE_REQUIREMENTS,
  DEFAULT_PBL_OUTCOME,
  normalizePblCourseConfig,
} from "@/lib/pbl-course-config";
import { resolvePreparationGenerationMode } from "@/lib/courses/preparation-navigation";
import {
  buildPblCourseRequirement,
  buildCourseTeachingConstraints,
  buildPblActivityCatalog,
  buildTeacherActivityRequirements,
} from "@/lib/openmaic/pbl/course-request";
import {
  buildPblModuleTimingPlan,
  buildPblProjectMainline,
  formatPblProjectMainline,
  isPblModuleTimingPlanConfirmed,
  PBL_MODULE_DEFINITIONS,
  reallocatePblStageDurations,
  rescalePblDetailDurations,
  type PblTimeActivity,
} from "@/lib/pbl-time-model";
import { validatePblKnowledgeAlignment } from "@/lib/pbl-outline-validation";
import {
  assessKnowledgeGraphQuality,
  normalizeKnowledgePointName,
} from "@/lib/knowledge-graph-quality";
import {
  applyConfirmedPblTimingPlan,
  assessPblTeachingOutlineStructure,
  createPblTimingSkeleton,
  normalizePblTeachingOutline,
} from "@/lib/pbl-outline-normalization";
import { PblModuleTimingPanel } from "@/components/teacher/pbl-module-timing-panel";
import { TeachingToolRunbook } from "@/components/teacher/teaching-tool-runbook";
import { useSettingsStore } from "@/lib/openmaic/store/settings";
import { getTtsTimingProfile } from "@/lib/openmaic/audio/tts-timing";
import {
  buildCourseBasicsPatch,
  createCourseBasicsDraft,
  getEmptyCourseBasicsSuggestionParts,
  parseLearningObjectives,
  validateCourseBasicsDraft,
  type CourseBasicsSuggestionPart,
  type CourseBasicsDraft,
} from "@/lib/teacher/course-basics-draft";
import { buildCourseGenerationInput } from "@/lib/teacher/course-generation-input";
import { AiGenerationOverlay, type AiTaskKind } from "@/components/ai-generation-overlay";
import {
  CourseGenerationGlyph,
} from "@/components/course-workshop-animation";
import { AdaptiveLearningPlanEditor } from "@/components/teacher/adaptive-learning-plan-editor";
import { PreparationJourney } from "@/components/teacher/preparation-journey";
import {
  PREPARATION_FLOW_STEPS,
  type PreparationStepKey,
} from "@/lib/teacher/preparation-flow";
import { confirmAdaptiveLearningPlan, evaluateAdaptiveLearningPlanQuality } from "@/lib/adaptive-learning";
import { FastCourseGenerator } from "@/components/teacher/fast-course-generator";
import type { StageGenerationCardData } from "@/components/teacher/stage-generation-card-stack";

// ===== SceneOutline ↔ LessonOutlineSection 转换 =====
function sceneOutlineToLessonSection(
  outline: SceneOutline,
  index: number,
  stageKeys: string[],
): LessonOutlineSection {
  return {
    id: outline.id,
    stageKey:
      outline.stageKey && stageKeys.includes(outline.stageKey)
        ? outline.stageKey
        : stageKeys[Math.min(index, stageKeys.length - 1)] ?? "ai-learning",
    title: outline.title,
    objectives: outline.keyPoints ?? [],
    activities: outline.description ? [outline.description] : [],
    durationMin: Math.max(
      1,
      Math.round((outline.targetDurationSec ?? outline.estimatedDuration ?? 300) / 60),
    ),
    parentActivityId: outline.parentActivityId,
    detailKind: outline.detailKind,
    knowledgePointIds: outline.knowledgePointIds ?? [],
    resourceTypes: outline.resourceTypes,
    targetDurationSec: outline.targetDurationSec,
    segmentIndex: outline.segmentIndex,
    segmentCount: outline.segmentCount,
    segmentRole: outline.segmentRole,
    segmentGroupId: outline.segmentGroupId,
    ttsPolicy: outline.ttsPolicy,
    timingPlan: outline.timingPlan,
    narrationMode: outline.narrationMode,
    teachingToolPlan: outline.teachingToolPlan,
  };
}

function lessonSectionToSceneOutline(
  section: LessonOutlineSection,
  index: number,
): SceneOutline {
  return {
    id: section.id,
    type: "slide",
    title: section.title,
    description: section.activities.join("；") || section.title,
    keyPoints: section.objectives,
    estimatedDuration: section.durationMin * 60,
    stageKey: section.stageKey,
    parentActivityId: section.parentActivityId,
    detailKind: section.detailKind,
    knowledgePointIds: section.knowledgePointIds,
    resourceTypes: section.resourceTypes,
    targetDurationSec: section.targetDurationSec ?? section.durationMin * 60,
    segmentIndex: section.segmentIndex,
    segmentCount: section.segmentCount,
    segmentRole: section.segmentRole,
    segmentGroupId: section.segmentGroupId,
    ttsPolicy: section.ttsPolicy,
    timingPlan: section.timingPlan,
    narrationMode: section.narrationMode,
    teachingToolPlan: section.teachingToolPlan,
    order: index,
  };
}

const SCENE_OUTLINE_TYPES = new Set(["slide", "quiz", "interactive", "pbl"]);

function normalizeSceneOutlineSnapshot(outline: unknown, index: number): SceneOutline {
  const raw = outline && typeof outline === "object" ? outline as Record<string, unknown> : {};
  const type = typeof raw.type === "string" && SCENE_OUTLINE_TYPES.has(raw.type)
    ? raw.type
    : "slide";
  return {
    ...raw,
    id: typeof raw.id === "string" && raw.id ? raw.id : `scene-${index + 1}`,
    type: type as SceneOutline["type"],
    title: typeof raw.title === "string" && raw.title ? raw.title : `Scene ${index + 1}`,
    description:
      typeof raw.description === "string" && raw.description
        ? raw.description
        : typeof raw.title === "string"
          ? raw.title
          : `Scene ${index + 1}`,
    keyPoints: Array.isArray(raw.keyPoints)
      ? raw.keyPoints.filter((x): x is string => typeof x === "string")
      : [],
    estimatedDuration:
      typeof raw.estimatedDuration === "number" ? raw.estimatedDuration : 300,
    order: index,
    parentActivityId:
      typeof raw.parentActivityId === "string" && raw.parentActivityId.trim()
        ? raw.parentActivityId.trim()
        : undefined,
    detailKind:
      typeof raw.detailKind === "string"
        ? (raw.detailKind as SceneOutline["detailKind"])
        : undefined,
    knowledgePointIds: Array.isArray(raw.knowledgePointIds)
      ? raw.knowledgePointIds.filter(
          (x): x is string => typeof x === "string" && Boolean(x.trim()),
        )
      : [],
    resourceTypes: Array.isArray(raw.resourceTypes)
      ? raw.resourceTypes.filter(
          (x): x is NonNullable<SceneOutline["resourceTypes"]>[number] =>
            typeof x === "string" &&
            [
              "ppt",
              "interactive-demo",
              "code-interactive",
              "script",
              "worksheet",
              "rubric",
              "project-brief",
            ].includes(x),
        )
      : undefined,
    targetDurationSec:
      typeof raw.targetDurationSec === "number" && Number.isFinite(raw.targetDurationSec)
        ? Math.max(0, Math.round(raw.targetDurationSec))
        : undefined,
    segmentIndex:
      typeof raw.segmentIndex === "number" && Number.isFinite(raw.segmentIndex)
        ? Math.max(1, Math.round(raw.segmentIndex))
        : undefined,
    segmentCount:
      typeof raw.segmentCount === "number" && Number.isFinite(raw.segmentCount)
        ? Math.max(1, Math.round(raw.segmentCount))
        : undefined,
    segmentRole:
      typeof raw.segmentRole === "string" && raw.segmentRole.trim()
        ? raw.segmentRole.trim()
        : undefined,
    segmentGroupId:
      typeof raw.segmentGroupId === "string" && raw.segmentGroupId.trim()
        ? raw.segmentGroupId.trim()
        : undefined,
    ttsPolicy:
      raw.ttsPolicy === "none" || raw.ttsPolicy === "target-duration"
        ? raw.ttsPolicy
        : undefined,
    narrationMode:
      raw.narrationMode === "embedded-segment" || raw.narrationMode === "standalone-course"
        ? raw.narrationMode
        : undefined,
    teachingToolPlan: normalizeTeachingToolPlan(raw.teachingToolPlan),
  } as SceneOutline;
}

function cloneSceneOutlinesForSession(
  outlines: SceneOutline[],
): OpenMaicSceneOutlineSnapshot[] {
  return outlines.map((outline, index) => {
    const normalized = normalizeSceneOutlineSnapshot(JSON.parse(JSON.stringify(outline)), index);
    return normalized as unknown as OpenMaicSceneOutlineSnapshot;
  });
}

function contentToSceneOutlines(content?: CourseContent): SceneOutline[] {
  if (content?._openmaicSceneOutlines?.length) {
    return content._openmaicSceneOutlines.map((outline, index) =>
      normalizeSceneOutlineSnapshot(outline, index),
    );
  }
  return (content?.lessonOutline ?? []).map((section, index) =>
    lessonSectionToSceneOutline(section, index),
  );
}

function ensureKnowledgeGraph(content: CourseContent): KnowledgeGraph {
  return normalizeKnowledgeGraphForDisplay(content.knowledgeGraph, content.knowledgePoints);
}

function syncGraphNodeFromPoint(content: CourseContent, pointId: string): CourseContent {
  const graph = ensureKnowledgeGraph(content);
  const point = content.knowledgePoints.find((item) => item.id === pointId);
  if (!point) return content;
  return {
    ...content,
    knowledgeGraph: {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === pointId
          ? {
              ...node,
              label: point.name,
              description: point.description,
              keyInfo: point.keyInfo,
              masteryBoundary: point.masteryBoundary,
              objectiveIndexes: point.objectiveIndexes,
              instructionalRole: "lesson",
            }
          : node,
      ),
    },
  };
}

const STEPS = [
  { key: "verify", label: "备课阶段" },
  { key: "generate", label: "生成课程" },
  { key: "preview", label: "预览发布" },
];

type Section = "knowledgePoints" | "teachingOutline" | "lessonOutline" | "evaluationPlan";

const SECTION_LABEL: Record<Section, string> = {
  knowledgePoints: "知识图谱",
  teachingOutline: "课程模块",
  lessonOutline: "主课脚本",
  evaluationPlan: "评价方案",
};

export default function VerifyCoursePage() {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { user, updateCourse } = useSession();
  const course = useCourse(params?.id);
  const hydrated = useHydrated();
  const ttsProviderId = useSettingsStore((state) => state.ttsProviderId);
  const ttsVoice = useSettingsStore((state) => state.ttsVoice);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const ttsProviderConfig = ttsProvidersConfig[ttsProviderId];
  const ttsModelId = ttsProviderConfig?.modelId || "";
  const ttsVoiceId = ttsProviderConfig?.defaultVoice || ttsVoice || "default";
  const ttsTimingProfile = getTtsTimingProfile(ttsProviderId, ttsModelId, ttsVoiceId);
  const [content, setContent] = useState<CourseContent | undefined>();
  const [busy, setBusy] = useState<Section | "all" | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [skeleton, setSkeleton] = useState<ProjectSkeletonResult | null>(null);
  const [skeletonLoading, setSkeletonLoading] = useState(false);
  const [activeSuggestionPart, setActiveSuggestionPart] = useState<CourseBasicsSuggestionPart | "all" | null>(null);
  const [suggestionParts, setSuggestionParts] = useState<CourseBasicsSuggestionPart[]>([]);
  const [learnerProfileOpen, setLearnerProfileOpen] = useState(false);
  const [baseDraft, setBaseDraft] = useState<CourseBasicsDraft | null>(null);
  const initializedDraftCourseIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!course || initializedDraftCourseIdRef.current === course.id) return;
    initializedDraftCourseIdRef.current = course.id;
    setBaseDraft(createCourseBasicsDraft(course));
    setSkeleton(null);
    setActiveSuggestionPart(null);
    setSuggestionParts([]);
    setLearnerProfileOpen(false);
  }, [course]);

  function editBaseDraft(patch: Partial<CourseBasicsDraft>) {
    if (!course) return;
    setBaseDraft((current) => ({
      ...(current ?? createCourseBasicsDraft(course)),
      ...patch,
    }));
  }

  function updateDrivingQuestion(index: number, value: string) {
    const draft = baseDraft ?? (course ? createCourseBasicsDraft(course) : null);
    if (!draft) return;
    if (index !== 0) return;
    editBaseDraft({ drivingQuestions: [value] });
  }

  function addDrivingQuestion(value = "") {
    editBaseDraft({ drivingQuestions: [value] });
  }

  async function requestSkeleton(
    part: CourseBasicsSuggestionPart | "all",
  ) {
    if (!course) return;
    const draft = baseDraft ?? createCourseBasicsDraft(course);
    const requestedParts = part === "all" ? getEmptyCourseBasicsSuggestionParts(draft) : [part];
    if (requestedParts.length === 0) {
      toast.success("课程信息已填写完整", { description: "如需调整某项内容，可以直接编辑对应字段。" });
      return;
    }
    setActiveSuggestionPart(part);
    setSkeletonLoading(true);
    try {
      const result = await generateProjectSkeleton({
        courseName: draft.name,
        subject: draft.subject,
        grade: draft.grade,
        hours: draft.hours,
        summary: draft.summary,
        initialDrivingQuestion: draft.drivingQuestions.find((question) => question.trim()) ?? "",
        learningObjectives: parseLearningObjectives(draft.learningObjectivesText),
        learnerProfile: {
          priorKnowledge: draft.priorKnowledge,
          learningNeeds: draft.learningNeeds,
          familiarContexts: draft.familiarContexts,
        },
        targetPart: part === "all" ? undefined : part,
      });
      setSkeleton((current) => {
        if (part === "all" || !current) return result;
        return {
          ...current,
          ...(part === "learningObjectives" ? { learningObjectiveOptions: result.learningObjectiveOptions } : {}),
          ...(part === "summary" ? { summaryOptions: result.summaryOptions } : {}),
          ...(part === "learnerProfile" ? { learnerProfileOptions: result.learnerProfileOptions } : {}),
          ...(part === "drivingQuestions" ? { drivingQuestions: result.drivingQuestions.slice(0, 1) } : {}),
        };
      });
      setSuggestionParts((current) => Array.from(new Set([...current, ...requestedParts])));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "AI 建议生成失败";
      toast.error("AI 建议生成失败", { description: message });
    } finally {
      setSkeletonLoading(false);
      setActiveSuggestionPart(null);
    }
  }

  async function refreshSkeletonPart(
    part: CourseBasicsSuggestionPart,
  ) {
    await requestSkeleton(part);
  }

  function closeSkeletonPart(part: CourseBasicsSuggestionPart) {
    setSuggestionParts((current) => current.filter((item) => item !== part));
  }

  function addTeacherRequiredKnowledgePoint() {
    const name = requiredKnowledgePointDraft.trim();
    if (!name) return;
    setContent((current) => {
      if (!current) return current;
      const existing = current.teacherRequiredKnowledgePoints ?? [];
      if (existing.some((point) => normalizeKnowledgePointName(point) === normalizeKnowledgePointName(name))) {
        toast.error("这个知识点已经添加");
        return current;
      }
      if (existing.length >= 12) {
        toast.error("教师指定知识点最多添加 12 个");
        return current;
      }
      return { ...current, teacherRequiredKnowledgePoints: [...existing, name] };
    });
    setRequiredKnowledgePointDraft("");
  }

  function removeTeacherRequiredKnowledgePoint(name: string) {
    setContent((current) => current
      ? {
          ...current,
          teacherRequiredKnowledgePoints: (current.teacherRequiredKnowledgePoints ?? []).filter(
            (point) => point !== name,
          ),
        }
      : current);
  }

  const [flowStepKey, setFlowStepKey] = useState<PreparationStepKey>("base");
  const [detailedModeRequested, setDetailedModeRequested] = useState(false);
  const generationMode = resolvePreparationGenerationMode(pathname) === "detailed"
    || detailedModeRequested
    ? "detailed"
    : "quick";
  // 知识图谱视图状态
  const [kgViewMode, setKgViewMode] = useState<"graph" | "list">("graph");
  const [kgSelectedNode, setKgSelectedNode] = useState<string | null>(null);
  const [kgFullscreen, setKgFullscreen] = useState(false);
  const [requiredKnowledgePointDraft, setRequiredKnowledgePointDraft] = useState("");
  // OpenMAIC outline 流式生成状态
  const [outlineStreaming, setOutlineStreaming] = useState(false);
  const [streamHasFirstOutline, setStreamHasFirstOutline] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // OpenMAIC SceneOutline[] 状态：OutlinesEditor 直接编辑此数组
  const [sceneOutlines, setSceneOutlines] = useState<SceneOutline[]>([]);
  const [lessonGenerationMode, setLessonGenerationMode] = useState<CourseGenerationMode>("standard");
  const [outlineFocusRequest, setOutlineFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const stageKeys = useMemo(
    () => (course?.stages ?? []).map((s) => s.key),
    [course?.stages],
  );
  const persistContentSnapshot = useCallback((
    nextContent: CourseContent,
    outlines: SceneOutline[] = sceneOutlines,
  ): CourseContent | null => {
    if (!course) return null;
    const draftToSave = baseDraft ?? createCourseBasicsDraft(course);
    const snapshot = outlines.length > 0
      ? {
          ...nextContent,
          lessonOutline: outlines.map((outline, index) =>
            sceneOutlineToLessonSection(outline, index, stageKeys),
          ),
          _openmaicSceneOutlines: cloneSceneOutlinesForSession(outlines),
        }
      : nextContent;
    updateCourse(course.id, {
      ...buildCourseBasicsPatch(course, draftToSave),
      content: snapshot,
    });
    return snapshot;
  }, [baseDraft, course, sceneOutlines, stageKeys, updateCourse]);
  const pblTimeContext = useMemo(
    () => ({
      topic: course?.name,
      subject: course?.subject,
      summary: course?.summary,
      grade: course?.grade,
      difficulty: course?.pblConfig?.difficultyLevel,
      learningObjectives: course?.learningObjectives,
      learnerProfile: course?.learnerProfile,
      knowledgePoints: content?.knowledgePoints,
      knowledgeGraph: content?.knowledgeGraph,
    }),
    [
      content?.knowledgeGraph,
      content?.knowledgePoints,
      course?.grade,
      course?.name,
      course?.pblConfig?.difficultyLevel,
      course?.learningObjectives,
      course?.learnerProfile,
      course?.subject,
      course?.summary,
    ],
  );
  const pblKnowledgeValidation = useMemo(
    () =>
      validatePblKnowledgeAlignment(
        sceneOutlines
          .filter((outline) => outline.stageKey === "ai-learning" || outline.audience === "student")
          .map((outline) => ({
            id: outline.id,
            title: outline.title,
            stageKey: outline.stageKey,
            knowledgePointIds: outline.knowledgePointIds,
          })),
        content?.knowledgePoints ?? [],
        { requireReferences: true, requireCoverage: true },
      ),
    [content?.knowledgePoints, sceneOutlines],
  );

  // sceneOutlines → content.lessonOutline 同步
  const syncLessonOutline = useCallback(
    (outlines: SceneOutline[]) => {
      setContent((c) =>
        c
          ? {
              ...c,
              lessonOutline: outlines.map((o, i) =>
                sceneOutlineToLessonSection(o, i, stageKeys),
              ),
              _openmaicSceneOutlines: cloneSceneOutlinesForSession(outlines),
            }
          : c,
      );
    },
    [stageKeys],
  );

  const applyTeachingOutlineChange = useCallback(
    (nextTeachingOutline: TeachingOutlineSection[]) => {
      const totalMinutes = Math.max(0, Math.round((course?.hours ?? 0) * 60));
      const nextTimingPlan = nextTeachingOutline.length > 0
        ? buildPblModuleTimingPlan(totalMinutes, nextTeachingOutline, pblTimeContext, {
            status: "suggested",
            preserveCurrentDurations: true,
            recommendationMetadata: content?.moduleTimingPlan
              ? {
                  recommendationSource: content.moduleTimingPlan.recommendationSource,
                  confidence: content.moduleTimingPlan.confidence,
                  rationaleByStage: content.moduleTimingPlan.rationaleByStage,
                  evidence: content.moduleTimingPlan.evidence,
                  assumptions: content.moduleTimingPlan.assumptions,
                }
              : undefined,
          })
        : undefined;
      const validActivityIds = new Set(nextTeachingOutline.map((activity) => activity.id));
      const nextDetails = rescalePblDetailDurations(
        sceneOutlines.filter(
          (outline) => !outline.parentActivityId || validActivityIds.has(outline.parentActivityId),
        ),
        nextTeachingOutline,
      );
      setSceneOutlines(nextDetails);
      setContent((current) =>
        current
          ? {
              ...current,
              teachingOutline: nextTeachingOutline,
              projectMainline: undefined,
              /* pblOutline:
                mainline && (!current.pblOutline.trim() || current.pblOutline.startsWith("项目主线（"))
                  ? formatPblProjectMainline(mainline)
                  : current.pblOutline, */
              pblOutline: "",
              lessonOutline: nextDetails.map((outline, index) =>
                sceneOutlineToLessonSection(outline, index, stageKeys),
              ),
              _openmaicSceneOutlines: cloneSceneOutlinesForSession(nextDetails),
              moduleTimingPlan: nextTimingPlan,
            }
          : current,
      );
    },
    [content, course?.hours, pblTimeContext, sceneOutlines, stageKeys],
  );

  const applyPblStageDurationChange = useCallback(
    (kind: Exclude<PblTimeActivity["activityKind"], undefined | "other">, targetMinutes: number) => {
      const activities = content?.teachingOutline ?? [];
      const nextTeachingOutline = reallocatePblStageDurations(
        Math.max(0, Math.round((course?.hours ?? 0) * 60)),
        activities,
        kind,
        targetMinutes,
        pblTimeContext,
      );
      applyTeachingOutlineChange(nextTeachingOutline);
    },
    [applyTeachingOutlineChange, content?.teachingOutline, course?.hours, pblTimeContext],
  );

  const confirmModuleTiming = useCallback(async () => {
    if (!course) return;
    const currentContent = content ?? course.content;
    const activities = currentContent.teachingOutline ?? [];
    const totalMinutes = Math.max(0, Math.round((course?.hours ?? 0) * 60));
    const moduleTimingPlan = buildPblModuleTimingPlan(
      totalMinutes,
      activities,
      pblTimeContext,
      {
        status: "confirmed",
        preserveCurrentDurations: true,
        recommendationMetadata: currentContent.moduleTimingPlan
          ? {
              recommendationSource: currentContent.moduleTimingPlan.recommendationSource,
              confidence: currentContent.moduleTimingPlan.confidence,
              rationaleByStage: currentContent.moduleTimingPlan.rationaleByStage,
              evidence: currentContent.moduleTimingPlan.evidence,
              assumptions: currentContent.moduleTimingPlan.assumptions,
            }
          : { recommendationSource: "teacher" },
      },
    );
    if (!isPblModuleTimingPlanConfirmed(moduleTimingPlan)) {
      const message = "请先完成六个模块的时间分配，并确保模块合计等于课程总时长。";
      setError(message);
      toast.error("课程时间尚未确认", { description: message });
      return;
    }

    const confirmedContent: CourseContent = {
      ...currentContent,
      moduleTimingPlan,
      projectMainline: undefined,
      pblOutline: "",
      lessonOutline: [],
      _openmaicSceneOutlines: undefined,
    };
    setContent(confirmedContent);
    persistContentSnapshot(confirmedContent, []);
    setSceneOutlines([]);
    setBusy("teachingOutline");
    setError(undefined);
    setInfo("时间安排已确认，正在按最终时间生成 PBL 项目主线和课程模块…");

    try {
      const timingSpine = {
        ...buildPblProjectMainline(totalMinutes, moduleTimingPlan.allocations),
        generatedAt: moduleTimingPlan.confirmedAt ?? new Date().toISOString(),
      };
      const res = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "teachingOutline",
          input: buildCourseGenerationInput(course),
          context: {
            pblOutline: currentContent.pblOutline,
            knowledgePoints: currentContent.knowledgePoints,
            knowledgeGraph: currentContent.knowledgeGraph,
            projectMainline: timingSpine,
            moduleTimingPlan,
          },
        }),
      });
      if (!res.ok) {
        let detail = `课程模块生成失败（HTTP ${res.status}）`;
        try {
          const body = (await res.json()) as { detail?: string; error?: string };
          detail = body.detail || body.error || detail;
        } catch {
          // 响应非 JSON，保留默认错误。
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as { content: CourseContent; source: "llm" };
      const generatedModules = applyConfirmedPblTimingPlan(
        data.content.teachingOutline ?? [],
        moduleTimingPlan,
        { totalMinutes, ...pblTimeContext },
      );
      const structureIssues = assessPblTeachingOutlineStructure(generatedModules);
      if (structureIssues.length > 0) {
        throw new Error(`课程模块结构校验失败：${structureIssues.map((issue) => issue.message).join("；")}`);
      }
      const projectMainline = {
        ...buildPblProjectMainline(totalMinutes, generatedModules),
        generatedAt: new Date().toISOString(),
      };
      if (projectMainline.allocatedMinutes !== totalMinutes) {
        throw new Error(`课程模块时间校验失败：模块合计 ${projectMainline.allocatedMinutes} 分钟，课程总时长 ${totalMinutes} 分钟。`);
      }
      const nextContent: CourseContent = {
        ...currentContent,
        pblOutline: data.content.pblOutline?.trim() || formatPblProjectMainline(projectMainline),
        teachingOutline: generatedModules,
        moduleTimingPlan,
        projectMainline,
        lessonOutline: [],
        _openmaicSceneOutlines: undefined,
      };
      setContent(nextContent);
      persistContentSnapshot(nextContent, []);
      setInfo("已按教师确认的时间安排生成 PBL 项目主线和六个课程模块。");
    } catch (e) {
      const message = (e as Error).message || "PBL 项目主线和课程模块生成失败";
      setError(message);
      setInfo(undefined);
      toast.error("课程模块生成失败", { description: message });
    } finally {
      setBusy(null);
    }
  }, [content, course, pblTimeContext, persistContentSnapshot]);

  // Initialize content from course when loaded
  useEffect(() => {
    if (!course || content) return;
    const totalMinutes = Math.max(0, Math.round(course.hours * 60));
    const baseTeachingOutline = course.content.teachingOutline ?? [];
    const teachingOutline = course.pblConfig?.generationTemplate === "pbl-six-stage"
      ? normalizePblTeachingOutline(baseTeachingOutline, {
          totalMinutes,
          topic: course.name,
          subject: course.subject,
          summary: course.summary,
          grade: course.grade,
          difficulty: course.pblConfig?.difficultyLevel ?? "standard",
          learningObjectives: course.learningObjectives,
          learnerProfile: course.learnerProfile,
          knowledgePoints: course.content.knowledgePoints,
          knowledgeGraph: course.content.knowledgeGraph,
          applyTimeModel: Boolean(course.content.projectMainline),
        })
      : baseTeachingOutline;
    const hasModules = teachingOutline.length > 0;
    const initialTimingPlan = hasModules
      ? course.content.moduleTimingPlan ?? buildPblModuleTimingPlan(
          totalMinutes,
          teachingOutline,
          {
            topic: course.name,
            subject: course.subject,
            summary: course.summary,
            grade: course.grade,
            difficulty: course.pblConfig?.difficultyLevel ?? "standard",
            learningObjectives: course.learningObjectives,
            learnerProfile: course.learnerProfile,
            knowledgePoints: course.content.knowledgePoints,
            knowledgeGraph: course.content.knowledgeGraph,
          },
        )
      : undefined;
    const plannedTeachingOutline = initialTimingPlan
      ? teachingOutline.map((activity) => ({
          ...activity,
          durationMin: initialTimingPlan.allocations.find((item) => item.id === activity.id)?.durationMin
            ?? activity.durationMin,
        }))
      : teachingOutline;
    const initialDetails = hasModules
      ? rescalePblDetailDurations(
          contentToSceneOutlines({ ...course.content, teachingOutline: plannedTeachingOutline }),
          plannedTeachingOutline,
        )
      : [];
    const initialPlanIsConfirmed = initialTimingPlan
      ? isPblModuleTimingPlanConfirmed(initialTimingPlan)
      : false;
    const projectMainline = initialPlanIsConfirmed
      ? course.content.projectMainline
      : undefined;
    const initialContent: CourseContent = {
      ...course.content,
      teachingOutline: plannedTeachingOutline,
      projectMainline,
      moduleTimingPlan: initialTimingPlan,
      lessonOutline: initialDetails.map((outline, index) =>
        sceneOutlineToLessonSection(outline, index, stageKeys),
      ),
      _openmaicSceneOutlines: initialDetails.length
        ? cloneSceneOutlinesForSession(initialDetails)
        : undefined,
    };
    setContent(initialContent);
    setSceneOutlines(initialDetails);
  }, [course, content, stageKeys]);

  const generateSection = useCallback(
    async (section: Section) => {
      if (!course) return;
      setBusy(section);
      setError(undefined);
      setInfo(undefined);
      try {
        if (
          section === "teachingOutline"
          && course.pblConfig?.generationTemplate === "pbl-six-stage"
        ) {
          const totalMinutes = Math.max(0, Math.round(course.hours * 60));
          const currentContent = content ?? course.content;
          let timingSkeleton = createPblTimingSkeleton({
            totalMinutes,
            ...pblTimeContext,
          });
          let moduleTimingPlan = buildPblModuleTimingPlan(
            totalMinutes,
            timingSkeleton,
            pblTimeContext,
            {
              status: "suggested",
              preserveCurrentDurations: true,
              recommendationMetadata: {
                recommendationSource: "deterministic-fallback",
                confidence: "medium",
                evidence: [
                  `课程总时长 ${totalMinutes} 分钟`,
                  `年级：${course.grade}`,
                  `课程难度：${course.pblConfig?.difficultyLevel ?? "standard"}`,
                  `知识点数量：${currentContent.knowledgePoints.length}`,
                ],
                assumptions: [
                  "当前建议由确定性课程时间模型生成；大模型不可用时用于保证六阶段完整和总时长守恒。",
                ],
              },
            },
          );
          let fallbackReason = "";
          try {
            const timingResponse = await fetch("/api/llm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "moduleTimingPlan",
                input: buildCourseGenerationInput(course),
                context: {
                  knowledgePoints: currentContent.knowledgePoints,
                  knowledgeGraph: currentContent.knowledgeGraph,
                },
              }),
            });
            if (!timingResponse.ok) {
              let detail = `HTTP ${timingResponse.status}`;
              try {
                const body = await timingResponse.json() as { detail?: string; error?: string };
                detail = body.detail || body.error || detail;
              } catch {
                // Keep the status-only reason when the upstream body is not JSON.
              }
              throw new Error(detail);
            }
            const timingData = await timingResponse.json() as {
              content: CourseContent;
              source: "llm";
            };
            const generatedPlan = timingData.content.moduleTimingPlan;
            const generatedSkeleton = timingData.content.teachingOutline ?? [];
            if (!generatedPlan || generatedSkeleton.length !== PBL_MODULE_DEFINITIONS.length) {
              throw new Error("模型未返回完整的六阶段时间建议");
            }
            moduleTimingPlan = generatedPlan;
            timingSkeleton = generatedSkeleton;
          } catch (timingError) {
            fallbackReason = timingError instanceof Error
              ? timingError.message
              : "模型时间建议不可用";
          }
          const nextContent: CourseContent = {
            ...currentContent,
            pblOutline: "",
            teachingOutline: timingSkeleton,
            projectMainline: undefined,
            moduleTimingPlan,
            lessonOutline: [],
            _openmaicSceneOutlines: undefined,
          };
          setContent(nextContent);
          persistContentSnapshot(nextContent, []);
          setSceneOutlines([]);
          setInfo(
            fallbackReason
              ? `大模型时间分析暂不可用（${fallbackReason}），已明确降级为确定性建议。请调整并确认后继续生成课程。`
              : "已由大模型结合课程内容、难度、知识图谱与学情生成六阶段时间建议；系统已完成总时长和阶段边界校验。",
          );
          return;
        }
        const action =
          section === "knowledgePoints"
            ? "knowledgeGraph"
            : section === "teachingOutline"
              ? "teachingOutline"
              : section === "lessonOutline"
                ? "lessonOutline"
                : "evaluationPlan";
        const res = await fetch("/api/llm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            input: buildCourseGenerationInput(course),
            context: content
              ? {
                  pblOutline: content.pblOutline,
                  teacherRequiredKnowledgePoints: content.teacherRequiredKnowledgePoints,
                  knowledgePoints: content.knowledgePoints,
                  knowledgeGraph: content.knowledgeGraph,
                  projectMainline: content.projectMainline,
                  teachingOutline: content.teachingOutline,
                  lessonOutline: content.lessonOutline,
                }
              : undefined,
          }),
        });
        if (!res.ok) {
          let detail = `生成失败（HTTP ${res.status}）`;
          try {
            const errBody = (await res.json()) as { detail?: string; error?: string };
            if (errBody?.detail) detail = errBody.detail;
            else if (errBody?.error) detail = errBody.error;
          } catch {
            // 响应非 JSON，保留默认错误
          }
          throw new Error(detail);
        }
        const data = (await res.json()) as {
          content: CourseContent;
          source: "llm";
        };
        const previousContent = content ?? course.content;
        const totalMinutes = Math.max(0, Math.round(course.hours * 60));
        const previousTeachingOutline = previousContent.teachingOutline ?? [];
        const generatedKnowledgePoints =
          section === "knowledgePoints"
            ? data.content.knowledgePoints
            : previousContent.knowledgePoints;
        const generatedKnowledgeGraph =
          section === "knowledgePoints"
            ? data.content.knowledgeGraph
            : previousContent.knowledgeGraph;
        const knowledgeAlignedTeachingOutline =
          section === "knowledgePoints" &&
          course.pblConfig?.generationTemplate === "pbl-six-stage" &&
          previousTeachingOutline.length > 0
            ? normalizePblTeachingOutline(previousTeachingOutline, {
                totalMinutes,
                topic: course.name,
                subject: course.subject,
                summary: course.summary,
                grade: course.grade,
                difficulty: course.pblConfig?.difficultyLevel ?? "standard",
                learningObjectives: course.learningObjectives,
                learnerProfile: course.learnerProfile,
                knowledgePoints: generatedKnowledgePoints,
                knowledgeGraph: generatedKnowledgeGraph,
                applyTimeModel: Boolean(previousContent.projectMainline),
              })
            : undefined;
        const knowledgeAlignedPlan = knowledgeAlignedTeachingOutline && knowledgeAlignedTeachingOutline.length > 0
          ? buildPblModuleTimingPlan(totalMinutes, knowledgeAlignedTeachingOutline, {
              topic: course.name,
              subject: course.subject,
              summary: course.summary,
              grade: course.grade,
              difficulty: course.pblConfig?.difficultyLevel ?? "standard",
              learningObjectives: course.learningObjectives,
              learnerProfile: course.learnerProfile,
              knowledgePoints: generatedKnowledgePoints,
              knowledgeGraph: generatedKnowledgeGraph,
            })
          : undefined;
        const knowledgeAlignedOutline = knowledgeAlignedPlan
          ? knowledgeAlignedTeachingOutline!.map((activity) => ({
              ...activity,
              durationMin: knowledgeAlignedPlan.allocations.find((item) => item.id === activity.id)?.durationMin
                ?? activity.durationMin,
            }))
          : knowledgeAlignedTeachingOutline;
        const rawGeneratedTeachingOutline = data.content.teachingOutline ?? [];
        const generatedTeachingOutline =
          course.pblConfig?.generationTemplate === "pbl-six-stage"
            && rawGeneratedTeachingOutline.length > 0
            ? normalizePblTeachingOutline(rawGeneratedTeachingOutline, {
                totalMinutes,
                topic: course.name,
                subject: course.subject,
                summary: course.summary,
                grade: course.grade,
                difficulty: course.pblConfig?.difficultyLevel ?? "standard",
                learningObjectives: course.learningObjectives,
                learnerProfile: course.learnerProfile,
                knowledgePoints: generatedKnowledgePoints,
                knowledgeGraph: generatedKnowledgeGraph,
              })
            : rawGeneratedTeachingOutline;
        const generatedTimingPlan = generatedTeachingOutline.length > 0
          ? buildPblModuleTimingPlan(totalMinutes, generatedTeachingOutline, {
              topic: course.name,
              subject: course.subject,
              summary: course.summary,
              grade: course.grade,
              difficulty: course.pblConfig?.difficultyLevel ?? "standard",
              learningObjectives: course.learningObjectives,
              learnerProfile: course.learnerProfile,
              knowledgePoints: generatedKnowledgePoints,
              knowledgeGraph: generatedKnowledgeGraph,
            })
          : undefined;
        const plannedTeachingOutline = generatedTimingPlan
          ? generatedTeachingOutline.map((activity) => ({
              ...activity,
              durationMin: generatedTimingPlan.allocations.find((item) => item.id === activity.id)?.durationMin
                ?? activity.durationMin,
            }))
          : generatedTeachingOutline;
        const nextContent: CourseContent = {
          ...previousContent,
          ...(section === "knowledgePoints"
            ? {
                knowledgePoints: data.content.knowledgePoints,
                knowledgeGraph: data.content.knowledgeGraph,
                teachingOutline:
                  course.pblConfig?.generationTemplate === "pbl-six-stage"
                    ? knowledgeAlignedOutline ?? []
                    : previousTeachingOutline,
                projectMainline: undefined,
                moduleTimingPlan:
                  course.pblConfig?.generationTemplate === "pbl-six-stage"
                    ? knowledgeAlignedPlan
                    : undefined,
                lessonOutline: [],
                _openmaicSceneOutlines: undefined,
              }
            : {}),
          ...(section === "teachingOutline"
              ? {
                pblOutline: "",
                teachingOutline: plannedTeachingOutline,
                projectMainline: undefined,
                moduleTimingPlan: generatedTimingPlan,
                lessonOutline: [],
                _openmaicSceneOutlines: undefined,
              }
            : {}),
          ...(section === "lessonOutline"
            ? { lessonOutline: data.content.lessonOutline }
            : {}),
          ...(section === "evaluationPlan"
            ? { evaluationPlan: data.content.evaluationPlan }
            : {}),
        };
        setContent(nextContent);
        if (section === "knowledgePoints" || section === "teachingOutline") {
          setSceneOutlines([]);
        }
        if (section === "lessonOutline") {
          const generatedDetails = (data.content.lessonOutline ?? []).map((item, index) =>
            normalizeSceneOutlineSnapshot(lessonSectionToSceneOutline(item, index), index),
          );
          setSceneOutlines(generatedDetails);
          persistContentSnapshot(nextContent, generatedDetails);
        } else {
          persistContentSnapshot(nextContent, []);
        }
      } catch (e) {
        setError((e as Error).message || "生成失败");
      } finally {
        setBusy(null);
      }
    },
    [course, content, pblTimeContext, persistContentSnapshot],
  );

  // ===== 课程大纲 AI 生成 =====
  // 调用 AI 生成接口，逐条推送课程大纲内容，
  // 使用 OutlinesEditor 呈现，与课堂生成流程一致。
  const generateLessonOutlineOpenMAIC = useCallback(async () => {
    if (!course) return;
    const currentContent = content ?? course.content;
    if (
      !currentContent.moduleTimingPlan
      || !isPblModuleTimingPlanConfirmed(currentContent.moduleTimingPlan)
    ) {
      const message = "请先确认六个模块的时间，再生成课程大纲。";
      setError(message);
      toast.error("课程时间尚未确认", { description: message });
      return;
    }
    const structureIssues = assessPblTeachingOutlineStructure(
      currentContent.teachingOutline ?? [],
    );
    if (!currentContent.projectMainline || structureIssues.length > 0) {
      const message = structureIssues[0]?.message
        ? `课程模块结构无效：${structureIssues[0].message}`
        : "请先根据已确认的时间安排生成 PBL 项目主线和课程模块。";
      setError(message);
      toast.error("PBL 项目主线尚未就绪", { description: message });
      return;
    }
    // 中止上一次流式生成
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setOutlineStreaming(true);
    setStreamHasFirstOutline(false);
    setError(undefined);
    setInfo(undefined);
    setBusy("lessonOutline");

    const requirement = buildPblCourseRequirement(
      course,
      content ?? course.content,
      sceneOutlines,
    );

    // P0 优化：注入教师上下文（与 OpenMAIC 一致）
    // formatTeacherPersonaForPrompt 会从 agents 中提取 teacher 角色的人设，
    // 注入到生成 prompt 中，引导 LLM 适配教师的教学风格与语气。
    // 注：prompt 模板使用英文，persona 也用英文以避免翻译歧义。
    const teacherName = user?.name || "教师";
    const teacherPersona = [
      "Teaching style: PBL facilitator who drives inquiry and collaboration through driving questions.",
      `Subject expertise: ${course.subject || "Interdisciplinary"}.`,
      `Target audience: ${course.grade || "students"}.`,
      "Pedagogy: student-centered, emphasizes real-world inquiry and practice, encourages cross-disciplinary thinking and progressive scaffolding.",
    ].join("\n");
    const agents: AgentInfo[] = [
      {
        id: "teacher",
        name: teacherName,
        role: "teacher",
        persona: teacherPersona,
      },
    ];

    // P0 优化：注入学生画像（与 OpenMAIC 一致）
    // OpenMAIC 的 scene-outlines-stream 路由会从 requirements.userNickname/userBio
    // 构建 "## Student Profile" 文本块，引导 LLM 根据学生背景调整难度与示例。
    // OpenPBL 中由教师代为生成课程，因此从课程信息推导目标学生受众的画像。
    const userNickname = `${course.grade || ""}学生`.trim() || undefined;
    const userBioParts: string[] = [];
    if (course.subject) userBioParts.push(`${course.subject}学科学生`);
    if (course.name) userBioParts.push(`正在学习"${course.name}"课程`);
    if (course.drivingQuestion)
      userBioParts.push(`项目驱动问题：${course.drivingQuestion}`);
    const userBio = userBioParts.join("；") || undefined;

    try {
      const res = await fetch("/api/openmaic/generate/scene-outlines-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requirements: {
            requirement,
            generationMode: lessonGenerationMode,
            pblProfile: course.pblConfig,
            moduleTimingPlan: (content ?? course.content).moduleTimingPlan,
            pblTeachingActivities: buildTeacherActivityRequirements(content ?? course.content),
            pblActivityCatalog: buildPblActivityCatalog(content ?? course.content),
            knowledgePoints: (content ?? course.content).knowledgePoints.map((point) => ({
              id: point.id,
              name: point.name,
            })),
            teachingConstraints: buildCourseTeachingConstraints(course, content ?? course.content),
            userNickname,
            userBio,
            webSearch: false,
            taskEngineMode: false,
            ttsTimingContext: {
              providerId: ttsProviderId,
              modelId: ttsModelId,
              voiceId: ttsVoiceId,
              cjkCharsPerMinute: ttsTimingProfile.cjkCharsPerMinute,
              latinWordsPerMinute: ttsTimingProfile.latinWordsPerMinute,
              calibrated: ttsTimingProfile.source === "configured",
            },
          },
          agents,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(
          (errBody as { error?: string }).error ||
            `课程大纲生成失败（HTTP ${res.status}）`,
        );
      }

      if (!res.body) throw new Error("未收到生成流");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const collected: SceneOutline[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const trimmed = frame.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (evt.type === "outline" && evt.data) {
            // 直接收集 SceneOutline，保留 type/keyPoints/quizConfig 等完整字段
            const outline = normalizeSceneOutlineSnapshot(evt.data, collected.length);
            outline.order = collected.length;
            collected.push(outline);
            setStreamHasFirstOutline(true);
            // 实时更新 OutlinesEditor
            setSceneOutlines([...collected]);
            // 同步到 content.lessonOutline
            syncLessonOutline(collected);
            persistContentSnapshot(currentContent, collected);
          } else if (evt.type === "done") {
            // 若流式未推送单条事件，从 done 批量加载
            const outlines = (evt.outlines as SceneOutline[]) ?? [];
            if (outlines.length > 0) {
              setStreamHasFirstOutline(true);
              collected.splice(0, collected.length);
              for (let i = 0; i < outlines.length; i++) {
                const outline = normalizeSceneOutlineSnapshot(outlines[i], i);
                outline.order = i;
                collected.push(outline);
              }
              setSceneOutlines([...collected]);
              syncLessonOutline(collected);
              persistContentSnapshot(currentContent, collected);
            }
            setInfo(`课程大纲已生成并自动保存（共 ${collected.length} 个资源）`);
          } else if (evt.type === "error") {
            throw new Error((evt.error as string) ?? "课程大纲生成失败");
          }
        }
      }

      if (collected.length === 0) {
        setInfo("AI 暂未返回内容，请稍后重试或检查设置中的 AI 配置。");
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setInfo("已取消生成");
      } else {
        setError((e as Error).message || "课程大纲生成失败");
      }
    } finally {
      setOutlineStreaming(false);
      setBusy(null);
      abortRef.current = null;
    }
  }, [
    course,
    user,
    syncLessonOutline,
    persistContentSnapshot,
    content,
    sceneOutlines,
    lessonGenerationMode,
    ttsProviderId,
    ttsModelId,
    ttsVoiceId,
    ttsTimingProfile,
  ]);

  // 组件卸载时中止流式生成
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // 当 content.lessonOutline 被 legacy generate("all") 更新后，
  // 且 sceneOutlines 为空时，从 LessonOutlineSection 反向同步到 SceneOutline
  useEffect(() => {
    if (outlineStreaming) return; // 流式生成中不反向同步
    if (sceneOutlines.length > 0) return; // 已有 OpenMAIC 数据，不覆盖
    const outlines = contentToSceneOutlines(content);
    if (outlines.length === 0) return;
    setSceneOutlines(outlines);
  }, [content, outlineStreaming, sceneOutlines.length]);

  function buildPersistableContent(
    adaptiveLearningPlanOverride?: CourseContent["adaptiveLearningPlan"],
  ): CourseContent | null {
    if (!content) return null;
    const teachingOutline = content.teachingOutline ?? [];
    const totalMinutes = Math.max(0, Math.round((course?.hours ?? 0) * 60));
    const currentPlan = content.moduleTimingPlan;
    const confirmed = currentPlan?.status === "confirmed"
      && isPblModuleTimingPlanConfirmed(currentPlan);
    const moduleTimingPlan = teachingOutline.length > 0
      ? buildPblModuleTimingPlan(totalMinutes, teachingOutline, pblTimeContext, {
          status: confirmed ? "confirmed" : "suggested",
          preserveCurrentDurations: true,
          now: currentPlan?.generatedAt,
        })
      : undefined;
    const projectMainline = moduleTimingPlan && confirmed
      ? content.projectMainline
      : undefined;
    const nextContent: CourseContent = {
      ...content,
      teachingOutline,
      projectMainline,
      moduleTimingPlan,
      adaptiveLearningPlan: adaptiveLearningPlanOverride ?? content.adaptiveLearningPlan,
    };
    return sceneOutlines.length > 0
      ? {
          ...nextContent,
          lessonOutline: sceneOutlines.map((outline, index) =>
            sceneOutlineToLessonSection(outline, index, stageKeys),
          ),
          _openmaicSceneOutlines: cloneSceneOutlinesForSession(sceneOutlines),
        }
      : nextContent;
  }

  function saveDraft({
    adaptiveLearningPlanOverride,
    allowIncomplete = false,
  }: {
    adaptiveLearningPlanOverride?: CourseContent["adaptiveLearningPlan"];
    allowIncomplete?: boolean;
  } = {}): CourseContent | null {
    if (!course) return null;
    const draftToSave = baseDraft ?? createCourseBasicsDraft(course);
    const validationError = validateCourseBasicsDraft(draftToSave);
    if (validationError && !allowIncomplete) {
      toast.error(validationError);
      setFlowStepKey("base");
      return null;
    }
    const nextContent = buildPersistableContent(adaptiveLearningPlanOverride);
    if (!nextContent) return null;
    updateCourse(course.id, {
      ...buildCourseBasicsPatch(course, draftToSave),
      content: nextContent,
    });
    return nextContent;
  }

  function navigateToFlowStep(target: PreparationStepKey) {
    if (target === flowStepKey) return;
    saveDraft({ allowIncomplete: true });
    setError(undefined);
    setInfo(undefined);
    setFlowStepKey(target);
  }

  function isStepReady(section: Section | null): boolean {
    if (!content) return false;
    if (!section) return true;
    if (section === "knowledgePoints") return knowledgeGraphQuality.ok;
    if (section === "teachingOutline") {
      const structureIssues = assessPblTeachingOutlineStructure(content.teachingOutline ?? []);
      const mainline = content.projectMainline;
      const mainlineValid = Boolean(
        mainline
        && mainline.totalMinutes === Math.max(0, Math.round((course?.hours ?? 0) * 60))
        && mainline.allocatedMinutes === mainline.totalMinutes
        && mainline.modules.length === PBL_MODULE_DEFINITIONS.length
        && mainline.modules.every(
          (module, index) => module.stageKey === PBL_MODULE_DEFINITIONS[index]?.stageKey,
        ),
      );
      return Boolean(
        content.teachingOutline?.length === PBL_MODULE_DEFINITIONS.length
        && structureIssues.length === 0
        && content.moduleTimingPlan?.status === "confirmed"
        && isPblModuleTimingPlanConfirmed(content.moduleTimingPlan)
        && mainlineValid,
      );
    }
    if (section === "lessonOutline") return sceneOutlines.length > 0 || content.lessonOutline.length > 0;
    return content.evaluationPlan.dimensions.length > 0;
  }

  function isPreparationStepReady(stepKey: PreparationStepKey): boolean {
    if (!course) return false;
    if (stepKey === "base") {
      return !validateCourseBasicsDraft(
        baseDraft ?? createCourseBasicsDraft(course),
      );
    }
    if (stepKey === "projectDesign") {
      const currentDraft = baseDraft ?? createCourseBasicsDraft(course);
      return Boolean(
        currentDraft.drivingQuestions.some((question) => question.trim())
        && currentDraft.outcomeArtifact.trim()
        && currentDraft.outcomePresentation.trim()
        && currentDraft.outcomeReflection.trim(),
      );
    }
    if (stepKey === "adaptiveLearning") {
      const plan = content?.adaptiveLearningPlan;
      if (!plan) return false;
      if (!plan.enabled) return true;
      return plan.branches.filter((branch) => branch.enabled !== false).every((branch) =>
          branch.trigger?.placement === "before-main-course"
            ? (branch.prerequisiteKnowledgePointIds?.length ?? 0) > 0
              && Boolean(branch.noveltyStatement?.trim())
            : branch.trigger?.afterSceneId
            ? sceneOutlines.some((scene) => scene.id === branch.trigger?.afterSceneId)
            : (branch.trigger?.assessmentSceneIds?.length ?? 0) > 0
              && branch.trigger!.assessmentSceneIds!.every((id) =>
                sceneOutlines.some((scene) => scene.id === id && scene.type === "quiz"),
              ),
        );
    }
    return isStepReady(stepKey);
  }

  function persistAndNext() {
    if (!course) return;
    const requiredSections: Section[] = [
      "knowledgePoints",
      "evaluationPlan",
      "teachingOutline",
      "lessonOutline",
    ];
    const missing = requiredSections.find((section) => !isStepReady(section));
    if (missing) {
      const message = `请先完成并保存${SECTION_LABEL[missing]}，再进入课程生成。`;
      setError(message);
      toast.error("备课阶段尚未完成", { description: message });
      setFlowStepKey(missing);
      return;
    }
    const knowledgeIssues = pblKnowledgeValidation.issues;
    if (knowledgeIssues.length > 0) {
      const message = knowledgeIssues[0]?.message ?? "课程大纲尚未完成知识点关联。";
      setError(message);
      toast.error("请先校验课程大纲", { description: message });
      setFlowStepKey("lessonOutline");
      return;
    }
    const missingParents = sceneOutlines.filter(
      (outline) => !outline.parentActivityId || !content?.teachingOutline?.some((activity) => activity.id === outline.parentActivityId),
    );
    if (missingParents.length > 0) {
      const message = `有 ${missingParents.length} 个课程大纲资源未关联课程模块，请补充父模块后再生成课程。`;
      setError(message);
      toast.error("课程大纲层级不完整", { description: message });
      setFlowStepKey("lessonOutline");
      return;
    }
    const adaptivePlan = content?.adaptiveLearningPlan;
    if (!adaptivePlan) {
      const message = "请进入个性化学习路径步骤生成方案，并确认是否启用学习证据编排。";
      setError(message);
      toast.error("个性化学习路径尚未建模", { description: message });
      setFlowStepKey("adaptiveLearning");
      return;
    }
    const adaptiveQuality = evaluateAdaptiveLearningPlanQuality(adaptivePlan, {
      knowledgePoints: content?.knowledgePoints ?? [],
      mainScenes: sceneOutlines.map((scene) => ({
        id: scene.id,
        title: scene.title,
        type: scene.type,
        order: scene.order,
        stageKey: scene.stageKey,
        audience: scene.audience,
        knowledgePointIds: scene.knowledgePointIds,
      })),
    });
    if (adaptivePlan.enabled && !adaptiveQuality.passed) {
      const message = `个性化路径尚未达到课程级质量要求：${adaptiveQuality.issues.join("；")}。`;
      setError(message);
      toast.error("个性化路径尚未闭环", { description: message });
      setFlowStepKey("adaptiveLearning");
      return;
    }
    if (
      adaptivePlan.enabled
      && adaptivePlan.branches.some((branch) => branch.enabled !== false && (
        branch.trigger?.placement === "before-main-course"
          ? (branch.prerequisiteKnowledgePointIds?.length ?? 0) === 0 || !branch.noveltyStatement?.trim()
          : branch.trigger?.afterSceneId
          ? !sceneOutlines.some((scene) => scene.id === branch.trigger?.afterSceneId)
            || !branch.noveltyStatement?.trim()
          : (branch.trigger?.assessmentSceneIds?.length ?? 0) === 0
            || branch.trigger!.assessmentSceneIds!.some((id) =>
              !sceneOutlines.some((scene) => scene.id === id && scene.type === "quiz"),
            )
            || !branch.noveltyStatement?.trim()
      ))
    ) {
      const message = "仍有课后拓展资源没有关联唯一的主课达标测，请完成学习证据配置。";
      setError(message);
      toast.error("触发点尚未绑定", { description: message });
      setFlowStepKey("adaptiveLearning");
      return;
    }
    const confirmedAdaptivePlan = confirmAdaptiveLearningPlan(adaptivePlan);
    const nextContent = saveDraft({ adaptiveLearningPlanOverride: confirmedAdaptivePlan });
    if (!nextContent) return;
    setContent(nextContent);
    router.push(`/teacher/prepare/${course.id}/generate`);
  }

  if (!hydrated) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中…</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link className="mt-4 text-[var(--pbl-teacher)] hover:underline" href="/teacher/templates">
            返回课程列表
          </Link>
        </div>
      </DashboardShell>
    );
  }

  const draft = baseDraft ?? createCourseBasicsDraft(course);
  const emptySkeletonParts = getEmptyCourseBasicsSuggestionParts(draft);
  const knowledgeGraphQuality = assessKnowledgeGraphQuality(
    content?.knowledgeGraph,
    content?.knowledgePoints ?? [],
    content?.teacherRequiredKnowledgePoints ?? [],
    {
      objectiveCount: course.learningObjectives?.length ?? 0,
      requireSemanticReview: true,
      minimumPrerequisites: 1,
    },
  );
  const prerequisiteKnowledgeNodes = content?.knowledgeGraph?.nodes.filter(
    (node) => node.instructionalRole === "prerequisite",
  ) ?? [];
  const completedPreparationKeys = PREPARATION_FLOW_STEPS
    .filter((step) => isPreparationStepReady(step.key))
    .map((step) => step.key);
  const currentFlowIndex = PREPARATION_FLOW_STEPS.findIndex(
    (step) => step.key === flowStepKey,
  );
  const currentFlowStep =
    PREPARATION_FLOW_STEPS[currentFlowIndex] ?? PREPARATION_FLOW_STEPS[0];
  const nextFlowStep =
    currentFlowIndex >= 0
      ? PREPARATION_FLOW_STEPS[currentFlowIndex + 1]
      : PREPARATION_FLOW_STEPS[1];

  const sections: { key: Section; node: React.ReactNode }[] = [
    {
      key: "teachingOutline",
      node: (
        <div className="space-y-4">
          <PblModuleTimingPanel
            moduleActivities={content?.teachingOutline ?? []}
            totalMinutes={Math.max(0, Math.round((course?.hours ?? 0) * 60))}
            timeContext={pblTimeContext}
            timingPlan={content?.moduleTimingPlan}
            readOnly={busy === "teachingOutline"}
            onChangeModuleDuration={applyPblStageDurationChange}
            onBatchChangeDurations={(durations) => {
              // 直接更新指定模块的时长，不触发 reallocatePblStageDurations 全局重分配
              const outline = content?.teachingOutline ?? [];
              if (outline.length === 0) return;
              const nextOutline = outline.map((activity) => {
                const newMinutes = durations[activity.id];
                return newMinutes !== undefined
                  ? { ...activity, durationMin: newMinutes }
                  : activity;
              });
              applyTeachingOutlineChange(nextOutline);
            }}
            onApplyRecommendation={(allocations) => {
              const activities = content?.teachingOutline ?? [];
              applyTeachingOutlineChange(
                activities.map((item) => ({
                  ...item,
                  durationMin: allocations[item.id] ?? item.durationMin,
                })),
              );
            }}
            onConfirm={() => void confirmModuleTiming()}
          />
          {content?.projectMainline ? (
            <>
          <div>
            <div className="mb-2 text-sm font-bold text-stone-800">PBL 项目主线说明</div>
              <div className="mb-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {content.projectMainline.modules.map((module) => (
                  <div className="rounded-[6px] border border-stone-200 bg-stone-50 px-3 py-2 text-xs" key={module.stageKey}>
                    <div className="flex items-center justify-between gap-2 font-semibold text-stone-700">
                      <span>{module.label}</span>
                      <span className="tabular-nums text-[var(--pbl-teacher)]">{module.durationMin} 分钟</span>
                    </div>
                    <p className="mt-1 text-stone-500">{module.startMin}-{module.endMin} 分钟</p>
                  </div>
                ))}
              </div>
            <textarea
              className="min-h-[100px] w-full rounded-[6px] border border-stone-300 px-4 py-3 text-[15px] leading-7 outline-none focus:border-[var(--pbl-teacher)]"
              onChange={(e) =>
                setContent((c) =>
                  c ? { ...c, pblOutline: e.target.value } : c,
                )
              }
              placeholder="用于概括驱动问题、项目主线、成果产出和课堂组织方式。"
              value={content?.pblOutline ?? ""}
            />
          </div>

          <div className="grid gap-3">
            {(content?.teachingOutline ?? []).map((section, index) => (
              <div
                className="rounded-[8px] border border-stone-200 bg-white p-4"
                key={section.id}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--pbl-teacher-soft)] text-xs font-bold text-[var(--pbl-teacher)]">
                    {index + 1}
                  </span>
                  <input
                    className="h-10 min-w-[220px] flex-1 rounded-[6px] border border-stone-300 px-3 text-sm font-semibold outline-none focus:border-[var(--pbl-teacher)]"
                    onChange={(e) =>
                      updateTeachingOutlineItem(setContent, section.id, {
                        title: e.target.value,
                      })
                    }
                    value={section.title}
                  />
                  <span className="rounded-[4px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-2.5 py-1.5 text-xs font-semibold tabular-nums text-[var(--pbl-teacher)]">
                    {section.durationMin} 分钟
                  </span>
                  <span className="inline-flex h-10 items-center rounded-[6px] border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-600">
                    {section.stageKey === "ai-learning" ? "学生知识讲授" : "普通课堂活动"}
                  </span>
                  {index >= PBL_MODULE_DEFINITIONS.length ? (
                    <button
                      className="text-sm font-semibold text-stone-400 hover:text-[var(--pbl-danger)]"
                      onClick={() =>
                        applyTeachingOutlineChange(
                          (content?.teachingOutline ?? []).filter(
                            (item) => item.id !== section.id,
                          ),
                        )
                      }
                      type="button"
                    >
                      删除
                    </button>
                  ) : (
                    <span className="text-xs font-semibold text-[var(--pbl-teacher)]">核心模块</span>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <OutlineTextarea
                    label="教学目标"
                    value={section.teachingGoal}
                    onChange={(value) =>
                      updateTeachingOutlineItem(setContent, section.id, {
                        teachingGoal: value,
                      })
                    }
                  />
                  <OutlineTextarea
                    label="学生活动"
                    value={section.studentActivity}
                    onChange={(value) =>
                      updateTeachingOutlineItem(setContent, section.id, {
                        studentActivity: value,
                      })
                    }
                  />
                  <OutlineTextarea
                    label="教师负责"
                    value={section.teacherRole}
                    onChange={(value) =>
                      updateTeachingOutlineItem(setContent, section.id, {
                        teacherRole: value,
                      })
                    }
                  />
                  <OutlineTextarea
                    label="平台与 AI 负责"
                    value={`平台：${section.platformRole}\nAI：${section.aiRole}`}
                    onChange={(value) => {
                      const [platformLine, aiLine] = value.split(/\n/);
                      updateTeachingOutlineItem(setContent, section.id, {
                        platformRole: (platformLine ?? "").replace(/^平台[:：]\s*/, ""),
                        aiRole: (aiLine ?? "").replace(/^AI[:：]\s*/, ""),
                      });
                    }}
                  />
                </div>

              </div>
            ))}
          </div>

            </>
          ) : (
            <div className="rounded-[8px] border border-dashed border-stone-300 bg-stone-50 px-4 py-5 text-sm leading-6 text-stone-600">
              {content?.moduleTimingPlan?.status === "confirmed"
                ? "时间安排已确认。正在生成或等待重新生成 PBL 项目主线与六个课程模块。"
                : "先生成并调整六阶段时间安排；确认后，系统才会根据最终时间和知识图谱生成 PBL 项目主线与课程模块。"}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "knowledgePoints",
      node: (
        <div className="space-y-4">
          <section className="overflow-hidden rounded-[8px] border border-stone-200 bg-stone-50/60">
            <div className="flex items-start gap-3 border-b border-stone-200 bg-white px-4 py-3.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-[6px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]">
                <Network size={17} />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--pbl-teacher)]">生成设置</p>
                <h3 className="mt-0.5 text-sm font-bold text-stone-900">必须涉及的知识点 <span className="font-normal text-stone-400">（可选）</span></h3>
              </div>
            </div>
            <div className="p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                aria-label="输入本课必须涉及的知识点"
                className="h-10 min-w-0 flex-1 rounded-[6px] border border-stone-300 bg-white px-3 text-sm outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]"
                maxLength={50}
                onChange={(event) => setRequiredKnowledgePointDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTeacherRequiredKnowledgePoint();
                  }
                }}
                placeholder="例如：训练数据、分类规则、模型偏差"
                value={requiredKnowledgePointDraft}
              />
              <button
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[6px] border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-700 transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)] disabled:opacity-50"
                disabled={!requiredKnowledgePointDraft.trim()}
                onClick={addTeacherRequiredKnowledgePoint}
                type="button"
              >
                <Plus size={15} /> 添加知识点
              </button>
            </div>
            {(content?.teacherRequiredKnowledgePoints?.length ?? 0) > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {content!.teacherRequiredKnowledgePoints!.map((point, index) => (
                  <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-stone-200 bg-white py-1.5 pl-2.5 pr-1.5 text-xs font-semibold text-stone-700" key={point}>
                    <span className="text-[10px] tabular-nums text-stone-400">{index + 1}</span>
                    {point}
                    <button aria-label={`移除必选知识点 ${point}`} className="grid size-5 place-items-center rounded-full text-stone-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => removeTeacherRequiredKnowledgePoint(point)} type="button"><X size={11} /></button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-stone-400">暂未指定，AI 将依据课程定位和学习目标规划完整知识体系。</p>
            )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 bg-white px-4 py-3">
              <span className="inline-flex items-center gap-1.5 text-xs text-stone-500"><Save size={13} /> 生成结果将自动保存</span>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--pbl-teacher)] px-4 text-sm font-semibold text-white transition hover:brightness-95 disabled:cursor-wait disabled:opacity-60"
                disabled={busy === "knowledgePoints"}
                onClick={() => void generateSection("knowledgePoints")}
                type="button"
              >
                {busy === "knowledgePoints" ? <CourseGenerationGlyph /> : content?.knowledgePoints.length ? <RotateCw size={15} /> : <Network size={15} />}
                {busy === "knowledgePoints"
                  ? "正在编排知识图谱"
                  : content?.knowledgePoints.length
                    ? "根据指定知识点重新生成"
                    : (content?.teacherRequiredKnowledgePoints?.length ?? 0) > 0
                      ? "根据指定知识点生成图谱"
                      : "生成知识图谱"}
              </button>
            </div>
          </section>

          {(content?.knowledgePoints.length ?? 0) > 0 ? (
            <section className={cn(
              "rounded-[8px] border px-4 py-3",
              knowledgeGraphQuality.ok
                ? "border-emerald-200 bg-emerald-50/70"
                : "border-amber-200 bg-amber-50/70",
            )}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={cn("text-sm font-bold", knowledgeGraphQuality.ok ? "text-emerald-800" : "text-amber-900")}>
                  {knowledgeGraphQuality.ok ? "图谱结构校验通过" : "图谱需要进一步校正"}
                </p>
                <span className="text-xs tabular-nums text-stone-600">
                  {content?.knowledgePoints.length ?? 0} 个本课目标 · {knowledgeGraphQuality.stats.prerequisites} 个课前先修 · {knowledgeGraphQuality.stats.edges} 条关系
                </span>
              </div>
              {!knowledgeGraphQuality.ok ? (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-amber-800">
                  {knowledgeGraphQuality.issues.slice(0, 3).map((issue) => <li key={issue}>{issue}</li>)}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-emerald-700">本课目标、课程体系先修和必需依赖已通过独立语义审校；不存在伪造连通关系或无效环路。</p>
              )}
            </section>
          ) : null}

          {prerequisiteKnowledgeNodes.length ? (
            <section className="rounded-[8px] border border-orange-200 bg-orange-50/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-orange-950">课程体系前序知识</p>
                  <p className="mt-1 text-xs leading-5 text-orange-800">这些节点不属于本课教学目标；只有独立审校确认的必需依赖才会进入课前测与逐缺口补学。</p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-orange-800 ring-1 ring-orange-200">{prerequisiteKnowledgeNodes.length} 项</span>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {prerequisiteKnowledgeNodes.map((node) => {
                  const targets = (content?.knowledgeGraph?.edges ?? [])
                    .filter((edge) => edge.source === node.id && edge.type === "required-prerequisite" && edge.strength === "required")
                    .map((edge) => content?.knowledgePoints.find((point) => point.id === edge.target)?.name ?? edge.target);
                  return (
                    <article className="rounded-[7px] border border-orange-100 bg-white p-3" key={node.id}>
                      <p className="text-sm font-bold text-stone-900">{node.label}</p>
                      <p className="mt-1 text-xs leading-5 text-stone-600">{node.description}</p>
                      <dl className="mt-2 space-y-1 text-[11px] leading-5 text-stone-600">
                        <div><dt className="inline font-bold text-stone-800">课前应会依据：</dt><dd className="inline">{node.priorKnowledgeEvidence || "尚未填写"}</dd></div>
                        <div><dt className="inline font-bold text-stone-800">可诊断边界：</dt><dd className="inline">{node.diagnosticBoundary || "尚未填写"}</dd></div>
                        <div><dt className="inline font-bold text-stone-800">直接支撑：</dt><dd className="inline">{targets.join("、") || "尚未建立必需依赖"}</dd></div>
                      </dl>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* 视图切换 */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors",
                kgViewMode === "graph"
                  ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)] border border-[var(--pbl-teacher-border)]"
                  : "text-stone-500 hover:bg-stone-50 border border-transparent",
              )}
              onClick={() => setKgViewMode("graph")}
            >
              <Map size={14} /> 图谱视图
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors",
                kgViewMode === "list"
                  ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)] border border-[var(--pbl-teacher-border)]"
                  : "text-stone-500 hover:bg-stone-50 border border-transparent",
              )}
              onClick={() => setKgViewMode("list")}
            >
              <List size={14} /> 列表视图
            </button>
          </div>

          {kgViewMode === "graph" ? (
            /* ── 图谱视图 ── */
            <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
              <div className="min-h-[520px] overflow-hidden rounded-[16px] border border-stone-200/80 bg-white shadow-[0_14px_40px_rgba(28,25,23,0.06)]">
                <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
                  <div className="flex items-center gap-2 font-bold text-stone-900">
                    <Network size={18} className="text-[var(--pbl-teacher)]" />
                    知识图谱
                  </div>
                  <div className="text-xs text-stone-400">
                    按知识依赖自动排布 · 点击聚焦关系 · 拖动微调
                  </div>
                </div>
                <div className="h-[520px]">
                  <KnowledgeGraphFlow
                    graph={content?.knowledgeGraph}
                    points={content?.knowledgePoints ?? []}
                    height={520}
                    isFullscreen={kgFullscreen}
                    onToggleFullscreen={() => setKgFullscreen((v) => !v)}
                    onNodeSelect={setKgSelectedNode}
                    onNodePositionChange={(nodeId, position) => setContent((current) => current ? { ...current, knowledgeGraph: { ...ensureKnowledgeGraph(current), nodes: ensureKnowledgeGraph(current).nodes.map((node) => node.id === nodeId ? { ...node, position } : node) } } : current)}
                  />
                </div>
              </div>

              {/* 节点详情面板 */}
              <div className="space-y-4">
                {kgSelectedNode ? (() => {
                  const point = content?.knowledgePoints.find((p) => p.id === kgSelectedNode);
                  const graph = content ? ensureKnowledgeGraph(content) : null;
                  const graphNode = graph?.nodes.find((node) => node.id === kgSelectedNode);
                  const upstream = graph?.edges.filter((e) => e.target === kgSelectedNode) ?? [];
                  const downstream = graph?.edges.filter((e) => e.source === kgSelectedNode) ?? [];
                  if (!point && graphNode?.instructionalRole === "prerequisite") {
                    return (
                      <div className="rounded-[8px] border border-orange-200 bg-orange-50/60 p-4">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-orange-700">课前先修节点</p>
                            <h3 className="mt-1 text-sm font-bold text-stone-900">{graphNode.label}</h3>
                          </div>
                          <button className="text-stone-400 hover:text-stone-600" onClick={() => setKgSelectedNode(null)} type="button"><X size={16} /></button>
                        </div>
                        <p className="mt-3 text-xs leading-5 text-stone-700">{graphNode.description}</p>
                        <div className="mt-3 space-y-2 rounded-[7px] bg-white p-3 text-xs leading-5 text-stone-700 ring-1 ring-orange-100">
                          <p><strong>课前应会依据：</strong>{graphNode.priorKnowledgeEvidence || "尚未填写"}</p>
                          <p><strong>可诊断边界：</strong>{graphNode.diagnosticBoundary || "尚未填写"}</p>
                          <p><strong>直接依赖：</strong>{downstream.map((edge) => `${edge.label} → ${graph?.nodes.find((node) => node.id === edge.target)?.label ?? edge.target}`).join("；") || "尚未建立"}</p>
                        </div>
                        <p className="mt-3 text-[11px] leading-5 text-orange-800">先修节点由课程知识结构代理统一生成并独立审校。需要修改时请调整学生已有基础或教师要求后重新生成图谱，避免局部编辑破坏课程衔接证据。</p>
                      </div>
                    );
                  }
                  if (!point) return null;
                  return (
                    <div className="rounded-[8px] border border-stone-200 bg-white">
                      <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
                        <h3 className="text-sm font-bold text-stone-800">节点详情</h3>
                        <button type="button" onClick={() => setKgSelectedNode(null)} className="text-stone-400 hover:text-stone-600">
                          <X size={16} />
                        </button>
                      </div>
                      <div className="space-y-4 p-4">
                        {/* 节点名称 */}
                        <div>
                          <label className="text-xs font-semibold text-stone-500">节点名称</label>
                          <input
                            className="mt-1 h-10 w-full rounded-[6px] border border-stone-300 px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]"
                            value={point.name}
                            onChange={(e) => setContent((c) => {
                              if (!c) return c;
                              const next = { ...c, knowledgePoints: c.knowledgePoints.map((x) => x.id === kgSelectedNode ? { ...x, name: e.target.value } : x) };
                              return syncGraphNodeFromPoint(next, kgSelectedNode);
                            })}
                          />
                        </div>
                        {/* 节点说明 */}
                        <div>
                          <label className="text-xs font-semibold text-stone-500">节点说明</label>
                          <textarea
                            className="mt-1 min-h-[60px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-sm leading-5 outline-none focus:border-[var(--pbl-teacher)] resize-y"
                            value={point.description}
                            placeholder="描述该知识点"
                            onChange={(e) => setContent((c) => {
                              if (!c) return c;
                              const next = { ...c, knowledgePoints: c.knowledgePoints.map((x) => x.id === kgSelectedNode ? { ...x, description: e.target.value } : x) };
                              return syncGraphNodeFromPoint(next, kgSelectedNode);
                            })}
                          />
                        </div>
                        {/* 关键信息 */}
                        <div>
                          <label className="text-xs font-semibold text-stone-500">本课关键信息</label>
                          <textarea
                            className="mt-1 min-h-[60px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-sm leading-5 outline-none focus:border-[var(--pbl-teacher)] resize-y"
                            value={point.keyInfo ?? ""}
                            placeholder="本课需要掌握的关键信息"
                            onChange={(e) => setContent((c) => {
                              if (!c) return c;
                              const next = { ...c, knowledgePoints: c.knowledgePoints.map((x) => x.id === kgSelectedNode ? { ...x, keyInfo: e.target.value } : x) };
                              return syncGraphNodeFromPoint(next, kgSelectedNode);
                            })}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-semibold text-stone-500">课后可观察掌握边界</label>
                          <textarea
                            className="mt-1 min-h-[60px] w-full resize-y rounded-[6px] border border-stone-300 px-3 py-2 text-sm leading-5 outline-none focus:border-[var(--pbl-teacher)]"
                            value={point.masteryBoundary ?? ""}
                            placeholder="例如：能依据新样本解释分类结果，并指出验证证据"
                            onChange={(e) => setContent((c) => {
                              if (!c) return c;
                              const next = { ...c, knowledgePoints: c.knowledgePoints.map((x) => x.id === kgSelectedNode ? { ...x, masteryBoundary: e.target.value } : x) };
                              return syncGraphNodeFromPoint(next, kgSelectedNode);
                            })}
                          />
                        </div>
                        {/* 知识点难度层级 */}
                        <div>
                          <label className="text-xs font-semibold text-stone-500">知识点层级</label>
                          <select
                            className="mt-1 h-10 w-full rounded-[6px] border border-stone-300 bg-white px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]"
                            value={point.level ?? content?.knowledgeGraph?.nodes.find((node) => node.id === point.id)?.level ?? "core"}
                            onChange={(e) => setContent((c) => {
                              if (!c) return c;
                              const level = e.target.value as NonNullable<KnowledgeGraph["nodes"][number]["level"]>;
                              const graph = ensureKnowledgeGraph(c);
                              return {
                                ...c,
                                knowledgePoints: c.knowledgePoints.map((item) => item.id === point.id ? { ...item, level } : item),
                                knowledgeGraph: {
                                  ...graph,
                                  nodes: graph.nodes.map((node) => node.id === point.id ? { ...node, level } : node),
                                },
                              };
                            })}
                          >
                            <option value="foundation">基础</option>
                            <option value="core">核心</option>
                            <option value="application">应用</option>
                            <option value="extension">拓展</option>
                          </select>
                        </div>
                        {/* 上游节点 */}
                        {upstream.length > 0 && (
                          <div>
                            <label className="text-xs font-semibold text-stone-500">上游节点</label>
                            <div className="mt-1 space-y-1">
                              {upstream.map((edge) => {
                                const sourceNode = graph?.nodes.find((node) => node.id === edge.source);
                                const auditedPrerequisiteEdge = sourceNode?.instructionalRole === "prerequisite";
                                return (
                                  <div key={edge.id} className="flex items-center gap-2 rounded-md bg-[var(--pbl-teacher-soft)] px-3 py-1.5 text-xs">
                                    <span className="font-semibold text-[var(--pbl-teacher)]">{sourceNode?.label ?? edge.source}</span>
                                    <span className="text-stone-400">→</span>
                                    {auditedPrerequisiteEdge ? (
                                      <span className="min-w-0 flex-1 rounded border border-orange-100 bg-white px-2 py-1 text-orange-800">
                                        {edge.label} · {edge.strength === "required" ? "必需先修" : "辅助背景"}
                                      </span>
                                    ) : (
                                      <>
                                        <input
                                          className="h-7 min-w-[60px] flex-1 rounded border border-stone-200 bg-white px-2 text-xs outline-none focus:border-[var(--pbl-teacher)]"
                                          value={edge.label || ""}
                                          placeholder="关系说明"
                                          onChange={(e) => setContent((c) => {
                                            if (!c) return c;
                                            const g = ensureKnowledgeGraph(c);
                                            return { ...c, knowledgeGraph: { ...g, edges: g.edges.map((item) => item.id === edge.id ? { ...item, label: e.target.value } : item) } };
                                          })}
                                        />
                                        <button
                                          type="button"
                                          className="ml-auto text-stone-300 hover:text-[var(--pbl-danger)]"
                                          title="删除此关系"
                                          onClick={() => setContent((c) => {
                                            if (!c) return c;
                                            const g = ensureKnowledgeGraph(c);
                                            return { ...c, knowledgeGraph: { ...g, edges: g.edges.filter((item) => item.id !== edge.id) } };
                                          })}
                                        >
                                          <X size={12} />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {/* 下游节点 */}
                        {downstream.length > 0 && (
                          <div>
                            <label className="text-xs font-semibold text-stone-500">下游节点</label>
                            <div className="mt-1 space-y-1">
                              {downstream.map((edge) => {
                                const targetPoint = content?.knowledgePoints.find((p) => p.id === edge.target);
                                return (
                                  <div key={edge.id} className="flex items-center gap-2 rounded-md bg-[var(--pbl-success-soft)] px-3 py-1.5 text-xs">
                                    <input
                                      className="h-7 min-w-[60px] flex-1 rounded border border-stone-200 bg-white px-2 text-xs outline-none focus:border-[var(--pbl-teacher)]"
                                      value={edge.label || ""}
                                      placeholder="关系说明"
                                      onChange={(e) => setContent((c) => {
                                        if (!c) return c;
                                        const g = ensureKnowledgeGraph(c);
                                        return { ...c, knowledgeGraph: { ...g, edges: g.edges.map((item) => item.id === edge.id ? { ...item, label: e.target.value } : item) } };
                                      })}
                                    />
                                    <span className="text-stone-400">→</span>
                                    <span className="font-semibold text-[var(--pbl-success)]">{targetPoint?.name ?? edge.target}</span>
                                    <button
                                      type="button"
                                      className="ml-auto text-stone-300 hover:text-[var(--pbl-danger)]"
                                      title="删除此关系"
                                      onClick={() => setContent((c) => {
                                        if (!c) return c;
                                        const g = ensureKnowledgeGraph(c);
                                        return { ...c, knowledgeGraph: { ...g, edges: g.edges.filter((item) => item.id !== edge.id) } };
                                      })}
                                    >
                                      <X size={12} />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {/* 删除节点按钮 */}
                        <div className="border-t border-stone-100 pt-3">
                          <button
                            type="button"
                            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] px-3 text-xs font-semibold text-[var(--pbl-danger)] hover:bg-[var(--pbl-danger-soft)]"
                            onClick={() => {
                              setContent((c) => {
                                if (!c) return c;
                                const g = ensureKnowledgeGraph(c);
                                return {
                                  ...c,
                                  knowledgePoints: c.knowledgePoints.filter((x) => x.id !== kgSelectedNode),
                                  knowledgeGraph: {
                                    nodes: g.nodes.filter((node) => node.id !== kgSelectedNode),
                                    edges: g.edges.filter((edge) => edge.source !== kgSelectedNode && edge.target !== kgSelectedNode),
                                  },
                                };
                              });
                              setKgSelectedNode(null);
                            }}
                          >
                            <X size={12} /> 删除此节点
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })() : (
                  <div className="rounded-[8px] border border-dashed border-stone-200 bg-stone-50 p-6 text-center text-sm text-stone-500">
                    点击图谱中的节点查看详情
                  </div>
                )}

                {/* 图谱视图下也保留添加节点/关系按钮 */}
                <div className="flex gap-2">
                  <button
                    className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[6px] border border-stone-200 px-3 text-sm font-semibold text-stone-600 hover:bg-stone-50"
                    onClick={() =>
                      setContent((c) => {
                        if (!c) return c;
                        const id = `kp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                        const point = { id, name: "新知识点", description: "", keyInfo: "", masteryBoundary: "", objectiveIndexes: [] };
                        const graph = ensureKnowledgeGraph(c);
                        return {
                          ...c,
                          knowledgePoints: [...c.knowledgePoints, point],
                          knowledgeGraph: { ...graph, nodes: [...graph.nodes, { id, label: point.name, description: "", keyInfo: "", masteryBoundary: "", objectiveIndexes: [], level: "core" as const, instructionalRole: "lesson" as const }] },
                        };
                      })
                    }
                    type="button"
                  >
                    + 添加节点
                  </button>
                  <button
                    className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[6px] border border-stone-200 px-3 text-sm font-semibold text-stone-600 hover:bg-stone-50"
                    disabled={(content?.knowledgePoints.length ?? 0) < 2}
                    onClick={() =>
                      setContent((c) => {
                        if (!c || c.knowledgePoints.length < 2) return c;
                        const graph = ensureKnowledgeGraph(c);
                        return {
                          ...c,
                          knowledgeGraph: {
                            ...graph,
                            edges: [...graph.edges, { id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, source: c.knowledgePoints[0].id, target: c.knowledgePoints[1].id, label: "支撑" }],
                          },
                        };
                      })
                    }
                    type="button"
                  >
                    + 添加关系
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* ── 列表视图 ── */
            <div className="grid gap-5 lg:grid-cols-2">
              {/* 左栏：知识节点 */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-bold text-stone-800">知识节点（{content?.knowledgePoints.length ?? 0}）</div>
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-stone-200 px-2.5 text-xs font-semibold text-stone-600 hover:bg-stone-50"
                    onClick={() =>
                      setContent((c) => {
                        if (!c) return c;
                        const id = `kp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                        const point = { id, name: "新知识点", description: "", keyInfo: "", masteryBoundary: "", objectiveIndexes: [] };
                        const graph = ensureKnowledgeGraph(c);
                        return {
                          ...c,
                          knowledgePoints: [...c.knowledgePoints, point],
                          knowledgeGraph: { ...graph, nodes: [...graph.nodes, { id, label: point.name, description: "", keyInfo: "", masteryBoundary: "", objectiveIndexes: [], level: "core" as const, instructionalRole: "lesson" as const }] },
                        };
                      })
                    }
                    type="button"
                  >
                    + 添加
                  </button>
                </div>
                <div className="space-y-2">
                  {(content?.knowledgePoints ?? []).map((kp) => {
                    const upstreamEdges = content ? ensureKnowledgeGraph(content).edges.filter((e) => e.target === kp.id) : [];
                    const downstreamEdges = content ? ensureKnowledgeGraph(content).edges.filter((e) => e.source === kp.id) : [];
                    return (
                      <div className="rounded-[8px] border border-stone-200 bg-white p-3" key={kp.id}>
                        <div className="flex items-center gap-2">
                          <input
                            className="h-9 min-w-0 flex-1 rounded-[6px] border border-stone-300 px-3 text-sm font-semibold outline-none focus:border-[var(--pbl-teacher)]"
                            onChange={(e) =>
                              setContent((c) => {
                                if (!c) return c;
                                const next = { ...c, knowledgePoints: c.knowledgePoints.map((x) => x.id === kp.id ? { ...x, name: e.target.value } : x) };
                                return syncGraphNodeFromPoint(next, kp.id);
                              })
                            }
                            value={kp.name}
                            placeholder="知识点名称"
                          />
                          <button
                            className="shrink-0 text-xs font-semibold text-stone-400 hover:text-[var(--pbl-danger)]"
                            onClick={() =>
                              setContent((c) => {
                                if (!c) return c;
                                const graph = ensureKnowledgeGraph(c);
                                return {
                                  ...c,
                                  knowledgePoints: c.knowledgePoints.filter((x) => x.id !== kp.id),
                                  knowledgeGraph: {
                                    nodes: graph.nodes.filter((node) => node.id !== kp.id),
                                    edges: graph.edges.filter((edge) => edge.source !== kp.id && edge.target !== kp.id),
                                  },
                                };
                              })
                            }
                            type="button"
                          >
                            删除
                          </button>
                        </div>
                        <div className="mt-2 grid gap-2">
                          <textarea
                            className="min-h-[44px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-xs leading-5 outline-none focus:border-[var(--pbl-teacher)] resize-y"
                            onChange={(e) =>
                              setContent((c) => {
                                if (!c) return c;
                                const next = { ...c, knowledgePoints: c.knowledgePoints.map((x) => x.id === kp.id ? { ...x, description: e.target.value } : x) };
                                return syncGraphNodeFromPoint(next, kp.id);
                              })
                            }
                            placeholder="节点说明"
                            value={kp.description}
                          />
                          <textarea
                            className="min-h-[44px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-xs leading-5 outline-none focus:border-[var(--pbl-teacher)] resize-y"
                            onChange={(e) =>
                              setContent((c) => {
                                if (!c) return c;
                                const next = { ...c, knowledgePoints: c.knowledgePoints.map((x) => x.id === kp.id ? { ...x, keyInfo: e.target.value } : x) };
                                return syncGraphNodeFromPoint(next, kp.id);
                              })
                            }
                            placeholder="本课关键信息"
                            value={kp.keyInfo ?? ""}
                          />
                        </div>
                        {(upstreamEdges.length > 0 || downstreamEdges.length > 0) && (
                          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-stone-100 pt-2">
                            {upstreamEdges.map((edge) => {
                              const src = content?.knowledgePoints.find((p) => p.id === edge.source);
                              return <span key={edge.id} className="inline-flex items-center gap-1 rounded-full bg-[var(--pbl-teacher-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--pbl-teacher)]">{src?.name ?? edge.source} · {edge.label || "支撑"} →</span>;
                            })}
                            {downstreamEdges.map((edge) => {
                              const tgt = content?.knowledgePoints.find((p) => p.id === edge.target);
                              return <span key={edge.id} className="inline-flex items-center gap-1 rounded-full bg-[var(--pbl-success-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--pbl-success)]">→ {tgt?.name ?? edge.target} · {edge.label || "支撑"}</span>;
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 右栏：节点关系 */}
              <div>
                <p className="mb-1 text-xs text-stone-500">选择两个知识点建立关联，如“概念A 是 概念B 的前提”。</p>
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-sm font-bold text-stone-800">节点关系（{content ? ensureKnowledgeGraph(content).edges.length : 0}）</div>
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-stone-200 px-2.5 text-xs font-semibold text-stone-600 hover:bg-stone-50"
                    disabled={(content?.knowledgePoints.length ?? 0) < 2}
                    onClick={() =>
                      setContent((c) => {
                        if (!c || c.knowledgePoints.length < 2) return c;
                        const graph = ensureKnowledgeGraph(c);
                        return {
                          ...c,
                          knowledgeGraph: {
                            ...graph,
                            edges: [...graph.edges, { id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, source: c.knowledgePoints[0].id, target: c.knowledgePoints[1].id, label: "支撑" }],
                          },
                        };
                      })
                    }
                    type="button"
                  >
                    + 添加
                  </button>
                </div>
                <div className="space-y-2">
                  {(content ? ensureKnowledgeGraph(content).edges : []).map((edge) => {
                    const displayGraph = content ? ensureKnowledgeGraph(content) : undefined;
                    const sourceNode = displayGraph?.nodes.find((node) => node.id === edge.source);
                    const targetNode = displayGraph?.nodes.find((node) => node.id === edge.target);
                    const auditedPrerequisiteEdge = sourceNode?.instructionalRole === "prerequisite"
                      || targetNode?.instructionalRole === "prerequisite";
                    if (auditedPrerequisiteEdge) {
                      return (
                        <div key={edge.id} className="rounded-[8px] border border-orange-200 bg-orange-50/60 p-3 text-xs">
                          <div className="flex flex-wrap items-center gap-2 font-semibold text-stone-800">
                            <span>{sourceNode?.label ?? edge.source}</span>
                            <span className="text-orange-500">→</span>
                            <span>{targetNode?.label ?? edge.target}</span>
                            <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[10px] text-orange-800 ring-1 ring-orange-200">
                              {edge.type === "required-prerequisite" && edge.strength === "required" ? "必需先修" : "辅助关系"}
                            </span>
                          </div>
                          <p className="mt-2 text-stone-700">{edge.label}</p>
                          <p className="mt-1 leading-5 text-stone-500">{edge.rationale}</p>
                          <p className="mt-2 text-[10px] text-orange-700">该关系已参与独立审校；如需改变先修边界，请调整课程或学情依据后重新生成知识结构。</p>
                        </div>
                      );
                    }
                    return (
                      <div key={edge.id} className="rounded-[8px] border border-stone-200 bg-stone-50 p-3">
                        {/* 第一行：源节点 → 目标节点 */}
                        <div className="flex items-center gap-2">
                          <select
                            className="h-8 min-w-0 flex-1 rounded-[6px] border border-stone-300 bg-white px-2 text-xs font-semibold text-[var(--pbl-teacher)] outline-none focus:border-[var(--pbl-teacher)]"
                            onChange={(e) => setContent((c) => c ? { ...c, knowledgeGraph: { ...ensureKnowledgeGraph(c), edges: ensureKnowledgeGraph(c).edges.map((item) => item.id === edge.id ? { ...item, source: e.target.value } : item) } } : c)}
                            value={edge.source}
                          >
                            {(content?.knowledgePoints ?? []).map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}
                          </select>
                          <span className="shrink-0 text-stone-400">→</span>
                          <select
                            className="h-8 min-w-0 flex-1 rounded-[6px] border border-stone-300 bg-white px-2 text-xs font-semibold text-[var(--pbl-success)] outline-none focus:border-[var(--pbl-teacher)]"
                            onChange={(e) => setContent((c) => c ? { ...c, knowledgeGraph: { ...ensureKnowledgeGraph(c), edges: ensureKnowledgeGraph(c).edges.map((item) => item.id === edge.id ? { ...item, target: e.target.value } : item) } } : c)}
                            value={edge.target}
                          >
                            {(content?.knowledgePoints ?? []).map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}
                          </select>
                        </div>
                        {/* 第二行：关系说明 + 删除 */}
                        <div className="mt-2 flex items-center gap-2">
                          <span className="shrink-0 text-xs text-stone-500">关系：</span>
                          <input
                            className="h-8 min-w-0 flex-1 rounded-[6px] border border-stone-300 bg-white px-2 text-xs outline-none focus:border-[var(--pbl-teacher)]"
                            onChange={(e) => setContent((c) => c ? { ...c, knowledgeGraph: { ...ensureKnowledgeGraph(c), edges: ensureKnowledgeGraph(c).edges.map((item) => item.id === edge.id ? { ...item, label: e.target.value } : item) } } : c)}
                            placeholder="如：支撑、前提、基础"
                            value={edge.label}
                          />
                          <button className="shrink-0 text-xs font-semibold text-stone-400 hover:text-[var(--pbl-danger)]" onClick={() => setContent((c) => c ? { ...c, knowledgeGraph: { ...ensureKnowledgeGraph(c), edges: ensureKnowledgeGraph(c).edges.filter((item) => item.id !== edge.id) } } : c)} type="button">删除</button>
                        </div>
                      </div>
                    );
                  })}
                  {(content ? ensureKnowledgeGraph(content).edges : []).length === 0 ? (
                    <p className="rounded-[8px] border border-dashed border-stone-200 bg-stone-50/50 px-3 py-4 text-center text-xs text-stone-400">
                      暂无节点关系。点击右上方“添加”可创建知识点之间的关联。
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "lessonOutline",
      node: (
        <div>
          {sceneOutlines.length > 0 || outlineStreaming ? (
            <div className="bg-white">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 bg-white px-5 py-5">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-stone-500">详细大纲</p>
                <h3 className="mt-1 font-editorial text-lg font-semibold text-stone-950">课程页面与教学资源</h3>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-bold tabular-nums">
                <span className="rounded-[6px] border border-sky-200 bg-white px-2.5 py-1.5 text-sky-800">
                  {sceneOutlines.filter((outline) => outline.audience !== "teacher").length} 个学生页面
                </span>
                <span className="rounded-[6px] border border-[var(--pbl-ai-border)] bg-white px-2.5 py-1.5 text-[var(--pbl-ai)]">
                  {sceneOutlines.filter((outline) => outline.audience === "teacher").length} 个教师资源
                </span>
              </div>
            </div>
            <I18nProvider>
            <OutlinesEditor
              outlines={sceneOutlines}
              onChange={(outlines) => {
                setSceneOutlines(outlines);
                syncLessonOutline(outlines);
              }}
              onConfirm={() => {
                syncLessonOutline(sceneOutlines);
                setInfo("课程大纲已保存");
                window.setTimeout(() => setInfo(undefined), 2500);
              }}
              onBack={() => undefined}
              isStreaming={outlineStreaming}
              parentActivities={(content?.teachingOutline ?? []).map((activity) => ({
                id: activity.id,
                title: activity.title,
              }))}
              knowledgePoints={(content?.knowledgePoints ?? []).map((point) => ({
                id: point.id,
                name: point.name,
              }))}
              focusRequest={outlineFocusRequest}
              hideHeader
              hideFooter
              bare
              naturalFlow
              distinguishAudience
              scriptWorkspace
            />
            </I18nProvider>
            </div>
          ) : (
            <div className="mx-5 my-8 rounded-[8px] border border-dashed border-stone-200 px-6 py-10 text-center">
              <p className="text-sm text-stone-500">
                暂无课程大纲。点击上方「AI 生成」按钮，基于课程模块生成资源。
              </p>
              <p className="mt-2 text-xs text-stone-400">
                支持场景类型（幻灯片 / 测验 / 互动 / PBL）、关键知识点、教学目标等结构化编辑。
              </p>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "evaluationPlan",
      node: (
        <div className="space-y-3">
          <section className="border-y border-[var(--pbl-border)] py-4">
            <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="font-semibold">两类计分评价 + 学生非计分反思</h3><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">AI 负责过程与专业性，教师负责现场汇报与通用表现；两部分独立评分后按权重合成。</p></div><span className={cn("text-sm font-semibold", (content?.evaluationPlan.flows ?? DEFAULT_EVALUATION_FLOWS).filter((item) => item.enabled && item.scored !== false).reduce((sum, item) => sum + item.weight, 0) === 100 ? "text-[var(--pbl-success)]" : "text-[var(--pbl-danger)]")}>计分权重合计 {(content?.evaluationPlan.flows ?? DEFAULT_EVALUATION_FLOWS).filter((item) => item.enabled && item.scored !== false).reduce((sum, item) => sum + item.weight, 0)}%</span></div>
            <div className="mt-4 divide-y divide-[var(--pbl-border-soft)]">
              {(content?.evaluationPlan.flows ?? DEFAULT_EVALUATION_FLOWS).filter((flow) => flow.sourceRole !== "peer").map((flow) => <div className="grid gap-3 py-4 md:grid-cols-[180px_100px_1fr] md:items-start" key={flow.id}><div><p className="font-semibold">{flow.name}</p><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">{flow.sourceRole === "ai" ? "过程推进、AI 协作健康度与方案专业性" : flow.sourceRole === "teacher" ? "现场汇报、答辩、呈现与通用能力" : "课程反思与成长总结（不计分）"}</p></div><label className="text-xs text-[var(--pbl-text-muted)]">{flow.scored === false ? "计分状态" : "权重"}{flow.scored === false ? <div className="mt-1 grid min-h-10 place-items-center rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)] text-sm font-semibold">不计分</div> : <input className="mt-1 min-h-10 w-full rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-2 text-sm" max={100} min={0} onChange={(event) => setContent((current) => current ? { ...current, evaluationPlan: { ...current.evaluationPlan, flows: (current.evaluationPlan.flows ?? DEFAULT_EVALUATION_FLOWS).map((item) => item.id === flow.id ? { ...item, weight: Number(event.target.value) || 0 } : item) } } : current)} type="number" value={flow.weight} />}</label><div><p className="text-xs font-semibold text-[var(--pbl-text-muted)]">评价证据</p><div className="mt-2 flex flex-wrap gap-2">{flow.evidenceRequirements.map((evidence) => <span className="rounded-[var(--radius-xs)] border border-[var(--pbl-border)] px-2 py-1 text-xs" key={evidence}>{evidence}</span>)}</div></div></div>)}
            </div>
          </section>
          <h3 className="pt-3 font-semibold">评价维度</h3>
          <div className="overflow-hidden rounded-[6px] border border-stone-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-stone-50 text-stone-500">
                <tr>
                  <th className="p-3">维度</th>
                  <th className="p-3 w-28">负责角色</th>
                  <th className="p-3 w-24">权重</th>
                  <th className="p-3">描述</th>
                  <th className="p-3 w-16" />
                </tr>
              </thead>
              <tbody>
                {(content?.evaluationPlan.dimensions ?? []).map((d) => {
                  return (
                    <tr className="border-b border-stone-100" key={d.id}>
                      <td className="p-3">
                        <input
                          className="h-10 w-full rounded-[6px] border border-stone-300 px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]"
                          onChange={(e) =>
                            setContent((c) =>
                              c
                                ? {
                                    ...c,
                                    evaluationPlan: {
                                      ...c.evaluationPlan,
                                      dimensions: c.evaluationPlan.dimensions.map(
                                        (x) =>
                                          x.id === d.id
                                            ? { ...x, name: e.target.value }
                                            : x,
                                      ),
                                    },
                                  }
                                : c,
                            )
                          }
                          value={d.name}
                        />
                      </td>
                      <td className="p-3">
                        <select
                          aria-label={`${d.name}负责角色`}
                          className="h-10 w-full rounded-[6px] border border-stone-300 bg-white px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]"
                          onChange={(e) =>
                            setContent((c) =>
                              c
                                ? {
                                    ...c,
                                    evaluationPlan: {
                                      ...c.evaluationPlan,
                                      dimensions: c.evaluationPlan.dimensions.map((x) =>
                                        x.id === d.id
                                          ? { ...x, responsibleRole: e.target.value as "ai" | "teacher" }
                                          : x,
                                      ),
                                    },
                                  }
                                : c,
                            )
                          }
                          value={resolveDimensionRole(d)}
                        >
                          <option value="ai">AI</option>
                          <option value="teacher">教师</option>
                        </select>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1">
                          <input
                            className="h-10 w-20 rounded-[6px] border border-stone-300 px-2 text-right text-sm outline-none focus:border-[var(--pbl-teacher)]"
                            max={100}
                            min={0}
                            onChange={(e) =>
                              setContent((c) =>
                                c
                                  ? {
                                      ...c,
                                      evaluationPlan: {
                                        ...c.evaluationPlan,
                                        dimensions: c.evaluationPlan.dimensions.map(
                                          (x) =>
                                            x.id === d.id
                                              ? {
                                                  ...x,
                                                  weight: Number(e.target.value) || 0,
                                                }
                                              : x,
                                        ),
                                      },
                                    }
                                  : c,
                            )
                          }
                          type="number"
                          value={d.weight}
                          />
                          <span className="text-xs text-stone-500">%</span>
                        </div>
                      </td>
                      <td className="p-3">
                        <input
                          className="h-10 w-full rounded-[6px] border border-stone-300 px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]"
                          onChange={(e) =>
                            setContent((c) =>
                              c
                                ? {
                                    ...c,
                                    evaluationPlan: {
                                      ...c.evaluationPlan,
                                      dimensions: c.evaluationPlan.dimensions.map(
                                        (x) =>
                                          x.id === d.id
                                            ? { ...x, description: e.target.value }
                                            : x,
                                      ),
                                    },
                                  }
                                : c,
                            )
                          }
                          value={d.description}
                        />
                      </td>
                      <td className="p-3 text-right">
                        <button
                          className="text-sm font-semibold text-stone-400 hover:text-[var(--pbl-danger)]"
                          onClick={() =>
                            setContent((c) =>
                              c
                                ? {
                                    ...c,
                                    evaluationPlan: {
                                      ...c.evaluationPlan,
                                      dimensions:
                                        c.evaluationPlan.dimensions.filter(
                                          (x) => x.id !== d.id,
                                        ),
                                    },
                                  }
                                : c,
                            )
                          }
                          type="button"
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="p-3 font-semibold" colSpan={1}>
                    合计
                  </td>
                  <td className="p-3 font-semibold">
                    {(content?.evaluationPlan.dimensions ?? []).reduce(
                      (s, x) => s + (Number(x.weight) || 0),
                      0,
                    )}
                    %
                  </td>
                  <td className="p-3" colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-stone-200 px-3 text-sm font-semibold text-stone-600 hover:bg-stone-50"
              onClick={() =>
                setContent((c) =>
                  c
                    ? {
                        ...c,
                        evaluationPlan: {
                          ...c.evaluationPlan,
                          dimensions: [
                            ...c.evaluationPlan.dimensions,
                            {
                              id: "ev-" + (c.evaluationPlan.dimensions.length + 1),
                              name: "新维度",
                              weight: 10,
                              description: "",
                              responsibleRole: "ai",
                            },
                          ],
                        },
                      }
                    : c,
                )
              }
              type="button"
            >
              + 添加评价维度
            </button>
            <textarea
              className="min-h-[60px] flex-1 ml-3 rounded-[6px] border border-stone-200 px-3 py-2 text-sm outline-none focus:border-[var(--pbl-teacher)]"
              onChange={(e) =>
                setContent((c) =>
                  c
                    ? {
                        ...c,
                        evaluationPlan: {
                          ...c.evaluationPlan,
                          overallRubric: e.target.value,
                        },
                      }
                    : c,
                )
              }
              placeholder="整体评价说明（可选）"
              value={content?.evaluationPlan.overallRubric ?? ""}
            />
          </div>
        </div>
      ),
    },
  ];

  // 主课脚本在首条流式内容出现前显示弹窗；首条内容就绪后关闭弹窗，
  // 由页面内 OutlinesEditor 接管后续逐页反馈。
  const aiOverlayKind: AiTaskKind | null = (() => {
    if (!busy) return null;
    if (busy === "lessonOutline" && outlineStreaming) {
      return streamHasFirstOutline ? null : "sceneOutlines";
    }
    if (busy === "knowledgePoints") return "knowledgeGraph";
    if (busy === "teachingOutline") return "teachingOutline";
    if (busy === "lessonOutline") return "lessonOutline";
    if (busy === "evaluationPlan") return "evaluationPlan";
    return "generic";
  })();
  const aiOverlayCards = aiOverlayKind
    ? createGenerationCards(aiOverlayKind, course, content, info)
    : undefined;

  function openDetailedMode() {
    setDetailedModeRequested(true);
  }

  return (
    <DashboardShell
      role="teacher"
      userName={user.name}
      variant="bare"
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
      headerSlot={
        <div className="ml-4">
          <WizardStepper current={0} steps={STEPS} />
        </div>
      }
    >
      {generationMode === "quick" ? (
        <FastCourseGenerator
          course={course}
          onOpenDetailed={openDetailedMode}
          simplified
        />
      ) : (
      <>
      <PreparationJourney
        backHref="/teacher/templates"
        completedKeys={completedPreparationKeys}
        currentKey={flowStepKey}
        onSelect={navigateToFlowStep}
      />

      {error ? (
        <div className="mb-4 rounded-[8px] border border-[var(--pbl-danger-soft)] bg-[var(--pbl-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--pbl-danger)]">
          {error}
        </div>
      ) : null}

      <div className="space-y-4">
        {flowStepKey === "base" || flowStepKey === "projectDesign" ? (
          <div className="space-y-5">
            {/* ── 课程定位 ── */}
            {flowStepKey === "base" ? <Card className="overflow-hidden p-0">
              <div className="grid lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)]">
                <div className="min-w-0 p-5 sm:p-6">
                  <PreparationSectionHeading eyebrow="课程基础信息" title="课程定位" />
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-bold text-stone-800 sm:col-span-2">
                      课程名称
                      <input
                        className="mt-1.5 h-11 w-full rounded-[6px] border border-stone-300 px-3 text-sm font-normal outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]"
                        maxLength={40}
                        value={draft.name}
                        onChange={(event) => editBaseDraft({ name: event.target.value })}
                        placeholder="例如：校园低碳生活解决方案"
                      />
                    </label>
                    <label className="text-sm font-bold text-stone-800 sm:col-span-2">
                      学科
                      <input
                        className="mt-1.5 h-11 w-full rounded-[6px] border border-stone-300 px-3 text-sm font-normal outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]"
                        value={draft.subject}
                        onChange={(event) => editBaseDraft({ subject: event.target.value })}
                        placeholder="人工智能通识课程"
                      />
                    </label>
                    <label className="text-sm font-bold text-stone-800">
                      年级
                      <input
                        className="mt-1.5 h-11 w-full rounded-[6px] border border-stone-300 px-3 text-sm font-normal outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]"
                        value={draft.grade}
                        onChange={(event) => editBaseDraft({ grade: event.target.value })}
                        placeholder="高一"
                      />
                    </label>
                    <label className="text-sm font-bold text-stone-800">
                      预计课时
                      <span className="relative mt-1.5 block">
                        <input
                          className="h-11 w-full rounded-[6px] border border-stone-300 px-3 pr-12 text-sm font-normal outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]"
                          type="number"
                          min={1}
                          max={5}
                          value={draft.hours}
                          onChange={(event) => editBaseDraft({ hours: Number(event.target.value) })}
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-normal text-stone-400">课时</span>
                      </span>
                    </label>
                  </div>
                </div>
                <div className="border-t border-stone-200 bg-stone-100/70 p-4 lg:border-l lg:border-t-0 sm:p-5">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-stone-500">课堂封面</p>
                    <span className="text-xs text-stone-400">16:9</span>
                  </div>
                  <div className="overflow-hidden rounded-[10px] border border-stone-200 bg-white p-2 shadow-sm">
                    <ProjectCoverImage
                      course={{
                        ...course,
                        name: draft.name,
                        subject: draft.subject,
                        grade: draft.grade,
                        summary: draft.summary,
                        drivingQuestion: draft.drivingQuestions.find((question) => question.trim()) ?? "",
                      }}
                      allowGenerate
                      className="aspect-video w-full"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-6 border-t border-stone-200 p-5 sm:p-6">
                <section className="flex flex-col gap-4 rounded-[12px] border border-[var(--pbl-ai-border)] bg-[linear-gradient(105deg,var(--pbl-ai-soft),white_68%)] p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-white text-[var(--pbl-ai)] shadow-sm ring-1 ring-[var(--pbl-ai-border)]">
                      <Sparkles size={18} />
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-stone-900">AI 补全课程信息</h3>
                      <p className="mt-1 text-xs leading-5 text-stone-600">仅为课程目标、课程说明和启发问题中的空白项生成候选，不覆盖已经填写的内容。</p>
                    </div>
                  </div>
                  <button
                    className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-[7px] bg-[var(--pbl-ai)] px-4 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-wait disabled:opacity-60 motion-reduce:transform-none"
                    disabled={skeletonLoading}
                    onClick={() => void requestSkeleton("all")}
                    type="button"
                  >
                    {skeletonLoading && activeSuggestionPart === "all" ? <CourseGenerationGlyph /> : <Sparkles size={15} />}
                    {emptySkeletonParts.length > 0 ? `生成 ${emptySkeletonParts.length} 项空白内容` : "检查空白内容"}
                  </button>
                </section>

                <section>
                  <label className="text-sm font-bold text-stone-800">课程目标</label>
                  <p className="mt-0.5 text-xs text-stone-500">每行一个可观察、可评价的学习目标。</p>
                  <textarea
                    className="mt-2 min-h-[112px] w-full rounded-[6px] border border-stone-300 px-3 py-2.5 text-sm leading-6 outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]"
                    value={draft.learningObjectivesText}
                    onChange={(event) => editBaseDraft({ learningObjectivesText: event.target.value })}
                    placeholder={"解释项目所需的核心概念\n运用证据比较不同方案\n形成并修订可实施的项目成果"}
                  />
                  {skeleton && suggestionParts.includes("learningObjectives") ? (
                    <AiSuggestionPanel loading={skeletonLoading && activeSuggestionPart === "learningObjectives"} onClose={() => closeSkeletonPart("learningObjectives")} onRefresh={() => void refreshSkeletonPart("learningObjectives")}>
                      {skeleton.learningObjectiveOptions.map((option, index) => (
                        <AiSuggestionCard key={index} onAdopt={() => { editBaseDraft({ learningObjectivesText: option.join("\n") }); closeSkeletonPart("learningObjectives"); }}>
                          <ol className="list-decimal space-y-1 pl-4">{option.map((item) => <li key={item}>{item}</li>)}</ol>
                        </AiSuggestionCard>
                      ))}
                    </AiSuggestionPanel>
                  ) : null}
                </section>

                <section>
                  <label className="text-sm font-bold text-stone-800">课程说明</label>
                  <p className="mt-0.5 text-xs text-stone-500">说明真实情境、课程范围和学生需要形成的判断。</p>
                  <textarea
                    className="mt-2 min-h-[112px] w-full rounded-[6px] border border-stone-300 px-3 py-2.5 text-sm leading-6 outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]"
                    value={draft.summary}
                    onChange={(event) => editBaseDraft({ summary: event.target.value })}
                    placeholder="学生将调查什么、接触哪些真实对象、形成怎样的判断？"
                  />
                  {skeleton && suggestionParts.includes("summary") ? (
                    <AiSuggestionPanel loading={skeletonLoading && activeSuggestionPart === "summary"} onClose={() => closeSkeletonPart("summary")} onRefresh={() => void refreshSkeletonPart("summary")}>
                      {skeleton.summaryOptions.map((option, index) => <AiSuggestionCard key={index} onAdopt={() => { editBaseDraft({ summary: option }); closeSkeletonPart("summary"); }}>{option}</AiSuggestionCard>)}
                    </AiSuggestionPanel>
                  ) : null}
                </section>

                <section className="overflow-hidden rounded-[10px] border border-stone-200 bg-stone-50/60">
                  <button
                    aria-expanded={learnerProfileOpen}
                    className="flex w-full items-center justify-between gap-4 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--pbl-teacher)]"
                    onClick={() => setLearnerProfileOpen((open) => !open)}
                    type="button"
                  >
                    <span>
                      <span className="flex items-center gap-2 text-sm font-bold text-stone-800">
                        学生学情与认知边界
                        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-stone-500 ring-1 ring-stone-200">选填</span>
                        {suggestionParts.includes("learnerProfile") ? <span className="rounded-full bg-[var(--pbl-ai-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--pbl-ai)]">AI 候选已就绪</span> : null}
                      </span>
                      <span className="mt-1 block text-xs text-stone-500">默认采用基于学段与学科的保守推断，需要精细控制认知边界时再展开填写。</span>
                    </span>
                    <ChevronDown className={cn("shrink-0 text-stone-400 transition-transform", learnerProfileOpen && "rotate-180")} size={18} />
                  </button>
                  {learnerProfileOpen ? (
                    <div className="border-t border-stone-200 bg-white p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="text-xs leading-5 text-stone-500">此项不会被“一键补全”自动生成，只有在需要时才调用 AI。</p>
                        <button
                          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-[var(--pbl-ai-border)] bg-[var(--pbl-ai-soft)] px-3 text-xs font-semibold text-[var(--pbl-ai)] disabled:cursor-wait disabled:opacity-60"
                          disabled={skeletonLoading}
                          onClick={() => void requestSkeleton("learnerProfile")}
                          type="button"
                        >
                          {skeletonLoading && activeSuggestionPart === "learnerProfile" ? <CourseGenerationGlyph /> : <Sparkles size={12} />}
                          生成学情建议
                        </button>
                      </div>
                      <div className="grid gap-3">
                        <label className="text-xs font-semibold text-stone-600">
                          已有基础
                          <textarea className="mt-1 min-h-[64px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-sm font-normal outline-none focus:border-[var(--pbl-teacher)]" value={draft.priorKnowledge} onChange={(event) => editBaseDraft({ priorKnowledge: event.target.value })} placeholder="例如：理解分类和概率的直观含义" />
                        </label>
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="text-xs font-semibold text-stone-600">
                            学习特点或困难
                            <textarea className="mt-1 min-h-[64px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-sm font-normal outline-none focus:border-[var(--pbl-teacher)]" value={draft.learningNeeds} onChange={(event) => editBaseDraft({ learningNeeds: event.target.value })} placeholder="例如：抽象概念需要图示" />
                          </label>
                          <label className="text-xs font-semibold text-stone-600">
                            熟悉的生活情境
                            <textarea className="mt-1 min-h-[64px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-sm font-normal outline-none focus:border-[var(--pbl-teacher)]" value={draft.familiarContexts} onChange={(event) => editBaseDraft({ familiarContexts: event.target.value })} placeholder="例如：校园生活、短视频推荐" />
                          </label>
                        </div>
                      </div>
                      {skeleton && suggestionParts.includes("learnerProfile") ? (
                        <AiSuggestionPanel loading={skeletonLoading && activeSuggestionPart === "learnerProfile"} onClose={() => closeSkeletonPart("learnerProfile")} onRefresh={() => void refreshSkeletonPart("learnerProfile")}>
                          {skeleton.learnerProfileOptions.map((option, index) => (
                            <AiSuggestionCard key={index} onAdopt={() => { editBaseDraft(option); closeSkeletonPart("learnerProfile"); }}>
                              <div className="space-y-1"><p><b>已有基础：</b>{option.priorKnowledge}</p><p><b>学习特点：</b>{option.learningNeeds}</p><p><b>熟悉情境：</b>{option.familiarContexts}</p></div>
                            </AiSuggestionCard>
                          ))}
                        </AiSuggestionPanel>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                <section>
                  <label className="text-sm font-bold text-stone-800">项目核心驱动问题</label>
                  <p className="mt-0.5 text-xs text-stone-500">只设置一个统领整项学习的真实挑战。知识点问题和技术步骤问题会在后续教学中作为探究线索展开。</p>
                  <textarea aria-label="项目核心驱动问题" className="mt-3 min-h-[82px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--pbl-teacher)]" value={draft.drivingQuestions[0] ?? ""} onChange={(event) => updateDrivingQuestion(0, event.target.value)} placeholder="我们如何为校园图书馆设计一套有证据支持、可验证的图书分类方案？" />
                  {skeleton && suggestionParts.includes("drivingQuestions") ? (
                    <AiSuggestionPanel loading={skeletonLoading && activeSuggestionPart === "drivingQuestions"} onClose={() => closeSkeletonPart("drivingQuestions")} onRefresh={() => void refreshSkeletonPart("drivingQuestions")}>
                      {skeleton.drivingQuestions.map((question, index) => <AiSuggestionCard key={index} onAdopt={() => addDrivingQuestion(question)}>{question}</AiSuggestionCard>)}
                    </AiSuggestionPanel>
                  ) : null}
                </section>
              </div>
            </Card> : null}

            {/* ── 项目成果设计 ── */}
            {flowStepKey === "projectDesign" ? <Card className="overflow-clip p-0">
              <header className="border-b border-stone-200 px-5 py-4">
                <PreparationSectionHeading
                  eyebrow="课程设计"
                  title="项目成果与学习证据"
                />
              </header>
              <div className="grid gap-5 p-5">
                <div>
                  <label className="text-sm font-bold text-stone-800">项目难度</label>
                  <p className="mt-0.5 text-xs text-stone-500">用于预估知识建构、方案校准和项目实践的时间比例。</p>
                  <select
                    className="mt-2 h-10 w-full rounded-[6px] border border-stone-300 bg-white px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]"
                    value={course.pblConfig?.difficultyLevel ?? "standard"}
                    onChange={(e) => updateCourse(course.id, { pblConfig: normalizePblCourseConfig({ ...course.pblConfig, difficultyLevel: e.target.value as "introductory" | "standard" | "advanced", evidenceRequirements: course.pblConfig?.evidenceRequirements ?? DEFAULT_PBL_EVIDENCE_REQUIREMENTS.filter((i) => i.required), outcome: course.pblConfig?.outcome ?? { ...DEFAULT_PBL_OUTCOME } }) })}
                  >
                    <option value="introductory">入门：需要更多示范与引导</option>
                    <option value="standard">标准：知识与实践均衡</option>
                    <option value="advanced">进阶：强调探究、论证与迭代</option>
                  </select>
                </div>
                <fieldset>
                  <legend className="text-sm font-bold text-stone-800">需要整理哪些过程证据？</legend>
                  <p className="mt-1 text-xs text-stone-500">选中的证据会进入生成模板、评价方案和学生阶段提示。</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {DEFAULT_PBL_EVIDENCE_REQUIREMENTS.map((item) => {
                      const currentEvidence = (course.pblConfig?.evidenceRequirements ?? DEFAULT_PBL_EVIDENCE_REQUIREMENTS).filter((i) => i.required !== false);
                      const selected = currentEvidence.some((e) => e.kind === item.kind);
                      return (
                        <button
                          key={item.kind}
                          type="button"
                          aria-pressed={selected}
                          className={`flex items-start gap-2 rounded-[6px] border px-2.5 py-2 text-left transition ${selected ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] shadow-sm" : "border-stone-200 bg-stone-50/60 hover:border-[var(--pbl-teacher-border)]"}`}
                          onClick={() => updateCourse(course.id, { pblConfig: normalizePblCourseConfig({ ...course.pblConfig, difficultyLevel: course.pblConfig?.difficultyLevel ?? "standard", evidenceRequirements: selected ? currentEvidence.filter((e) => e.kind !== item.kind) : [...currentEvidence, { ...item, required: true }], outcome: course.pblConfig?.outcome ?? { ...DEFAULT_PBL_OUTCOME } }) })}
                        >
                          <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${selected ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher)] text-white" : "border-stone-300 text-transparent"}`}>
                            <Check size={11} />
                          </span>
                          <span>
                            <span className="block text-xs font-semibold">{item.label}</span>
                            <span className="mt-0.5 block text-[11px] leading-4 text-stone-500">{item.description}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
                <div className="border-t border-stone-200 pt-5">
                  <div className="mb-4"><h3 className="text-sm font-bold">结构化成果要求</h3><p className="mt-1 text-xs text-stone-500">每个项目都必须同时包含作品、表达和反思。</p></div>
                  <div className="grid gap-4 md:grid-cols-3">
                    {(["artifact", "presentation", "reflection"] as const).map((key) => {
                      const labels: Record<typeof key, string> = { artifact: "作品", presentation: "表达", reflection: "反思" };
                      const placeholders: Record<typeof key, string> = { artifact: "例如：校园节能改进方案、数据报告或交互原型", presentation: "学生如何讲清问题、证据、取舍与价值", reflection: "学生如何说明成长、AI 使用与下一步改进" };
                      const draftKeys: Record<typeof key, keyof CourseBasicsDraft> = { artifact: "outcomeArtifact", presentation: "outcomePresentation", reflection: "outcomeReflection" };
                      return (
                        <label key={key} className="text-sm font-semibold">
                          {labels[key]}
                          <span className="mt-1 block text-xs font-normal text-stone-500">{placeholders[key]}</span>
                          <textarea
                            className="mt-2 min-h-[80px] w-full rounded-[6px] border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--pbl-teacher)]"
                            value={String(draft[draftKeys[key]])}
                            onChange={(e) => editBaseDraft({ [draftKeys[key]]: e.target.value })}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Card> : null}
          </div>
        ) : flowStepKey === "adaptiveLearning" ? (
          <AdaptiveLearningPlanEditor
            courseId={course.id}
            courseName={course.name}
            knowledgePoints={content?.knowledgePoints ?? []}
            mainScenes={sceneOutlines}
            onChange={(adaptiveLearningPlan, knowledgeGraph) => {
              const nextContent = {
                ...(content ?? course.content),
                adaptiveLearningPlan,
                ...(knowledgeGraph ? { knowledgeGraph } : {}),
              };
              setContent(nextContent);
              persistContentSnapshot(nextContent);
            }}
            plan={content?.adaptiveLearningPlan}
          />
        ) : flowStepKey === "lessonOutline" ? (
          <div className="space-y-8">
          <Card className="overflow-clip p-0">
            <header className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-200 px-5 py-4">
              <PreparationSectionHeading
                title="主课脚本"
              />
              <div className="flex flex-wrap items-center gap-2">
                <div aria-label="课程生成模式" className="inline-flex rounded-[7px] border border-stone-200 bg-stone-50 p-0.5" role="group">
                  <button
                    aria-pressed={lessonGenerationMode === "standard"}
                    className={cn(
                      "h-8 rounded-[5px] px-3 text-xs font-bold transition",
                      lessonGenerationMode === "standard"
                        ? "bg-white text-stone-900 shadow-sm"
                        : "text-stone-500 hover:text-stone-800",
                    )}
                    disabled={outlineStreaming}
                    onClick={() => setLessonGenerationMode("standard")}
                    title="按教学必要性动态安排少量高价值互动"
                    type="button"
                  >
                    普通模式
                  </button>
                  <button
                    aria-pressed={lessonGenerationMode === "deep-interaction"}
                    className={cn(
                      "h-8 rounded-[5px] px-3 text-xs font-bold transition",
                      lessonGenerationMode === "deep-interaction"
                        ? "bg-white text-violet-700 shadow-sm"
                        : "text-stone-500 hover:text-stone-800",
                    )}
                    disabled={outlineStreaming}
                    onClick={() => setLessonGenerationMode("deep-interaction")}
                    title="优先生成有真实操作价值的模拟、编程和探索页面"
                    type="button"
                  >
                    深度交互
                  </button>
                </div>
                <button
                  className="inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-[var(--pbl-teacher)] px-3.5 text-xs font-bold text-white transition hover:brightness-95 disabled:opacity-50"
                  disabled={outlineStreaming}
                  onClick={() => void generateLessonOutlineOpenMAIC()}
                  type="button"
                >
                  {outlineStreaming ? <CourseGenerationGlyph /> : sceneOutlines.length ? <RotateCw size={14} /> : <Zap size={14} />}
                  {outlineStreaming ? "正在生成" : sceneOutlines.length ? "重新生成" : "AI 生成"}
                </button>
              </div>
            </header>
            <LessonScriptDirectory
              activities={content?.teachingOutline ?? []}
              details={sceneOutlines}
              onSelectPage={(id) => setOutlineFocusRequest((current) => ({
                id,
                nonce: (current?.nonce ?? 0) + 1,
              }))}
            />
            <TeachingToolRunbook
              className="m-5 mt-0"
              description="这是课程生成前的执行计划。老师可以逐页看到白板或互动组件何时出现、为什么出现，以及将呈现哪些内容。"
              outlines={sceneOutlines}
              title="逐页教学工具计划"
            />
          </Card>
          <Card className="overflow-clip p-0">
            {sections.find((section) => section.key === "lessonOutline")?.node}
          </Card>
          </div>
        ) : (
          sections
            .filter(({ key }) => key === flowStepKey)
            .map(({ key, node }) => (
          <Card className="overflow-clip p-0" key={key}>
            <header className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-200 px-5 py-4">
              <PreparationSectionHeading
                badge={key === "knowledgePoints" && (content?.knowledgePoints.length ?? 0) > 0
                  ? <Pill tone="green">{content!.knowledgePoints.length} 项</Pill>
                  : key === "teachingOutline" && (content?.teachingOutline?.length ?? 0) > 0
                    ? <Pill tone="green">{content!.teachingOutline!.length} 个活动</Pill>
                    : undefined}
                title={SECTION_LABEL[key]}
              />
              {key === "knowledgePoints" ? null : (
                <button
                  className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-3 text-xs font-bold text-[var(--pbl-teacher)] transition hover:bg-white disabled:opacity-50"
                  disabled={busy === key}
                  onClick={() => void generateSection(key)}
                  type="button"
                >
                  {busy === key ? <CourseGenerationGlyph /> : <RotateCw size={14} />}
                  {key === "teachingOutline"
                    ? content?.moduleTimingPlan ? "重新规划时间" : "生成时间安排"
                    : isStepReady(key) ? "重新生成" : "生成"}
                </button>
              )}
            </header>
            <div className="p-5">{node}</div>
          </Card>
            ))
        )}
      </div>

      <FlowActionBar
        back={
          <span className="text-xs font-semibold text-[var(--pbl-text-muted)]">
            {currentFlowIndex + 1}/{PREPARATION_FLOW_STEPS.length} · {currentFlowStep.label}
          </span>
        }
        persistent
      >
          {flowStepKey === "base" && !isPreparationStepReady("base") ? (
            <button
              className="inline-flex h-11 items-center gap-2 rounded-[6px] border border-stone-200 bg-white px-5 text-sm font-semibold text-stone-600 hover:bg-stone-50 disabled:cursor-default disabled:opacity-55"
              onClick={() => {
                const saved = saveDraft({ allowIncomplete: true });
                if (saved) toast.success("未完成草稿已保存");
              }}
              title="保存当前未完成内容"
              type="button"
            >
              <Save size={16} /> 保存草稿
            </button>
          ) : null}
          {nextFlowStep ? (
            <PrimaryButton
              type="button"
              onClick={() => navigateToFlowStep(nextFlowStep.key)}
            >
              进入{nextFlowStep.label} →
            </PrimaryButton>
          ) : (
            <PrimaryButton
              disabled={
                !content ||
                !isStepReady("knowledgePoints") ||
                !isStepReady("teachingOutline") ||
                !isStepReady("lessonOutline") ||
                !isStepReady("evaluationPlan")
              }
              onClick={persistAndNext}
              type="button"
            >
              进入课程生成 →
            </PrimaryButton>
          )}
      </FlowActionBar>
      <AiGenerationOverlay cards={aiOverlayCards} kind={aiOverlayKind} hint={info} />
      </>
      )}
    </DashboardShell>
  );
}

function createGenerationCards(
  kind: AiTaskKind,
  course: Course,
  content: CourseContent | undefined,
  hint: string | undefined,
): StageGenerationCardData[] {
  const objectives = course.learningObjectives?.filter(Boolean) ?? [];
  const taskItems = kind === "knowledgeGraph"
    ? (content?.teacherRequiredKnowledgePoints?.length
        ? content.teacherRequiredKnowledgePoints
        : objectives)
    : kind === "teachingOutline"
      ? (content?.knowledgePoints ?? []).map((item) => item.name)
      : kind === "lessonOutline" || kind === "sceneOutlines"
        ? (content?.teachingOutline ?? []).map((item) => item.title)
        : kind === "evaluationPlan"
          ? (content?.evaluationPlan.dimensions ?? []).map((item) => item.name)
          : objectives;
  const currentItems = taskItems.filter(Boolean).slice(0, 3);
  const modeItems = [
    "深度互动教学",
    `${course.hours} 课时`,
    `${course.stages.length} 个学习阶段`,
  ];
  return [
    {
      id: "course-context",
      eyebrow: "本次课程",
      title: course.name || "未命名课程",
      detail: [course.subject, course.grade].filter(Boolean).join(" · ") || "正在读取课程基础信息",
      items: modeItems,
      accent: "orange",
    },
    {
      id: "course-purpose",
      eyebrow: "真实输入",
      title: course.drivingQuestion || "课程目标与学习任务",
      detail: course.summary || hint || "根据教师已经确认的课程数据组织生成内容。",
      items: objectives.slice(0, 3),
      accent: "blue",
    },
    {
      id: "course-material",
      eyebrow: "当前依据",
      title: currentItems[0] || "正在整理课程材料",
      detail: hint || "这些内容来自当前课程，而不是预设演示文案。",
      items: currentItems,
      accent: "violet",
    },
    {
      id: "course-output",
      eyebrow: "生成结果",
      title: generationCardResultTitle(kind),
      detail: "结果会保存为可审阅、可编辑的课程数据。",
      items: ["结构完整", "内容可追溯", "支持教师修改"],
      accent: "green",
    },
  ];
}

function generationCardResultTitle(kind: AiTaskKind): string {
  if (kind === "knowledgeGraph") return "知识点与关联关系";
  if (kind === "teachingOutline") return "六阶段课程架构";
  if (kind === "lessonOutline" || kind === "sceneOutlines") return "课堂页面大纲";
  if (kind === "evaluationPlan") return "评价维度与成功标准";
  return "结构化课程内容";
}

function PreparationSectionHeading({
  badge,
  eyebrow = "课程设计",
  title,
}: {
  badge?: React.ReactNode;
  eyebrow?: string;
  title: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--pbl-teacher)]">{eyebrow}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <h2 className="font-editorial text-xl font-semibold text-stone-950">{title}</h2>
        {badge}
      </div>
    </div>
  );
}

function LessonScriptDirectory({
  activities,
  details,
  onSelectPage,
}: {
  activities: ReadonlyArray<TeachingOutlineSection>;
  details: ReadonlyArray<SceneOutline>;
  onSelectPage: (id: string) => void;
}) {
  if (details.length === 0) return null;

  const detailsByParent = new globalThis.Map<string, SceneOutline[]>();
  details.forEach((detail) => {
    const parentId = detail.parentActivityId ?? "__orphan__";
    detailsByParent.set(parentId, [...(detailsByParent.get(parentId) ?? []), detail]);
  });
  const pageIndex = new globalThis.Map(details.map((detail, index) => [detail.id, index + 1]));

  return (
    <section className="border-b border-stone-200 bg-white px-5 pb-6 pt-2">
      <div className="divide-y divide-stone-200">
        {activities.map((activity, activityIndex) => {
          const childDetails = detailsByParent.get(activity.id) ?? [];
          return (
            <article className="py-3" key={activity.id}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-1.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-[var(--pbl-teacher)] text-[11px] font-bold text-white shadow-sm">
                  {String(activityIndex + 1).padStart(2, "0")}
                  </span>
                  <p className="truncate text-sm font-bold text-stone-900">{activity.title}</p>
                </div>
                <span className="text-[11px] font-semibold tabular-nums text-stone-500">{activity.durationMin} 分钟 · {childDetails.length} 个细化</span>
              </div>
              {childDetails.length > 0 ? (
                <div className="relative ml-4 border-l-2 border-[var(--pbl-teacher-border)] py-2 pl-6 pr-1">
                  {childDetails.map((detail) => {
                    const seconds = detail.targetDurationSec ?? detail.estimatedDuration ?? 0;
                    const teacherResource = detail.audience === "teacher";
                    const resourceTags = lessonDirectoryResourceTags(detail);
                    return (
                      <button
                        className="group relative flex w-full items-center gap-3 rounded-[6px] px-2.5 py-2 text-left transition hover:bg-[var(--pbl-teacher-soft)]/45"
                        key={detail.id}
                        onClick={() => onSelectPage(detail.id)}
                        type="button"
                      >
                        <span className="absolute -left-[31px] size-2.5 rounded-full border-2 border-white bg-[var(--pbl-teacher-border)] ring-1 ring-[var(--pbl-teacher-border)] group-hover:bg-[var(--pbl-teacher)]" />
                        <span className="w-7 shrink-0 text-[10px] font-bold tabular-nums text-stone-400">P{pageIndex.get(detail.id)}</span>
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-stone-700 group-hover:text-stone-950">{detail.title || "未命名页面"}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-bold",
                            teacherResource ? "bg-[var(--pbl-ai-soft)] text-[var(--pbl-ai)]" : "bg-sky-100 text-sky-800",
                          )}>{teacherResource ? "教师资源" : "学生页面"}</span>
                          {resourceTags.map((tag) => (
                            <span
                              className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", tag.className)}
                              key={`${detail.id}-${tag.label}`}
                            >
                              {tag.label}
                            </span>
                          ))}
                        </span>
                        {seconds > 0 ? <span className="hidden shrink-0 text-[10px] tabular-nums text-stone-400 sm:block">{Math.max(1, Math.round(seconds / 60))} 分钟</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : <p className="px-11 py-2 text-xs text-stone-400">尚未生成细化内容</p>}
            </article>
          );
        })}
        {(detailsByParent.get("__orphan__") ?? []).length > 0 ? (
          <p className="px-1 text-xs font-semibold text-[var(--pbl-danger)]">有 {(detailsByParent.get("__orphan__") ?? []).length} 个页面尚未关联课程模块</p>
        ) : null}
      </div>
    </section>
  );
}

function lessonDirectoryResourceTags(detail: SceneOutline) {
  const typeTag = detail.type === "quiz"
    ? { label: "测验", className: "bg-[var(--pbl-ai-soft)] text-[var(--pbl-ai)]" }
    : detail.type === "interactive"
      ? { label: "互动", className: "bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]" }
      : detail.type === "pbl"
        ? { label: "项目式学习", className: "bg-[var(--pbl-accent-soft)] text-[var(--pbl-accent)]" }
        : { label: "幻灯片", className: "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" };

  const detailLabel = detail.type === "quiz"
    ? `${detail.quizConfig?.questionCount ?? 3} 道题`
    : detail.type === "interactive"
      ? lessonDirectoryWidgetLabel(detail.widgetType)
      : null;

  return detailLabel
    ? [typeTag, { label: detailLabel, className: "border border-stone-200 bg-white text-stone-600" }]
    : [typeTag];
}

function lessonDirectoryWidgetLabel(widgetType: SceneOutline["widgetType"]) {
  switch (widgetType) {
    case "game":
      return "游戏";
    case "diagram":
      return "图示";
    case "code":
      return "代码实践";
    case "visualization3d":
      return "3D 可视化";
    case "procedural-skill":
      return "步骤练习";
    case "simulation":
    default:
      return "仿真模拟";
  }
}

function AiSuggestionPanel({
  children,
  loading,
  onClose,
  onRefresh,
}: {
  children: React.ReactNode;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mt-3 rounded-[10px] border border-[var(--pbl-ai-border)] bg-[var(--pbl-ai-soft)]/25 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-[var(--pbl-ai)]">AI 候选 · 采纳后仍需点击保存</p>
        <div className="flex items-center gap-3">
          <button className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--pbl-ai)] disabled:opacity-50" disabled={loading} onClick={onRefresh} type="button">
            <RefreshCw className={loading ? "animate-spin" : ""} size={11} /> 换一批
          </button>
          <button className="text-xs text-stone-400 hover:text-stone-600" onClick={onClose} type="button">关闭</button>
        </div>
      </div>
      <div className="grid gap-2 lg:grid-cols-3">{children}</div>
    </div>
  );
}

function AiSuggestionCard({ children, onAdopt }: { children: React.ReactNode; onAdopt: () => void }) {
  return (
    <article className="flex min-h-28 flex-col rounded-[8px] border border-white bg-white p-3 text-xs leading-5 text-stone-700 shadow-sm">
      <div className="flex-1">{children}</div>
      <button className="mt-3 self-end font-semibold text-[var(--pbl-ai)] hover:underline" onClick={onAdopt} type="button">采纳此候选</button>
    </article>
  );
}

function updateTeachingOutlineItem(
  setContent: React.Dispatch<React.SetStateAction<CourseContent | undefined>>,
  id: string,
  patch: Partial<TeachingOutlineSection>,
) {
  setContent((content) =>
    content
      ? {
          ...content,
          teachingOutline: (content.teachingOutline ?? []).map((item) =>
            item.id === id ? { ...item, ...patch } : item,
          ),
        }
      : content,
  );
}

function OutlineTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-stone-500">{label}</span>
      <textarea
        className="min-h-[84px] w-full rounded-[6px] border border-stone-300 px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--pbl-teacher)]"
        onChange={(e) => onChange(e.target.value)}
        value={value}
      />
    </label>
  );
}
