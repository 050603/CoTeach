"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useEffect } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  Clock3,
  Download,
  Edit3,
  Eye,
  FlaskConical,
  Gauge,
  Layers3,
  MonitorPlay,
  PlayCircle,
  Presentation,
  ShieldCheck,
  Sparkles,
  RotateCcw,
  X,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { WizardStepper } from "@/components/wizard-stepper";
import { Button, FlowActionBar, Pill, SaveStatus, toast } from "@/components/ui";
import { CoursePublishPathPreview } from "@/components/teacher/course-publish-path-preview";
import { TeachingToolRunbook } from "@/components/teacher/teaching-tool-runbook";
import { StudentStageHost } from "@/components/openmaic-bridge/student-stage-host";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";
import type {
  AdaptiveBranchOutline,
  Course,
  CourseDesignWorkspaceSectionKey,
  OpenMaicSceneOutlineSnapshot,
} from "@/lib/session/types";
import { normalizeTeachingToolPlan } from "@/lib/openmaic/generation/teaching-tool-plan";
import { courseDetailedEditHref } from "@/lib/courses/preparation-navigation";
import { cn } from "@/lib/utils";
import { getNewSystemCourseReadiness } from "@/lib/classroom/new-system-course";
import { CourseQualityReview, type TeacherReviewDecision } from "@/components/teacher/course-quality-review";
import { downloadCourseResources } from "@/lib/course-resources/download-course-resources";

const STEPS = [
  { key: "generate", label: "一键生成" },
  { key: "design", label: "课程设计" },
  { key: "publish", label: "发布中心" },
];

type PreviewView = "director" | "student";

type PublishCheck = {
  id: string;
  label: string;
  done: boolean;
  detail: string;
};

type ResourceRepairIssue = {
  id: string;
  type: "classroom" | "adaptive-resource" | "teaching-tool" | "tts" | "media" | "speech-sync";
  title: string;
  detail: string;
};

type ResourceRepairStatus = {
  status: "idle" | "running" | "completed" | "failed";
  error?: string;
  completed?: number;
  total?: number;
  failed?: number;
};

type PublicationState = {
  latestVersion: number | null;
  publishedVersion: number | null;
  draftVersion: number | null;
};

const SCENE_TYPE_LABEL: Record<string, string> = {
  slide: "AI 讲解",
  interactive: "互动探究",
  quiz: "达标检测",
  pbl: "项目任务",
};

