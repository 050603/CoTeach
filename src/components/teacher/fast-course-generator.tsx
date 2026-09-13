"use client";

import {
  Blocks,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Mic2,
  Paperclip,
  Send,
  Settings2,
  Sparkles,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CoTeachLogo } from "@/components/brand/coteach-logo";
import { CourseGenerationGlyph } from "@/components/course-workshop-animation";
import { QuickKnowledgeReviewDialog } from "@/components/teacher/quick-knowledge-review-dialog";
import { QuickOutlineReviewDialog } from "@/components/teacher/quick-outline-review-dialog";
import { QuickGenerationStage } from "@/components/teacher/quick-generation-stage";
import { ResourcePackageForm } from "@/components/teacher/resource-package-form";
import type { CourseResourcePackage } from "@/lib/resource-package/types";
import {
  buildQuickClassroomArtifacts,
  combineQuickGenerationProgress,
  resolveQuickClassroomActiveArtifactId,
  type QuickClassroomGenerationSnapshot,
} from "@/lib/course-generation/quick-artifacts";
import { isGenerationHeartbeatStale } from "@/lib/course-generation/heartbeat";
import { resolveLatestCompletedArtifactId } from "@/lib/course-design/active-artifact";
import { readJsonResponse } from "@/lib/http/read-json-response";
import type {
  Course,
  CourseDesignGenerationArtifact,
  CourseDesignGenerationTraceEntry,
  KnowledgeGraph,
  KnowledgePoint,
} from "@/lib/session/types";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { cn } from "@/lib/utils";
import {
  GENERATION_REFERENCE_ACCEPT,
  MAX_GENERATION_REFERENCE_FILES,
} from "@/lib/course-design/generation-reference-policy";

type JobStatus = "queued" | "running" | "review_available" | "paused" | "cancelling" | "cancelled" | "completed" | "failed";

type DesignJob = {
  id: string;
  status: JobStatus;
  step: string;
  reviewStatus: "unavailable" | "available" | "paused" | "approved" | "auto-continued";
  reviewKind?: "knowledge" | "outline" | null;
  reviewAvailableUntil?: string | null;
  stepIndex: number;
  progress: number;
  message: string;
  estimatedRemainingSeconds: number | null;
  trace: Array<CourseDesignGenerationTraceEntry & { progress?: number; stepIndex?: number }>;
  qualityReport?: { score?: number; summary?: string; checks?: string[] } | null;
  error?: string | null;
  startedAt?: string | null;
  lastHeartbeatAt?: string | null;
  updatedAt?: string | null;
  requestPreview?: {
    teacherBrief?: string;
    resourcePackageId?: string;
    resourcePackageRevision?: number;
    supplementalAnswers?: { brief?: string };
    generationMode?: CourseGenerationMode;
    options?: GenerationOptions | null;
    referenceMaterials?: UploadedKnowledgeReference[];
  };
};

type ResponsePayload = {
  backgroundEnabled: boolean;
  job: DesignJob | null;
  knowledgePreview?: {
    knowledgePoints: KnowledgePoint[];
    knowledgeGraph: KnowledgeGraph;
  } | null;
  outlinePreview?: SceneOutline[];
  error?: string;
  detail?: string;
};

type ClassroomGenerationResponse = {
  backgroundEnabled: boolean;
  job: (QuickClassroomGenerationSnapshot & {
    id: string;
    estimatedRemainingSeconds: number | null;
    error?: string | null;
    startedAt?: string | null;
    lastHeartbeatAt?: string | null;
    updatedAt?: string | null;
  }) | null;
  error?: string;
};

type GenerationOptions = {
  enableImageGeneration: boolean;
  enableTTS: boolean;
  enableVideoGeneration: boolean;
};

type CourseGenerationMode = "standard" | "deep-interaction";

type UploadedKnowledgeReference = {
  id: string;
  fileName: string;
  fileType?: string;
  mimeType?: string;
  size?: string;
};

const QUICK_TOOLBAR_CONTROL_CLASS =
  "inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] px-2.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500";

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "正在完成最后检查";
  return `预计还需约 ${Math.max(1, Math.ceil(seconds / 60))} 分钟`;
}