function secondsLabel(seconds?: number): string {
  const value = Math.max(0, Math.round(seconds ?? 0));
  if (!value) return "未估时";
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  if (!minutes) return `${rest} 秒`;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function pageTypeClass(type?: string): string {
  if (type === "interactive") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (type === "quiz") return "border-violet-200 bg-violet-50 text-violet-800";
  if (type === "pbl") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-sky-200 bg-sky-50 text-sky-800";
}

function buildPublishChecks(course: Course): PublishCheck[] {
  return getNewSystemCourseReadiness(course).map((check) => ({
    id: check.id,
    label: check.label,
    done: check.ok,
    detail: check.ok ? "已完成。" : check.message,
  }));
}

export default function PreviewCoursePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useSession();
  const { user, publishCourse } = session;
  const course = useCourse(params?.id);
  const hydrated = useHydrated();
  const [publishing, setPublishing] = useState(false);
  const [view, setView] = useState<PreviewView>(searchParams.get("view") === "student" ? "student" : "director");
  const [selectedOutlineId, setSelectedOutlineId] = useState<string>();
  const [studentSidebarCollapsed, setStudentSidebarCollapsed] = useState(false);
  const [previewBranch, setPreviewBranch] = useState<AdaptiveBranchOutline>();
  const [resourceIssues, setResourceIssues] = useState<ResourceRepairIssue[]>([]);
  const [resourceAuditLoaded, setResourceAuditLoaded] = useState(false);
  const [resourceRepairStatus, setResourceRepairStatus] = useState<ResourceRepairStatus>({ status: "idle" });
  const [speechSyncStatus, setSpeechSyncStatus] = useState<ResourceRepairStatus>({ status: "idle" });
  const [resourceRepairVersion, setResourceRepairVersion] = useState(0);
  const [reviewDecision, setReviewDecision] = useState<TeacherReviewDecision>({ canConfirm: false, signature: "", acceptedIssueIds: [], acknowledgeFailedCheck: false });
  const [publishedHere, setPublishedHere] = useState(false);
  const [downloadingResources, setDownloadingResources] = useState(false);
  const [continuingFullCourse, setContinuingFullCourse] = useState(false);
  const [publicationState, setPublicationState] = useState<PublicationState | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    const controller = new AbortController();
    void fetch(`/api/courses/${params.id}/design-workspace`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<{ publication?: PublicationState }> : null)
      .then((payload) => { if (payload?.publication && !controller.signal.aborted) setPublicationState(payload.publication); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [params?.id]);

  useEffect(() => {
    if (!params?.id) return;
    const controller = new AbortController();
    void fetch(`/api/courses/${params.id}/resource-repair`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as {
        issues?: ResourceRepairIssue[];
        repair?: ResourceRepairStatus;
        syncRepair?: ResourceRepairStatus;
      };
      setResourceIssues(payload.issues ?? []);
      setResourceRepairStatus((current) =>
        current.status === "running" ? current : payload.repair ?? { status: "idle" },
      );
      setSpeechSyncStatus((current) =>
        current.status === "running" ? current : payload.syncRepair ?? { status: "idle" },
      );
    }).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setResourceAuditLoaded(true);
    });
    return () => controller.abort();
  }, [params?.id, resourceRepairVersion]);

  useEffect(() => {
    if (!params?.id || resourceRepairStatus.status !== "running") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/courses/${params.id}/resource-repair`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("无法读取资源修复进度");
        const payload = await response.json() as { issues?: ResourceRepairIssue[]; repair?: ResourceRepairStatus };
        if (controller.signal.aborted) return;
        const issues = payload.issues ?? [];
        const repair = payload.repair ?? { status: "completed" };
        setResourceIssues(issues);
        setResourceRepairStatus(repair);
        if (repair.status === "running") {
          timer = setTimeout(poll, 2_500);
        } else if (repair.status === "failed") {
          toast.error("资源重试失败", { description: repair.error || "请稍后重试" });
        } else {
          setResourceRepairVersion((value) => value + 1);
          if (issues.length === 0) toast.success("缺失资源已经补齐");
          else toast.warning("部分资源仍未生成", { description: `还剩 ${issues.length} 项，可稍后再次重试。` });
        }
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2_500);
      }
    };

    timer = setTimeout(poll, 1_000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [params?.id, resourceRepairStatus.status]);

  useEffect(() => {
    if (!params?.id || speechSyncStatus.status !== "running") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/courses/${params.id}/resource-repair`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("无法读取同步修复进度");
        const payload = await response.json() as {
          issues?: ResourceRepairIssue[];
          syncRepair?: ResourceRepairStatus;
        };
        if (controller.signal.aborted) return;
        setResourceIssues(payload.issues ?? []);
        const status = payload.syncRepair ?? { status: "completed" as const };
        setSpeechSyncStatus(status);
        if (status.status === "running") timer = setTimeout(poll, 2_500);
        else if (status.status === "failed") {
          toast.error("朗读与动作同步修复失败", { description: status.error || "请检查本机对齐服务后重试" });
        } else {
          setResourceRepairVersion((value) => value + 1);
          if ((status.failed ?? 0) > 0) {
            toast.warning("部分讲稿仍待同步", { description: `${status.failed} 段对齐失败，可稍后再次修复。` });
          } else toast.success("朗读、字幕与指示动作已经同步");
        }
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2_500);
      }
    };
    timer = setTimeout(poll, 1_000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [params?.id, speechSyncStatus.status]);

  if (!hydrated) {
    return (
      <DashboardShell backHref={courseDetailedEditHref(params.id)} backLabel="返回课程编辑" role="teacher" userName={user.name} variant="bare">
        <div className="grid min-h-72 place-items-center text-sm text-stone-500">正在打开课程发布中心…</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell backHref={courseDetailedEditHref(params.id)} backLabel="返回课程编辑" role="teacher" userName={user.name} variant="bare">
        <div className="grid min-h-72 place-items-center text-sm text-stone-500">
          <div className="text-center">
            <p>未找到课程。</p>
            <Link className="mt-3 inline-block font-semibold text-blue-700 hover:underline" href="/teacher/templates">返回课程列表</Link>
          </div>
        </div>
      </DashboardShell>
    );
  }

  const outlines = course.content._openmaicSceneOutlines ?? [];
  const classroomGenerationRun = course.content.classroomGenerationRun;
  const isTestLesson = classroomGenerationRun?.scope === "test-lesson";
  const testLessonTitle = classroomGenerationRun?.testLesson?.sectionTitle ?? "一个完整知识小节";
  const studentOutlines = outlines.filter((outline) => outline.audience !== "teacher");
  const selectedOutline = studentOutlines.find((outline) => outline.id === selectedOutlineId)
    ?? studentOutlines[0];
  const selectedToolPlan = normalizeTeachingToolPlan(selectedOutline?.teachingToolPlan);
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const adaptivePlan = course.content.adaptiveLearningPlan;
  const activeAdaptiveBranches = adaptivePlan?.branches.filter((branch) => branch.enabled !== false) ?? [];
  const hasDownloadableResources = Boolean(
    classroomId
    || course.content.teacherClassroomId
    || activeAdaptiveBranches.some((branch) => branch.preparedResource?.classroomId),
  );
  const requestedPreviewBranch = activeAdaptiveBranches.find(
    (branch) => branch.id === searchParams.get("adaptiveBranchId")
      && Boolean(branch.preparedResource?.classroomId),
  );
  const activePreviewBranch = previewBranch ?? requestedPreviewBranch;
  const publishChecks = buildPublishChecks(course);
  const reviewRequired = course.content.qualityReviewRequired === true || Number(course.content.resourcePackage?.schemaVersion ?? 0) >= 2 || Number(course.content.stagePlan?.schemaVersion ?? 0) >= 2;
  const prerequisiteChecks = getNewSystemCourseReadiness(course).filter((check) => check.id !== "teacher-review");
  const readyCount = prerequisiteChecks.filter((item) => item.ok).length;
  const readyToPublish = resourceAuditLoaded
    && !isTestLesson
    && readyCount === prerequisiteChecks.length
    && resourceIssues.length === 0
    && (!reviewRequired || reviewDecision.canConfirm);
  const pendingPublishCount = prerequisiteChecks.length - readyCount + resourceIssues.length + (reviewRequired && !reviewDecision.canConfirm ? 1 : 0);
  const isPublished = publishedHere || course.status === "ready"
    || course.status === "teaching"
    || course.status === "finished";
  const hasDesignDraft = course.status === "preparing" && Boolean(course.content.designWorkspaceRevision);
  const hasPublishedVersion = Boolean(publicationState?.publishedVersion);
  const totalStudentSeconds = studentOutlines.reduce(
    (sum, item) => sum + (item.targetDurationSec ?? item.estimatedDuration ?? 0),
    0,
  );
  const toolPageCount = studentOutlines.filter(
    (item) => normalizeTeachingToolPlan(item.teachingToolPlan).length > 0,
  ).length;
  const interactionCount = studentOutlines.filter((item) => item.type === "interactive").length;
  const courseId = course.id;

  async function publish() {
    if (isTestLesson) {
      toast.warning("测试样本不能发布", { description: "请返回课程生成页，切换为“完整课程”并完成正式生成。" });
      return;
    }
    setPublishing(true);
    try {
      if (reviewRequired) {
        const response = await fetch(`/api/courses/${courseId}/quality-review`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "confirm", ...reviewDecision, publish: true }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || "教师终审未保存。");
        setPublishedHere(true);
      } else publishCourse(courseId);
      toast.success("课程已发布", {
        description: "发布中心仍会保留，你可以继续核对教学编排或体验学生课堂。",
      });
    } catch (error) {
      toast.error("课程尚未达到发布条件", {
        description: error instanceof Error ? error.message : "请检查未完成项目。",
      });
    } finally {
      setPublishing(false);
    }
  }

  async function continueFullCourse() {
    if (!isTestLesson || continuingFullCourse) return;
    setContinuingFullCourse(true);
    try {
      const response = await fetch(`/api/courses/${courseId}/design-generation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote-test-lesson" }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; detail?: string };
      if (!response.ok) throw new Error(payload.detail || payload.error || "无法继续生成完整课程");
      toast.success("已开始生成完整课程", {
        description: "测试小节会保留，系统将按已确认大纲补齐其余页面和资源。",
      });
      router.push(`/teacher/prepare/${encodeURIComponent(courseId)}/verify`);
    } catch (error) {
      toast.error("完整课程尚未开始生成", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
      setContinuingFullCourse(false);
    }
  }

  async function retryMissingResources() {
    setResourceRepairStatus({ status: "running" });
    try {
      const response = await fetch(`/api/courses/${courseId}/resource-repair`, { method: "POST" });
      const payload = await response.json() as { issues?: ResourceRepairIssue[]; repair?: ResourceRepairStatus; error?: string };
      if (!response.ok) throw new Error(payload.error || "缺失资源重试失败");
      setResourceIssues(payload.issues ?? []);
      setResourceRepairStatus(payload.repair ?? { status: "running" });
      toast.info("已开始补齐缺失资源", { description: "音频会在后台继续生成，完成后此页面会自动更新。" });
    } catch (error) {
      setResourceRepairStatus({ status: "idle" });
      toast.error("资源重试失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  }

  async function repairSpeechSynchronization() {
    setSpeechSyncStatus({ status: "running", completed: 0, total: 0, failed: 0 });
    try {
      const response = await fetch(`/api/courses/${courseId}/resource-repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "speech-sync" }),
      });
      const payload = await response.json() as {
        issues?: ResourceRepairIssue[];
        syncRepair?: ResourceRepairStatus;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "同步修复未能开始");
      setResourceIssues(payload.issues ?? []);
      setSpeechSyncStatus(payload.syncRepair ?? { status: "running" });
      toast.info("已开始修复朗读与动作同步", {
        description: "系统会复用现有语音，只补齐字幕和动作时间线。",
      });
    } catch (error) {
      setSpeechSyncStatus({ status: "idle" });
      toast.error("同步修复未能开始", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  }

  async function downloadResources() {
    setDownloadingResources(true);
    try {
      await downloadCourseResources(courseId);
      toast.success("课程资源已开始下载", {
        description: "压缩包包含课程 PPT、讲稿、互动页面和原始教学资料。",
      });
    } catch (error) {
      toast.error("课程资源下载失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setDownloadingResources(false);
    }
  }

  function closeBranchPreview() {
    setPreviewBranch(undefined);
    if (requestedPreviewBranch) {
      router.replace(`/teacher/prepare/${courseId}/preview`, { scroll: false });
    }
  }

  function openReviewPage(outlineId: string) {
    if (!studentOutlines.some((outline) => outline.id === outlineId)) {
      toast.warning("该检查项不属于学生发布页", {
        description: "请使用问题卡片中的“定位并修改”进入课堂编辑器。",
      });
      return;
    }
    setSelectedOutlineId(outlineId);
    setView("director");
    requestAnimationFrame(() => {
      const workspace = document.getElementById("course-page-review");
      workspace?.scrollIntoView({ behavior: "smooth", block: "start" });
      workspace?.focus({ preventScroll: true });
    });
  }

  return (
    <DashboardShell
      backHref={courseDetailedEditHref(course.id)}
      backLabel="返回课程编辑"
      role="teacher"
      userName={user.name}
      variant="bare"
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
      headerSlot={<div className="ml-4 hidden min-w-0 lg:block"><WizardStepper current={2} steps={STEPS} /></div>}
    >
      <main>
        <header className="relative overflow-hidden rounded-[16px] border border-stone-200 bg-[radial-gradient(circle_at_92%_0%,rgba(254,215,170,0.34),transparent_34%),linear-gradient(120deg,#ffffff_0%,#fffdf8_100%)] px-5 py-5 shadow-[0_10px_32px_rgba(87,74,58,0.06)] sm:px-6">
          <div aria-hidden className="absolute bottom-0 left-16 right-0 h-px bg-gradient-to-r from-transparent via-amber-200 to-transparent" />
          <div className="relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-4 sm:flex sm:flex-wrap">
            <Link
              aria-label="返回课程编辑"
              className="grid size-10 shrink-0 place-items-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-sm transition hover:-translate-x-0.5 hover:border-[var(--pbl-teacher)] hover:text-[var(--pbl-teacher)] motion-reduce:transform-none"
              href={courseDetailedEditHref(course.id)}
            >
              <ArrowLeft size={17} />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--pbl-accent)]">
                <BookOpenCheck size={14} />
                <span>{isTestLesson ? "正式链路测试结果" : "课程发布中心 · 第 3 步"}</span>
              </div>
              <h1 className="mt-1 break-words font-editorial text-xl font-semibold leading-snug tracking-[-0.02em] text-stone-950 sm:truncate sm:text-[30px]" title={course.name}>{course.name}</h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-500">
                {[course.subject, course.grade].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-2">
              {isTestLesson ? <Pill tone="amber">测试一节 · 不可发布</Pill> : isPublished ? <Pill tone="green">当前发布版本{publicationState?.publishedVersion ? ` v${publicationState.publishedVersion}` : ""}</Pill> : hasDesignDraft && hasPublishedVersion ? <><Pill tone="green">当前发布 v{publicationState!.publishedVersion}</Pill><Pill tone="amber">有修改的草稿{publicationState?.draftVersion ? ` v${publicationState.draftVersion}` : ""} · 待完成 {pendingPublishCount} 项</Pill></> : <Pill tone={readyToPublish ? "blue" : "amber"}>{readyToPublish ? "未发布草稿 · 可以发布" : resourceAuditLoaded ? `未发布草稿 · 待完成 ${pendingPublishCount} 项` : "正在核对资源"}</Pill>}
              <Link
                className="inline-flex h-10 items-center gap-1.5 rounded-[7px] border border-stone-200 bg-white px-3.5 text-sm font-semibold text-stone-600 shadow-sm transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]"
                href={courseDetailedEditHref(course.id)}
              >
                <Edit3 size={15} /> 返回修改
              </Link>
              <button
                className="inline-flex h-10 items-center gap-1.5 rounded-[7px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-3.5 text-sm font-semibold text-[var(--pbl-teacher)] shadow-sm transition hover:bg-white disabled:cursor-wait disabled:opacity-60"
                disabled={downloadingResources || !hasDownloadableResources}
                onClick={() => void downloadResources()}
                type="button"
              >
                <Download className={downloadingResources ? "animate-bounce" : ""} size={15} />
                {downloadingResources ? "正在打包…" : "下载课程资源"}
              </button>
            </div>
          </div>
        </header>

        {isTestLesson ? (
          <section className="mt-5 rounded-[12px] border border-amber-300 bg-amber-50 px-5 py-4 text-amber-950">
            <div className="flex items-start gap-3">
              <FlaskConical className="mt-0.5 shrink-0" size={18} />
              <div>
                <h2 className="text-sm font-black">正在验收正式生成链路中的“{testLessonTitle}”</h2>
                <p className="mt-1 text-xs leading-5 text-amber-900">
                  本样本使用与完整课程相同的资源包解析、知识图谱、正式大纲、页面生成、审校、配图和语音逻辑，只把输出范围限制为 {studentOutlines.length} 页；完整大纲共 {classroomGenerationRun?.fullOutlineCount ?? studentOutlines.length} 页。确认效果后可直接继续生成，已完成的测试页面会保留并复用。
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-[12px] border border-stone-200 bg-white px-2 py-2 shadow-sm">
          <div aria-label="发布中心视图" className="flex flex-wrap gap-1" role="tablist">
            <ViewTab
              active={view === "director"}
              icon={<Layers3 size={16} />}
              label="教学编排与发布检查"
              onClick={() => setView("director")}
            />
            <ViewTab
              active={view === "student"}
              icon={<PlayCircle size={16} />}
              label="学生 AI 课堂实景"
              onClick={() => setView("student")}
              student
            />
            {classroomId ? (
              <Link
                className="inline-flex min-h-10 items-center gap-2 rounded-[8px] px-4 text-sm font-semibold text-[var(--pbl-teacher)] transition hover:bg-[var(--pbl-teacher-soft)]"
                href={`/teacher/prepare/${course.id}/classroom-editor`}
              >
                <Edit3 size={16} /> 编辑 AI 课堂
              </Link>
            ) : null}
          </div>
          <p className="hidden pr-3 text-xs text-stone-500 lg:block">
            {view === "director" ? "发布前总览" : "学生端完整课堂预览"}
          </p>
        </div>

        {view === "student" ? (
          <StudentClassroomExperience
            classroomId={classroomId}
            course={course}
            onBackToDirector={() => setView("director")}
            onSidebarCollapsedChange={setStudentSidebarCollapsed}
            sidebarCollapsed={studentSidebarCollapsed}
          />
        ) : (
          <>
            <section className="mt-5 grid gap-px overflow-hidden rounded-[12px] border border-stone-200 bg-stone-200 shadow-sm sm:grid-cols-2 xl:grid-cols-4">
              <Metric icon={<BookOpenCheck size={17} />} label="学生学习页面" value={`${studentOutlines.length} 页`} />
              <Metric icon={<Clock3 size={17} />} label="AI 课堂估时" value={secondsLabel(totalStudentSeconds)} />
              <Metric icon={<Presentation size={17} />} label="已规划工具页面" value={`${toolPageCount} 页`} />
              <Metric icon={<Sparkles size={17} />} label="互动探究页面" value={`${interactionCount} 页`} />
            </section>

            {resourceIssues.some((issue) => issue.type !== "speech-sync") ? (
              <section className="mt-5 rounded-[12px] border border-amber-200 bg-amber-50/70 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-black text-amber-950">还有 {resourceIssues.filter((issue) => issue.type !== "speech-sync").length} 项课程资源需要补充</h2>
                    <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-900">
                      {resourceIssues.filter((issue) => issue.type !== "speech-sync").map((issue) => (
                        <li className="flex flex-wrap items-center gap-x-2" key={issue.id}>
                          <span>• {issue.title}：{issue.detail}</span>
                          <Link className="font-bold text-[var(--pbl-teacher)] hover:underline" href={`${courseDetailedEditHref(course.id)}?section=classroom`}>
                            定位并修改
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Button loading={resourceRepairStatus.status === "running"} onClick={() => void retryMissingResources()}>
                    <RotateCcw size={14} />一键重试缺失资源
                  </Button>
                </div>
              </section>
            ) : null}

            {classroomId ? (
              <section className={cn(
                "mt-5 rounded-[12px] border px-5 py-4",
                resourceIssues.some((issue) => issue.type === "speech-sync")
                  ? "border-violet-200 bg-violet-50/70"
                  : "border-emerald-200 bg-emerald-50/70",
              )}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-black text-stone-950">朗读、字幕与指示动作同步</h2>
                    {speechSyncStatus.status === "running" ? (
                      <p className="mt-2 text-xs leading-5 text-violet-900">
                        正在对齐语音 {speechSyncStatus.completed ?? 0} / {speechSyncStatus.total || "…"}
                      </p>
                    ) : resourceIssues.some((issue) => issue.type === "speech-sync") ? (
                      <ul className="mt-2 space-y-1 text-xs leading-5 text-violet-900">
                        {resourceIssues.filter((issue) => issue.type === "speech-sync").map((issue) => (
                          <li key={issue.id}>• {issue.title}：{issue.detail}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs leading-5 text-emerald-900">现有语音已建立音频时间线。</p>
                    )}
                  </div>
                  <Button loading={speechSyncStatus.status === "running"} onClick={() => void repairSpeechSynchronization()}>
                    <RotateCcw size={14} />修复朗读与动作同步
                  </Button>
                </div>
              </section>
            ) : null}

            <CoursePublicationOverview course={course} />

            {reviewRequired && !isTestLesson ? <CourseQualityReview
              courseId={courseId}
              onDecisionChange={setReviewDecision}
              onOpenPage={openReviewPage}
            /> : null}

            <section className="mt-5 grid min-h-[620px] scroll-mt-24 overflow-hidden rounded-[12px] border border-stone-200 bg-white outline-none xl:grid-cols-[280px_minmax(0,1fr)_330px]" id="course-page-review" tabIndex={-1}>
              <LessonPageRail
                onSelect={setSelectedOutlineId}
                outlines={studentOutlines}
                selectedId={selectedOutline?.id}
              />
              <SelectedPageBrief
                onOpenStudentView={() => setView("student")}
                outline={selectedOutline}
                toolPlan={selectedToolPlan}
              />
              <PublishReadiness checks={publishChecks} course={course} />
            </section>

            <TeachingToolRunbook
              classroomId={classroomId}
              className="mt-5"
              key={resourceRepairVersion}
              outlines={studentOutlines}
              title="AI 教学工具执行核对"
            />

            {adaptivePlan ? (
              <div className="mt-5">
                <CoursePublishPathPreview
                  mainScenes={studentOutlines}
                  onPreviewBranch={setPreviewBranch}
                  plan={adaptivePlan}
                />
              </div>
            ) : null}
          </>
        )}
      </main>

      {activePreviewBranch?.preparedResource?.classroomId ? (
        <BranchClassroomPreview
          branch={activePreviewBranch}
          course={course}
          onClose={closeBranchPreview}
        />
      ) : null}

      <FlowActionBar
        persistent
        back={<Link className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--pbl-text-muted)]" href={courseDetailedEditHref(course.id)}>上一步</Link>}
        saveStatus={<SaveStatus lastSavedAt={session.lastSavedAt} state={session.saveState} onRetry={() => void session.retrySave()} />}
      >
        {isTestLesson ? (
          <Button loading={continuingFullCourse} onClick={() => void continueFullCourse()}>
            {continuingFullCourse ? "正在启动完整课程" : "继续生成完整课程"}
          </Button>
        ) : !isPublished ? (
          <Button disabled={!readyToPublish || publishing} loading={publishing} onClick={() => void publish()}>{reviewRequired ? "确认并发布" : "发布课程"}</Button>
        ) : (
          <Button onClick={() => router.push(`/teacher/teach/${course.id}/setup`)}>开始授课</Button>
        )}
      </FlowActionBar>
    </DashboardShell>
  );
}

function ViewTab({
  active,
  icon,
  label,
  onClick,
  student = false,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  student?: boolean;
}) {
  return (
    <button
      aria-selected={active}
      className={cn(
        "relative inline-flex min-h-10 items-center gap-2 rounded-[8px] px-4 text-sm font-semibold transition",
        active
          ? student
            ? "bg-[var(--pbl-student-soft)] text-[var(--pbl-student)] shadow-sm"
            : "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)] shadow-sm"
          : "text-stone-500 hover:bg-stone-50 hover:text-stone-800",
      )}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {icon}{label}
    </button>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 bg-white px-4 py-4">
      <span className="grid size-9 place-items-center rounded-[8px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]">{icon}</span>
      <div><p className="text-[11px] font-semibold text-stone-500">{label}</p><p className="mt-0.5 text-base font-black text-stone-950">{value}</p></div>
    </div>
  );
}

function LessonPageRail({
  onSelect,
  outlines,
  selectedId,
}: {
  onSelect: (id: string) => void;
  outlines: ReadonlyArray<OpenMaicSceneOutlineSnapshot>;
  selectedId?: string;
}) {
  return (
    <aside className="border-b border-stone-200 bg-stone-50/65 xl:border-b-0 xl:border-r">
      <header className="border-b border-stone-200 px-4 py-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-stone-400">学生学习时间线</p>
        <h2 className="mt-1 text-sm font-black text-stone-900">逐页检查课程节奏</h2>
      </header>
      {outlines.length ? (
        <ol className="max-h-[720px] overflow-y-auto px-2 py-2">
          {outlines.map((outline, index) => {
            const selected = outline.id === selectedId;
            const tools = normalizeTeachingToolPlan(outline.teachingToolPlan);
            return (
              <li key={outline.id}>
                <button
                  className={cn(
                    "group flex w-full gap-3 rounded-[8px] px-3 py-3 text-left transition",
                    selected ? "bg-white shadow-sm ring-1 ring-[var(--pbl-teacher-border)]" : "hover:bg-white/80",
                  )}
                  onClick={() => onSelect(outline.id)}
                  type="button"
                >
                  <span className={cn(
                    "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-black",
                    selected ? "bg-[var(--pbl-teacher)] text-white" : "bg-stone-200 text-stone-600 group-hover:bg-[var(--pbl-teacher-soft)] group-hover:text-[var(--pbl-teacher)]",
                  )}>{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-stone-900">{outline.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1 text-[10px] font-semibold text-stone-500">
                      <span>{SCENE_TYPE_LABEL[outline.type ?? "slide"] ?? "课程页面"}</span>
                      <span>·</span>
                      <span>{secondsLabel(outline.targetDurationSec ?? outline.estimatedDuration)}</span>
                      {tools.length ? <span className="rounded-full bg-[var(--pbl-teacher-soft)] px-1.5 py-0.5 text-[var(--pbl-teacher)]">{tools.length} 个工具</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="px-4 py-8 text-center text-xs leading-5 text-stone-500">尚未生成学生课堂页面。</p>
      )}
    </aside>
  );
}

function SelectedPageBrief({
  onOpenStudentView,
  outline,
  toolPlan,
}: {
  onOpenStudentView: () => void;
  outline?: OpenMaicSceneOutlineSnapshot;
  toolPlan: ReturnType<typeof normalizeTeachingToolPlan>;
}) {
  if (!outline) {
    return <div className="grid min-h-80 place-items-center p-8 text-center text-sm text-stone-500">没有可检查的学生学习页面。</div>;
  }
  return (
    <article className="min-w-0 border-b border-stone-200 p-5 sm:p-7 xl:border-b-0 xl:border-r">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-bold", pageTypeClass(outline.type))}>
          {SCENE_TYPE_LABEL[outline.type ?? "slide"] ?? "课程页面"}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-stone-500"><Clock3 size={12} /> {secondsLabel(outline.targetDurationSec ?? outline.estimatedDuration)}</span>
      </div>
      <h2 className="mt-4 font-editorial text-2xl font-semibold text-stone-950">{outline.title}</h2>
      <p className="mt-3 text-sm leading-7 text-stone-600">{outline.description || "本页尚未填写教学说明。"}</p>

      <section className="mt-6">
        <h3 className="text-xs font-black uppercase tracking-[0.13em] text-stone-500">本页必须讲清</h3>
        <ol className="mt-3 grid gap-2 sm:grid-cols-2">
          {(outline.keyPoints ?? []).map((point, index) => (
            <li className="flex gap-2 rounded-[8px] border border-stone-200 bg-stone-50/60 px-3 py-2.5 text-xs leading-5 text-stone-700" key={`${outline.id}-${point}`}>
              <span className="font-black text-[var(--pbl-teacher)]">{String(index + 1).padStart(2, "0")}</span>
              <span>{point}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-6 rounded-[10px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/45 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-black text-stone-950"><Presentation className="text-[var(--pbl-teacher)]" size={16} /> 本页呈现方式</h3>
          <span className="text-[10px] font-bold text-[var(--pbl-teacher)]">{toolPlan.length ? "包含教学工具" : "页面直接呈现"}</span>
        </div>
        {toolPlan.length ? (
          <div className="mt-3 space-y-3">
            {toolPlan.map((item) => (
              <div className="border-l-2 border-[var(--pbl-teacher)] pl-3" key={item.id}>
                <p className="text-xs font-bold text-stone-900">{item.tool === "whiteboard" ? "AI 白板" : item.tool === "interactive-widget" ? "互动组件" : item.tool === "spotlight" ? "聚光标注" : "激光指示"}</p>
                <p className="mt-1 text-xs leading-5 text-stone-600"><strong>何时触发：</strong>{item.trigger}</p>
                <p className="mt-1 text-xs leading-5 text-stone-600"><strong>呈现内容：</strong>{item.content.join("；")}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs leading-5 text-stone-600">本页内容由课件或互动页面完整呈现，无需额外调用教学工具。</p>
        )}
      </section>

      <button
        className="mt-6 inline-flex h-10 items-center gap-2 rounded-[7px] bg-[var(--pbl-teacher)] px-4 text-xs font-bold text-white transition hover:bg-[var(--pbl-teacher-hover)]"
        onClick={onOpenStudentView}
        type="button"
      >
        <Eye size={15} /> 进入学生课堂实景查看
      </button>
    </article>
  );
}

const PUBLISH_SECTION_BY_CHECK: Record<string, CourseDesignWorkspaceSectionKey | undefined> = {
  basics: "materials",
  stages: "stage-plan",
  timing: "timing",
  "ai-outline": "blueprint",
  "ai-classroom": "classroom",
  "full-classroom-generation": "classroom",
  "design-workspace-freshness": "classroom",
};

function CoursePublicationOverview({ course }: { course: Course }) {
  const stagePlan = course.content.stagePlan;
  const lectureSections = course.content.knowledgeLectureSections ?? [];
  const timing = course.content.moduleTimingPlan;
  const audit = course.content.teachingTimingAudit;
  const review = course.content.teacherReview;
  return (
    <section className="mt-5 overflow-hidden rounded-[12px] border border-stone-200 bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-stone-400">课程发布总览</p>
          <h2 className="mt-1 text-base font-black text-stone-900">教学安排、知识小节与资源状态</h2>
        </div>
        <Link className="inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-stone-300 px-3 text-xs font-bold text-stone-700" href={`${courseDetailedEditHref(course.id)}?section=stage-plan`}><Edit3 size={14} />定位并修改</Link>
      </header>
      <div className="grid gap-px bg-stone-200 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="bg-white p-5">
          <h3 className="text-xs font-black text-stone-500">五阶段课堂安排</h3>
          {stagePlan?.stages.length ? <ol className="mt-4 grid gap-2 sm:grid-cols-5">{stagePlan.stages.map((stage, index) => <li className="rounded-[8px] border border-stone-200 p-3" key={stage.key}><span className="text-[10px] font-black text-[var(--pbl-teacher)]">{String(index + 1).padStart(2, "0")}</span><p className="mt-1 text-xs font-bold text-stone-900">{stage.title}</p><p className="mt-2 text-[11px] text-stone-500">{stage.durationMin ?? 0} 分钟</p></li>)}</ol> : <p className="mt-4 text-sm text-stone-500">五阶段安排尚未生成。</p>}
          <div className="mt-6 flex items-center justify-between gap-3"><h3 className="text-xs font-black text-stone-500">知识讲授小节</h3><Link className="text-xs font-bold text-[var(--pbl-teacher)] hover:underline" href={`${courseDetailedEditHref(course.id)}?section=blueprint`}>查看教学蓝图</Link></div>
          {lectureSections.length ? <div className="mt-3 divide-y divide-stone-100 border-y border-stone-100">{lectureSections.map((section, index) => <div className="flex items-center gap-3 py-3" key={section.id}><span className="grid size-7 shrink-0 place-items-center rounded-full bg-stone-100 text-[10px] font-black text-stone-600">{index + 1}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-stone-900">{section.title}</p><p className="mt-1 text-[11px] text-stone-500">{section.sceneOutlineIds.length} 个讲授页面 + 1 个检测 · 约 {section.estimatedMinutes} 分钟</p></div><Link className="text-[11px] font-bold text-[var(--pbl-teacher)]" href={`${courseDetailedEditHref(course.id)}?section=classroom&lectureSectionId=${encodeURIComponent(section.id)}`}>定位</Link></div>)}</div> : <p className="mt-3 text-sm text-stone-500">知识讲授小节尚未生成。</p>}
        </div>
        <aside className="bg-stone-50 p-5">
          <h3 className="text-xs font-black text-stone-500">时长与终审</h3>
          <dl className="mt-4 space-y-4">
            <div><dt className="text-[11px] text-stone-500">知识讲授规划</dt><dd className="mt-1 text-lg font-black text-stone-900">{timing ? `${timing.totalMinutes} 分钟` : "未规划"}</dd></div>
            <div><dt className="text-[11px] text-stone-500">实际讲授音频</dt><dd className="mt-1 text-sm font-bold text-stone-900">{audit ? secondsLabel(audit.substantiveTeachingDurationSec) : "尚未形成完整测量"}</dd><p className="mt-1 text-[11px] text-stone-500">{audit?.narrationDurationSource === "actual-audio" ? "来自实际音频" : audit ? "来自讲稿估算" : "生成或修改音频后更新"}</p></div>
            <div><dt className="text-[11px] text-stone-500">教师终审</dt><dd className={cn("mt-1 text-sm font-bold", review ? "text-emerald-700" : "text-amber-700")}>{review ? `已确认 · ${new Date(review.confirmedAt).toLocaleDateString("zh-CN")}` : "等待教师确认"}</dd></div>
          </dl>
        </aside>
      </div>
    </section>
  );
}

function PublishReadiness({ checks, course }: { checks: PublishCheck[]; course: Course }) {
  const readyCount = checks.filter((item) => item.done).length;
  const percentage = Math.round((readyCount / Math.max(1, checks.length)) * 100);
  return (
    <aside className="bg-white">
      <header className="border-b border-stone-200 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-stone-400">发布门槛</p>
            <h2 className="mt-1 text-sm font-black text-stone-900">{readyCount}/{checks.length} 项已通过</h2>
          </div>
          <span className={cn(
            "grid size-11 place-items-center rounded-full text-xs font-black ring-4",
            percentage === 100 ? "bg-emerald-100 text-emerald-800 ring-emerald-50" : "bg-amber-100 text-amber-800 ring-amber-50",
          )}>{percentage}%</span>
        </div>
      </header>
      <ul className="divide-y divide-stone-100">
        {checks.map((item) => {
          const section = item.id === "design-workspace-freshness"
            ? course.content.designWorkspaceRevision?.pendingUpdates[0]?.target ?? "classroom"
            : PUBLISH_SECTION_BY_CHECK[item.id];
          return (
          <li className="flex gap-3 px-5 py-3.5" key={item.label}>
            <span className={cn(
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
              item.done ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
            )}>
              {item.done ? <Check size={12} /> : <AlertTriangle size={11} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-stone-900">{item.label}</p>
              <p className="mt-1 text-[11px] leading-5 text-stone-500">{item.detail}</p>
              {!item.done && section ? <Link className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--pbl-teacher)] hover:underline" href={`${courseDetailedEditHref(course.id)}?section=${section}`}>定位并修改 <ArrowRight size={11} /></Link> : null}
            </div>
          </li>
          );
        })}
      </ul>
    </aside>
  );
}

function StudentClassroomExperience({
  classroomId,
  course,
  onBackToDirector,
  onSidebarCollapsedChange,
  sidebarCollapsed,
}: {
  classroomId?: string;
  course: Course;
  onBackToDirector: () => void;
  onSidebarCollapsedChange: (collapsed: boolean) => void;
  sidebarCollapsed: boolean;
}) {
  return (
    <section className="mt-5 overflow-hidden rounded-[12px] border border-stone-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 bg-[var(--pbl-surface-soft)]/55 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-[8px] border border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]"><MonitorPlay size={18} /></span>
          <div>
            <p className="text-sm font-black text-stone-900">学生 AI 课堂实景</p>
            <p className="mt-0.5 text-[11px] text-stone-500">与正式课堂播放器一致；预览期间不记录学生进度。</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)] px-2.5 py-1 text-[10px] font-bold text-[var(--pbl-success)]"><ShieldCheck size={12} /> 安全预览</span>
          <button className="h-9 rounded-[7px] border border-stone-200 bg-white px-3 text-xs font-bold text-stone-600 hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]" onClick={onBackToDirector} type="button">返回发布总览</button>
        </div>
      </header>
      {classroomId ? (
        <div className="bg-stone-100 p-2 sm:p-3">
          <StudentStageHost
            backHref={`/teacher/prepare/${course.id}/preview`}
            className="h-[min(820px,calc(100dvh-190px))] min-h-[520px] overflow-hidden rounded-[9px] border border-stone-200 bg-white lg:min-h-[650px]"
            classroomId={classroomId}
            courseId={course.id}
            knowledgeGraph={course.content.knowledgeGraph}
            knowledgePoints={course.content.knowledgePoints}
            mode="teacher-preview"
            onSidebarCollapsedChange={onSidebarCollapsedChange}
            sidebarCollapsed={sidebarCollapsed}
            variant="embedded"
          />
        </div>
      ) : (
        <div className="grid min-h-[520px] place-items-center bg-white px-6 text-center">
          <div className="max-w-md">
            <Gauge className="mx-auto text-stone-300" size={36} />
            <h2 className="mt-4 text-lg font-black text-stone-900">学生课堂尚未生成</h2>
            <p className="mt-2 text-sm leading-6 text-stone-500">完成学生 AI 课堂生成后，即可在此查看完整播放器、互动内容与教学工具。</p>
            <Link className="mt-5 inline-flex h-10 items-center rounded-[7px] bg-[var(--pbl-teacher)] px-4 text-xs font-bold text-white hover:bg-[var(--pbl-teacher-hover)]" href={`/teacher/prepare/${course.id}/generate`}>返回生成课程</Link>
          </div>
        </div>
      )}
    </section>
  );
}

function BranchClassroomPreview({
  branch,
  course,
  onClose,
}: {
  branch: AdaptiveBranchOutline;
  course: Course;
  onClose: () => void;
}) {
  const classroomId = branch.preparedResource?.classroomId;
  if (!classroomId) return null;
  return (
    <div aria-label={`${branch.title}课堂实景`} aria-modal="true" className="fixed inset-0 z-[120] grid place-items-center bg-stone-950/70 p-3 backdrop-blur-sm" role="dialog">
      <div className="flex h-[min(900px,calc(100dvh-24px))] w-full max-w-[1220px] min-w-0 flex-col overflow-hidden rounded-[14px] border border-white/20 bg-white shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-800">个性化插入资源 · 学生实景</p>
            <h3 className="mt-0.5 text-sm font-black text-stone-900">{branch.title}</h3>
          </div>
          <button aria-label="关闭课堂实景" className="grid size-11 shrink-0 place-items-center rounded-full text-stone-500 hover:bg-stone-100" onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <StudentStageHost
          backHref={`/teacher/prepare/${course.id}/preview`}
          classroomId={classroomId}
          className="min-h-0 flex-1"
          mode="teacher-preview"
          standalone
          variant="embedded"
        />
      </div>
    </div>
  );
}