export function FastCourseGenerator({
  course,
  onOpenDetailed,
  simplified = false,
}: {
  course: Course;
  onOpenDetailed: () => void | Promise<void>;
  simplified?: boolean;
}) {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [confirmedPackage, setConfirmedPackage] = useState<CourseResourcePackage | null>(null);
  const [hasResourcePackage, setHasResourcePackage] = useState(false);
  const [generationMode, setGenerationMode] = useState<CourseGenerationMode>("standard");
  const [job, setJob] = useState<DesignJob | null>(null);
  const [classroomJob, setClassroomJob] = useState<ClassroomGenerationResponse["job"]>(null);
  const [backgroundEnabled, setBackgroundEnabled] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [referenceMaterials, setReferenceMaterials] = useState<UploadedKnowledgeReference[]>([]);
  const [classroomRetrying, setClassroomRetrying] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [knowledgePreview, setKnowledgePreview] = useState<{
    knowledgePoints: KnowledgePoint[];
    knowledgeGraph: KnowledgeGraph;
  }>({ knowledgePoints: [], knowledgeGraph: { nodes: [], edges: [] } });
  const [knowledgeReviewOpen, setKnowledgeReviewOpen] = useState(false);
  const [outlinePreview, setOutlinePreview] = useState<SceneOutline[]>([]);
  const [outlineReviewOpen, setOutlineReviewOpen] = useState(false);
  const autoOpenedClassroomId = useRef<string | null>(null);
  const [options, setOptions] = useState<GenerationOptions>({
    enableImageGeneration: true,
    enableTTS: true,
    enableVideoGeneration: false,
  });
  const running = job?.status === "queued"
    || job?.status === "running"
    || job?.status === "review_available"
    || job?.status === "paused"
    || job?.status === "cancelling";
  // Existing failed jobs can retry their exact saved request without a new ZIP.
  const savedRequest = job?.requestPreview;
  const legacyResumeAvailable = !hasResourcePackage && Boolean(savedRequest)
    && (job?.status === "failed" || job?.status === "cancelled")
    && !savedRequest?.resourcePackageId
    && brief === (savedRequest?.teacherBrief ?? "")
    && generationMode === (savedRequest?.generationMode ?? "standard")
    && options.enableImageGeneration === (savedRequest?.options?.enableImageGeneration !== false)
    && options.enableTTS === (savedRequest?.options?.enableTTS !== false)
    && options.enableVideoGeneration === (savedRequest?.options?.enableVideoGeneration === true)
    && JSON.stringify(referenceMaterials.map((item) => item.id).sort()) === JSON.stringify((savedRequest?.referenceMaterials ?? []).map((item) => item.id).sort());

  const applyPayload = useCallback((payload: ResponsePayload) => {
    setBackgroundEnabled(payload.backgroundEnabled);
    setJob(payload.job);
    const savedBrief = payload.job?.requestPreview?.teacherBrief;
    if (savedBrief) setBrief(savedBrief);
    if (payload.job?.requestPreview?.generationMode) {
      setGenerationMode(payload.job.requestPreview.generationMode);
    }
    const savedOptions = payload.job?.requestPreview?.options;
    if (savedOptions) {
      setOptions({
        enableImageGeneration: savedOptions.enableImageGeneration !== false,
        enableTTS: savedOptions.enableTTS !== false,
        enableVideoGeneration: savedOptions.enableVideoGeneration === true,
      });
    }
    const savedReferences = payload.job?.requestPreview?.referenceMaterials;
    if (savedReferences?.length) {
      setReferenceMaterials((current) => current.length > 0 ? current : savedReferences);
    }
    if (payload.knowledgePreview) setKnowledgePreview(payload.knowledgePreview);
    if (payload.outlinePreview) setOutlinePreview(payload.outlinePreview);
    if (payload.job?.status === "failed") {
      setError(`${payload.job.error || "快速生成遇到系统或网络错误，请稍后重试。"} 教师要求和已完成内容均已保存，可直接重试或修改要求后继续。`);
    } else if (payload.job && ["queued", "running", "review_available", "paused", "completed"].includes(payload.job.status)) {
      // Correctable quality issues remain inside the managed Agent loop. Clear
      // stale transport errors as soon as the durable task resumes.
      setError(undefined);
    }
    if (payload.job?.status === "cancelled") setError("本次快速生成已中断，可以修改要求后重新开始。");
  }, []);

  const fetchJob = useCallback(async () => {
    const response = await fetch(`/api/courses/${course.id}/design-generation`, { cache: "no-store" });
    const payload = await readJsonResponse<ResponsePayload>(response, "快速生成服务没有返回内容，请刷新页面后重试。");
    if (!response.ok) throw new Error(payload.detail || payload.error || "无法读取快速生成状态");
    applyPayload(payload);
    return payload;
  }, [applyPayload, course.id]);

  const fetchClassroomJob = useCallback(async (startPersistedJob = false) => {
    const response = await fetch(`/api/courses/${course.id}/generation`, startPersistedJob
      ? {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start-persisted-job" }),
        }
      : { cache: "no-store" });
    const payload = await readJsonResponse<ClassroomGenerationResponse>(response, "无法读取最终课程生成进度，请稍后重试。");
    if (!response.ok) throw new Error(payload.error || "无法读取最终课程生成进度");
    setBackgroundEnabled(payload.backgroundEnabled);
    setClassroomJob(payload.job);
    if (payload.job?.status === "failed") setError(payload.job.error || "最终课程内容生成未完成，请重试。");
    else if (payload.job?.status === "cancelled") setError("本次最终课程内容生成已中断，可以返回后重新生成。");
    else if (payload.job) setError(undefined);
    return payload;
  }, [course.id]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchJob().catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法读取快速生成状态");
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fetchJob]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void fetchJob().catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [fetchJob, running]);

  useEffect(() => {
    if (job?.status !== "completed") return;
    let cancelled = false;
    const continueGeneration = async () => {
      try {
        let payload = await fetchClassroomJob(false);
        if (!cancelled && payload.job?.status === "queued" && !payload.backgroundEnabled) {
          payload = await fetchClassroomJob(true);
        }
        if (!cancelled && !payload.job) setError("课程设计已经完成，但没有找到后续课堂生成任务。");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法继续生成最终课程内容");
      }
    };
    void continueGeneration();
    return () => { cancelled = true; };
  }, [fetchClassroomJob, job?.status]);

  const classroomRunning = classroomJob?.status === "queued"
    || classroomJob?.status === "running"
    || classroomJob?.status === "cancelling";
  useEffect(() => {
    if (!classroomRunning) return;
    const timer = window.setInterval(() => void fetchClassroomJob(false).catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [classroomRunning, fetchClassroomJob]);

  useEffect(() => {
    if (!confirmCancel) return;
    const timer = window.setTimeout(() => setConfirmCancel(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirmCancel]);

  async function start() {
    if (!confirmedPackage?.confirmedAt && !legacyResumeAvailable) {
      setError("请先上传资源包并确认教学要求。");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/courses/${course.id}/design-generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacherBrief: brief,
          ...(confirmedPackage?.confirmedAt ? {
            supplementalAnswers: { brief },
            resourcePackageId: confirmedPackage.id,
            resourcePackageRevision: confirmedPackage.revision,
          } : {}),
          generationMode,
          options,
          referenceIds: referenceMaterials.map((material) => material.id),
        }),
      });
      const payload = await readJsonResponse<ResponsePayload>(
        response,
        "快速生成服务没有返回内容。请确认数据库迁移已完成，然后重试。",
      );
      if (!response.ok) throw new Error(payload.detail || payload.error || "无法启动快速生成");
      applyPayload(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动快速生成");
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadKnowledgeReferences(files: readonly File[]) {
    const available = MAX_GENERATION_REFERENCE_FILES - referenceMaterials.length;
    if (available <= 0) {
      setError(`最多上传 ${MAX_GENERATION_REFERENCE_FILES} 份知识资料。`);
      return;
    }
    const selected = files.slice(0, available);
    setUploadingReference(true);
    setError(undefined);
    try {
      for (const file of selected) {
        const form = new FormData();
        form.append("file", file);
        form.append("courseId", course.id);
        form.append("purpose", "generation-reference");
        const response = await fetch("/api/uploads", { method: "POST", body: form });
        const payload = await readJsonResponse<UploadedKnowledgeReference & { message?: string; error?: string }>(
          response,
          "知识资料上传后没有收到响应，请重试。",
        );
        if (!response.ok || !payload.id || !payload.fileName) {
          throw new Error(payload.message || payload.error || `无法上传“${file.name}”`);
        }
        setReferenceMaterials((current) => current.some((item) => item.id === payload.id)
          ? current
          : [...current, payload]);
      }
      if (files.length > selected.length) {
        setError(`最多上传 ${MAX_GENERATION_REFERENCE_FILES} 份知识资料，其余文件未上传。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "知识资料上传失败，请重试。");
    } finally {
      setUploadingReference(false);
    }
  }

  async function removeKnowledgeReference(material: UploadedKnowledgeReference) {
    setError(undefined);
    try {
      const response = await fetch(`/api/uploads/${material.id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`无法移除“${material.fileName}”`);
      setReferenceMaterials((current) => current.filter((item) => item.id !== material.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法移除知识资料，请重试。");
    }
  }

  async function cancelGeneration() {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setConfirmCancel(false);
    try {
      if (job?.status === "completed" && classroomJob && classroomJob.status !== "completed") {
        const response = await fetch(`/api/courses/${course.id}/generation`, { method: "DELETE" });
        const payload = await readJsonResponse<ClassroomGenerationResponse>(response, "中断请求没有得到响应，请稍后重试。");
        if (!response.ok) throw new Error(payload.error || "无法中断最终课程生成");
        setClassroomJob(payload.job);
      } else {
        const response = await fetch(`/api/courses/${course.id}/design-generation`, { method: "DELETE" });
        const payload = await readJsonResponse<ResponsePayload>(response, "中断请求没有得到响应，请稍后重试。");
        if (!response.ok) throw new Error(payload.detail || payload.error || "无法中断生成");
        applyPayload(payload);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法中断生成");
    }
  }

  async function resumeClassroomGeneration() {
    setClassroomRetrying(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/courses/${course.id}/generation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume-from-checkpoints" }),
      });
      const payload = await readJsonResponse<ClassroomGenerationResponse>(response, "续生成请求没有得到响应，请稍后重试。");
      if (!response.ok) throw new Error(payload.error || "无法从已完成页面继续生成");
      setBackgroundEnabled(payload.backgroundEnabled);
      setClassroomJob(payload.job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法从已完成页面继续生成");
    } finally {
      setClassroomRetrying(false);
    }
  }

  async function reviewArtifact() {
    try {
      if (job?.status === "review_available") {
        const response = await fetch(`/api/courses/${course.id}/design-generation`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pause" }),
        });
        const payload = await readJsonResponse<ResponsePayload>(response, "暂停请求没有得到响应，请稍后重试。");
        if (!response.ok) throw new Error(payload.detail || payload.error || "无法暂停生成");
        applyPayload(payload);
      }
      const latest = await fetchJob();
      if (latest.job?.reviewKind === "knowledge") {
        setKnowledgePreview(latest.knowledgePreview ?? {
          knowledgePoints: [],
          knowledgeGraph: { nodes: [], edges: [] },
        });
        setKnowledgeReviewOpen(true);
      } else {
        setOutlinePreview(latest.outlinePreview ?? []);
        setOutlineReviewOpen(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开待确认内容");
    }
  }

  async function resumeAfterKnowledgeReview(
    knowledgePoints: KnowledgePoint[],
    knowledgeGraph: KnowledgeGraph,
  ) {
    setError(undefined);
    const response = await fetch(`/api/courses/${course.id}/design-generation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "resume",
        reviewKind: "knowledge",
        knowledgePoints,
        knowledgeGraph,
      }),
    });
    const payload = await readJsonResponse<ResponsePayload>(response, "保存知识图谱后未收到响应，请稍后重试。");
    if (!response.ok) throw new Error(payload.detail || payload.error || "无法保存知识图谱并继续生成");
    setKnowledgePreview({ knowledgePoints, knowledgeGraph });
    setKnowledgeReviewOpen(false);
    applyPayload(payload);
  }

  async function resumeAfterOutlineReview(outlines: SceneOutline[]) {
    setError(undefined);
    const response = await fetch(`/api/courses/${course.id}/design-generation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", reviewKind: "outline", sceneOutlines: outlines }),
    });
    const payload = await readJsonResponse<ResponsePayload>(response, "保存大纲后未收到响应，请稍后重试。");
    if (!response.ok) throw new Error(payload.detail || payload.error || "无法保存大纲并继续生成");
    setOutlinePreview(outlines);
    setOutlineReviewOpen(false);
    applyPayload(payload);
  }

  const artifacts = useMemo<CourseDesignGenerationArtifact[]>(() => {
    const seen = new Set<string>();
    return (job?.trace ?? []).flatMap((entry) => entry.artifacts ?? []).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [job?.trace]);

  const combinedArtifacts = useMemo(
    () => [...artifacts, ...buildQuickClassroomArtifacts(classroomJob, { aiLearningOnly: simplified })],
    [artifacts, classroomJob, simplified],
  );

  const classroomCompleted = classroomJob?.status === "completed" && Boolean(classroomJob.result?.id);
  const classroomFailed = classroomJob?.status === "failed";
  const designRecovering = isGenerationHeartbeatStale(job);
  const classroomRecovering = isGenerationHeartbeatStale(classroomJob);
  const recovering = job?.status === "completed" ? classroomRecovering : designRecovering;
  const overallProgress = job?.status === "completed"
    ? combineQuickGenerationProgress(100, classroomJob?.progress ?? 0, classroomCompleted)
    : combineQuickGenerationProgress(job?.progress ?? 0, 0, false);
  const activeArtifactId = job?.status === "completed"
    ? resolveQuickClassroomActiveArtifactId(classroomJob, { aiLearningOnly: simplified })
    : resolveLatestCompletedArtifactId(artifacts);
  const activeMessage = recovering
    ? "正在自动恢复"
    : job?.status === "completed"
    ? classroomJob?.message || "课程设计已完成，正在衔接课堂内容生成"
    : job?.message || "正在分析课程信息";
  const activeRemaining = job?.status === "completed"
    ? classroomJob?.estimatedRemainingSeconds
    : job?.estimatedRemainingSeconds;
  const activeStartedAt = job?.status === "completed"
    ? classroomJob?.startedAt ?? job.startedAt ?? null
    : job?.startedAt ?? null;
  const showGenerationCanvas = running || job?.status === "completed" || classroomRunning || classroomCompleted;

  useEffect(() => {
    const classroomId = classroomJob?.result?.id;
    if (!classroomCompleted || !classroomId || autoOpenedClassroomId.current === classroomId) return;
    const timer = window.setTimeout(() => {
      autoOpenedClassroomId.current = classroomId;
      router.push(`/teacher/prepare/${course.id}/preview?classroomId=${classroomId}`);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [classroomCompleted, classroomJob?.result?.id, course.id, router]);

  if (showGenerationCanvas) {
    return (
      <LayoutGroup id={`quick-generation-${course.id}`}>
      <QuickGenerationStage
        activeArtifactId={activeArtifactId}
        artifacts={combinedArtifacts}
        backgroundEnabled={backgroundEnabled}
        brief={job?.requestPreview?.teacherBrief || brief}
        cancelling={job?.status === "cancelling" || classroomJob?.status === "cancelling"}
        confirmCancel={confirmCancel}
        completed={classroomCompleted}
        failed={classroomFailed}
        failureMessage={classroomJob?.error || error}
        message={activeMessage}
        onCancel={() => void cancelGeneration()}
        onOpenCourse={() => {
          if (classroomJob?.result?.id) router.push(`/teacher/prepare/${course.id}/preview?classroomId=${classroomJob.result.id}`);
        }}
        onRetry={() => void resumeClassroomGeneration()}
        onReview={() => void reviewArtifact()}
        paused={job?.status === "paused"}
        progress={overallProgress}
        recovering={recovering}
        remainingLabel={classroomCompleted ? "全部内容已经生成并自动保存" : classroomFailed ? "已完成页面均已保存，可从断点继续" : recovering ? "正在重新连接后台生成任务" : formatDuration(activeRemaining)}
        retrying={classroomRetrying}
        reviewAvailable={job?.status === "review_available" || job?.status === "paused"}
        reviewAvailableUntil={job?.reviewAvailableUntil ?? null}
        reviewKind={job?.reviewKind ?? null}
        startedAt={activeStartedAt}
      />
      <AnimatePresence>
        {knowledgeReviewOpen ? (
          <QuickKnowledgeReviewDialog
            initialKnowledgeGraph={knowledgePreview.knowledgeGraph}
            initialKnowledgePoints={knowledgePreview.knowledgePoints}
            onClose={() => setKnowledgeReviewOpen(false)}
            onConfirm={resumeAfterKnowledgeReview}
          />
        ) : null}
        {outlineReviewOpen ? (
          <QuickOutlineReviewDialog
            initialOutlines={outlinePreview}
            onClose={() => setOutlineReviewOpen(false)}
            onConfirm={resumeAfterOutlineReview}
          />
        ) : null}
      </AnimatePresence>
      </LayoutGroup>
    );
  }

  return (
    <section className="relative flex min-h-[calc(100vh-150px)] items-start justify-center px-4 py-14">
      {!simplified ? <button
        className="absolute right-1 top-1 inline-flex h-10 items-center gap-2 rounded-[9px] border border-stone-200 bg-white px-3.5 text-xs font-bold text-stone-600 shadow-sm transition hover:border-stone-400 hover:text-stone-900"
        onClick={() => void onOpenDetailed()}
        type="button"
      >
        <Settings2 className="size-4" />进入高级分步设计
      </button> : null}

      <div className="w-full max-w-[820px]">
        <div className={cn("flex flex-col items-center justify-center", simplified ? "mb-8" : "mb-10")}>
          <CoTeachLogo height={simplified ? 104 : 82} variant="horizontal" />
          {simplified ? (
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.32em] text-stone-400">
              AI inside practice.
            </p>
          ) : null}
        </div>

        <ResourcePackageForm courseId={course.id} disabled={submitting || running || classroomRunning} onConfirmed={setConfirmedPackage} onPackagePresent={setHasResourcePackage} />
        {legacyResumeAvailable ? <p className="mb-4 text-sm leading-6 text-stone-600">此旧任务可使用原有要求继续生成；修改教学要求或创建新课堂时，请上传资源包。</p> : null}
        <div className="overflow-visible rounded-[14px] border border-stone-300 bg-white">
          <textarea
            aria-label="补充课程生成要求（可选）"
            className="quick-course-brief min-h-[120px] w-full resize-none rounded-t-[14px] border-0 bg-transparent px-6 pb-3 pt-5 text-[15px] leading-7 text-stone-900 focus-visible:outline-2 focus-visible:outline-stone-500 placeholder:text-stone-400"
            maxLength={4000}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="补充要求（可选）：希望重点讲清的概念、学生常见困难、案例偏好……"
            value={brief}
          />

          {!simplified ? <div className="px-5 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <label
                className={cn(
                  "inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-dashed px-3 text-xs font-semibold transition",
                  uploadingReference || referenceMaterials.length >= MAX_GENERATION_REFERENCE_FILES
                    ? "cursor-not-allowed border-stone-200 text-stone-300"
                    : "border-stone-300 text-stone-600 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700",
                )}
                title="可选；资料只用于辅助课程构思，不会发布给学生"
              >
                {uploadingReference
                  ? <LoaderCircle className="size-3.5 animate-spin" />
                  : <Paperclip className="size-3.5" />}
                {uploadingReference ? "正在上传并检查…" : "上传知识资料（可选）"}
                <input
                  accept={GENERATION_REFERENCE_ACCEPT}
                  aria-label="上传知识资料"
                  className="sr-only"
                  disabled={uploadingReference || submitting || referenceMaterials.length >= MAX_GENERATION_REFERENCE_FILES}
                  multiple
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (files.length) void uploadKnowledgeReferences(files);
                  }}
                  type="file"
                />
              </label>
              <span className="text-[11px] leading-5 text-stone-400">
                PDF、Word、PPT、TXT、Markdown，最多 {MAX_GENERATION_REFERENCE_FILES} 份；仅作为生成依据
              </span>
            </div>
            {referenceMaterials.length > 0 ? (
              <ul aria-label="已上传知识资料" className="mt-2 flex flex-wrap gap-2">
                {referenceMaterials.map((material) => (
                  <li className="inline-flex max-w-full items-center gap-2 rounded-full bg-stone-100 py-1.5 pl-2.5 pr-1.5 text-xs text-stone-700" key={material.id}>
                    <FileText className="size-3.5 shrink-0 text-blue-600" />
                    <span className="max-w-[260px] truncate font-medium">{material.fileName}</span>
                    {material.size ? <span className="text-[10px] text-stone-400">{material.size}</span> : null}
                    <button
                      aria-label={`移除知识资料：${material.fileName}`}
                      className="grid size-6 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-white hover:text-red-600"
                      disabled={uploadingReference || submitting}
                      onClick={() => void removeKnowledgeReference(material)}
                      type="button"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div> : null}

          <div className={cn(
            "flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center",
            simplified
              ? "rounded-b-[21px] border-t border-stone-100 bg-stone-50/80 px-3 py-3"
              : "px-3 pb-3 pt-1",
          )}>
            {simplified ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                <CompactKnowledgeUpload
                  disabled={submitting || referenceMaterials.length >= MAX_GENERATION_REFERENCE_FILES}
                  onFiles={(files) => void uploadKnowledgeReferences(files)}
                  uploading={uploadingReference}
                />
                <span aria-hidden="true" className="mx-1 h-4 w-px bg-stone-200" />
                <div aria-label="生成内容选项" className="flex items-center gap-0.5" role="group">
                  <OptionToggle compact active={options.enableImageGeneration} description="为适合的课堂页面生成配图" icon={ImageIcon} label="图片" onClick={() => setOptions((current) => ({ ...current, enableImageGeneration: !current.enableImageGeneration }))} />
                  <OptionToggle compact active={options.enableTTS} description="为授课内容生成中文语音" icon={Volume2} label="语音" onClick={() => setOptions((current) => ({ ...current, enableTTS: !current.enableTTS }))} />
                  <OptionToggle compact active={options.enableVideoGeneration} description="在适合的页面尝试生成视频资源" icon={Video} label="视频" onClick={() => setOptions((current) => ({ ...current, enableVideoGeneration: !current.enableVideoGeneration }))} />
                </div>
                {referenceMaterials.length > 0 ? (
                  <ul aria-label="已上传知识资料" className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {referenceMaterials.map((material) => (
                      <li className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full bg-stone-100 py-1 pl-2.5 pr-1 text-[11px] text-stone-700" key={material.id}>
                        <FileText className="size-3 shrink-0 text-blue-600" />
                        <span className="truncate font-medium">{material.fileName}</span>
                        <button
                          aria-label={`移除知识资料：${material.fileName}`}
                          className="grid size-6 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-white hover:text-red-600 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600"
                          disabled={uploadingReference || submitting}
                          onClick={() => void removeKnowledgeReference(material)}
                          type="button"
                        >
                          <X className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : <div className="space-y-2">
              <div aria-label="课程生成模式" className="inline-flex rounded-full border border-stone-200 bg-stone-50 p-1" role="group">
                <GenerationModeButton
                  active={generationMode === "standard"}
                  description="按教学必要性动态规划讲解、互动与检测，不设置互动页配额"
                  icon={Blocks}
                  label="普通模式"
                  onClick={() => setGenerationMode("standard")}
                />
                <GenerationModeButton
                  active={generationMode === "deep-interaction"}
                  description="优先安排有真实操作价值的模拟、编程、探索与实践"
                  icon={Sparkles}
                  label="深度交互"
                  onClick={() => setGenerationMode("deep-interaction")}
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <OptionToggle active={options.enableImageGeneration} description="为适合的课堂页面生成配图" icon={ImageIcon} label="图片" onClick={() => setOptions((current) => ({ ...current, enableImageGeneration: !current.enableImageGeneration }))} />
                <OptionToggle active={options.enableTTS} description="为授课内容生成中文语音" icon={Volume2} label="语音" onClick={() => setOptions((current) => ({ ...current, enableTTS: !current.enableTTS }))} />
                <OptionToggle active={options.enableVideoGeneration} description="在适合的页面尝试生成视频资源" icon={Video} label="视频" onClick={() => setOptions((current) => ({ ...current, enableVideoGeneration: !current.enableVideoGeneration }))} />
              </div>
            </div>}

            <div className="flex shrink-0 items-center justify-end gap-1">
              {simplified ? (
                <button
                  aria-label={generationMode === "deep-interaction" ? "关闭深度交互，使用普通模式" : "开启深度交互模式"}
                  aria-pressed={generationMode === "deep-interaction"}
                  className={cn(
                    QUICK_TOOLBAR_CONTROL_CLASS,
                    generationMode === "deep-interaction"
                      ? "bg-white text-violet-700 shadow-sm ring-1 ring-stone-200"
                      : "text-stone-500 hover:bg-white hover:text-violet-700",
                  )}
                  onClick={() => setGenerationMode((current) => current === "deep-interaction" ? "standard" : "deep-interaction")}
                  title="开启后优先生成有真实操作价值的模拟、编程与探索页面"
                  type="button"
                >
                  <Sparkles className="size-3.5" />
                  深度交互
                </button>
              ) : null}
              <button
                aria-label={job?.status === "failed" ? "从已保存内容继续生成" : "开始生成课程"}
                className="grid size-11 shrink-0 place-items-center rounded-[9px] bg-stone-950 text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-45"
                disabled={submitting || uploadingReference || (!confirmedPackage?.confirmedAt && !legacyResumeAvailable)}
                onClick={() => void start()}
                type="button"
                title={job?.status === "failed" ? "从已保存内容继续生成" : "开始生成课程"}
              >
                {submitting ? <CourseGenerationGlyph className="size-5" /> : <Send className="size-4.5" />}
              </button>
            </div>
          </div>
        </div>

        {error ? <p className="mx-auto mt-4 max-w-[760px] rounded-[10px] bg-red-50 px-4 py-3 text-center text-xs font-semibold leading-5 text-red-700">{error}</p> : null}
      </div>
    </section>
  );
}

function CompactKnowledgeUpload({
  disabled,
  onFiles,
  uploading,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  uploading: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <label
        className={cn(
          QUICK_TOOLBAR_CONTROL_CLASS,
          "cursor-pointer",
          disabled || uploading
            ? "cursor-not-allowed text-stone-300"
            : "text-stone-500 hover:bg-white hover:text-stone-900",
        )}
      >
        {uploading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
        {uploading ? "正在上传…" : "上传资料"}
        <input
          accept={GENERATION_REFERENCE_ACCEPT}
          aria-describedby="generation-reference-types"
          aria-label="上传知识资料"
          className="sr-only"
          disabled={disabled || uploading}
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length) onFiles(files);
          }}
          type="file"
        />
      </label>
      <span className="group/reference-info absolute -right-1.5 -top-1.5 z-10">
        <button
          aria-label="查看支持的文件类型"
          className="grid size-4.5 place-items-center rounded-full bg-stone-300 text-white shadow-sm ring-2 ring-white transition hover:bg-stone-400 focus-visible:bg-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          type="button"
        >
          <span aria-hidden="true" className="text-[11px] font-black leading-none">
            !
          </span>
        </button>
        <span
          className="pointer-events-none invisible absolute bottom-[calc(100%+8px)] left-1/2 z-30 w-64 -translate-x-1/2 translate-y-1 rounded-[10px] bg-stone-950 px-3 py-2.5 text-left text-[11px] font-medium leading-5 text-white opacity-0 shadow-xl transition group-hover/reference-info:visible group-hover/reference-info:translate-y-0 group-hover/reference-info:opacity-100 group-focus-within/reference-info:visible group-focus-within/reference-info:translate-y-0 group-focus-within/reference-info:opacity-100"
          id="generation-reference-types"
          role="tooltip"
        >
          支持 PDF、Word（DOCX）、PPT（PPTX）、TXT 和 Markdown，最多上传 {MAX_GENERATION_REFERENCE_FILES} 份。资料仅作为课程生成依据，不会直接发布给学生。
        </span>
      </span>
    </div>
  );
}

function GenerationModeButton({
  active,
  description,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  icon: typeof Blocks;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition",
        active
          ? "bg-white text-stone-900 shadow-sm ring-1 ring-stone-200"
          : "text-stone-500 hover:text-stone-800",
      )}
      onClick={onClick}
      title={description}
      type="button"
    >
      <Icon className="size-3.5" />{label}
    </button>
  );
}

function OptionToggle({
  active,
  compact = false,
  description,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  compact?: boolean;
  description: string;
  icon: typeof Mic2;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      aria-label={`${label}：${description}`}
      className={cn(
        compact
          ? QUICK_TOOLBAR_CONTROL_CLASS
          : "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition",
        compact
          ? active
            ? "bg-white text-blue-700 shadow-sm ring-1 ring-stone-200"
            : "text-stone-500 hover:bg-white hover:text-stone-800"
          : active
            ? "border-blue-200 bg-blue-50 text-blue-700"
            : "border-stone-200 bg-white text-stone-400 hover:bg-stone-50",
      )}
      onClick={onClick}
      title={description}
      type="button"
    >
      <Icon className="size-3.5" />{label}
    </button>
  );
}
