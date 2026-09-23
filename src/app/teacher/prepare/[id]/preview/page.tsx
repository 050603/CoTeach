"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
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
  Route,
  ShieldCheck,
  RotateCcw,
  X,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { WizardStepper } from "@/components/wizard-stepper";
import { Button, FlowActionBar, Pill, SaveStatus, toast } from "@/components/ui";
import { buttonVariants } from "@/components/ui/button";
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
import {
  CourseQualityReview,
  type CourseQualityReviewSummary,
  type TeacherReviewDecision,
} from "@/components/teacher/course-quality-review";
import { downloadCourseResources } from "@/lib/course-resources/download-course-resources";
import styles from "./page.module.css";

const STEPS = [
  { key: "generate", label: "一键生成" },
  { key: "design", label: "课程设计" },
  { key: "publish", label: "发布中心" },
];

type PreviewView = "overview" | "pages" | "checks" | "student";

const PREVIEW_VIEWS: PreviewView[] = ["overview", "pages", "checks", "student"];

function parsePreviewView(value: string | null): PreviewView {
  if (value === "director" || !value) return "overview";
  return PREVIEW_VIEWS.includes(value as PreviewView) ? value as PreviewView : "overview";
}

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
  const view = parsePreviewView(searchParams.get("view"));
  const [selectedOutlineId, setSelectedOutlineId] = useState<string>();
  const [studentSidebarCollapsed, setStudentSidebarCollapsed] = useState(false);
  const [previewBranch, setPreviewBranch] = useState<AdaptiveBranchOutline>();
  const [resourceIssues, setResourceIssues] = useState<ResourceRepairIssue[]>([]);
  const [resourceAuditLoaded, setResourceAuditLoaded] = useState(false);
  const [resourceAuditError, setResourceAuditError] = useState("");
  const [resourceRepairStatus, setResourceRepairStatus] = useState<ResourceRepairStatus>({ status: "idle" });
  const [speechSyncStatus, setSpeechSyncStatus] = useState<ResourceRepairStatus>({ status: "idle" });
  const [resourceRepairVersion, setResourceRepairVersion] = useState(0);
  const [reviewDecision, setReviewDecision] = useState<TeacherReviewDecision>({ canConfirm: false, signature: "", acceptedIssueIds: [], acknowledgeFailedCheck: false });
  const [publishedHere, setPublishedHere] = useState(false);
  const [downloadingResources, setDownloadingResources] = useState(false);
  const [continuingFullCourse, setContinuingFullCourse] = useState(false);
  const [publicationState, setPublicationState] = useState<PublicationState | null>(null);
  const [reviewSummary, setReviewSummary] = useState<CourseQualityReviewSummary | null>(null);

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
      if (!response.ok) throw new Error("课程资源状态暂时无法读取");
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
      setResourceAuditError("");
    }).catch((error) => {
      if (!controller.signal.aborted) {
        setResourceAuditError(error instanceof Error ? error.message : "课程资源状态暂时无法读取");
      }
    }).finally(() => {
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
  const prerequisitePublishChecks = publishChecks.filter((check) => check.id !== "teacher-review");
  const readyCount = prerequisiteChecks.filter((item) => item.ok).length;
  const readyToPublish = resourceAuditLoaded
    && !resourceAuditError
    && !isTestLesson
    && readyCount === prerequisiteChecks.length
    && resourceIssues.length === 0
    && (!reviewRequired || reviewDecision.canConfirm);
  const pendingPublishCount = prerequisiteChecks.length - readyCount
    + resourceIssues.length
    + (resourceAuditError ? 1 : 0)
    + (reviewRequired && !reviewDecision.canConfirm ? 1 : 0);
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
  const missingResourceIssues = resourceIssues.filter((issue) => issue.type !== "speech-sync");
  const speechSyncIssues = resourceIssues.filter((issue) => issue.type === "speech-sync");
  const courseId = course.id;
  const publishBlockReason = !resourceAuditLoaded
    ? "正在核对课程资源"
    : resourceAuditError
      ? "资源状态读取失败，请重试"
      : prerequisiteChecks.length !== readyCount
        ? `还有 ${prerequisiteChecks.length - readyCount} 项发布条件未完成`
        : resourceIssues.length
          ? `还有 ${resourceIssues.length} 项课程资源需要处理`
          : reviewRequired && !reviewDecision.canConfirm
            ? reviewSummary?.status === "blocked" ? "终审存在必须处理的问题" : "等待教师确认当前版本"
            : undefined;

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
    setResourceAuditError("");
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
      const next = new URLSearchParams(searchParams.toString());
      next.delete("adaptiveBranchId");
      router.replace(`/teacher/prepare/${courseId}/preview?${next.toString()}`, { scroll: false });
    }
  }

  function selectView(nextView: PreviewView) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("view", nextView);
    router.replace(`/teacher/prepare/${courseId}/preview?${next.toString()}`, { scroll: false });
  }

  function openReviewPage(outlineId: string) {
    if (!studentOutlines.some((outline) => outline.id === outlineId)) {
      toast.warning("该检查项不属于学生发布页", {
        description: "请使用问题卡片中的“定位并修改”进入课堂编辑器。",
      });
      return;
    }
    setSelectedOutlineId(outlineId);
    selectView("pages");
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
      wide
    >
      <main>
        <header className="rounded-[12px] border border-stone-200 bg-white px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="min-w-[240px] flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--pbl-teacher)]">
                  <BookOpenCheck size={13} />
                  {isTestLesson ? "正式链路测试结果" : "课程发布中心"}
                </span>
                <span className="text-xs text-stone-400">{[course.subject, course.grade].filter(Boolean).join(" · ")}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-lg font-bold leading-snug text-stone-950 sm:text-xl" title={course.name}>{course.name}</h1>
                {isTestLesson ? <Pill tone="amber">测试一节 · 不可发布</Pill> : isPublished ? <Pill tone="green">当前发布版本{publicationState?.publishedVersion ? ` v${publicationState.publishedVersion}` : ""}</Pill> : hasDesignDraft && hasPublishedVersion ? <><Pill tone="green">当前发布 v{publicationState!.publishedVersion}</Pill><Pill tone="amber">草稿{publicationState?.draftVersion ? ` v${publicationState.draftVersion}` : ""} · 待完成 {pendingPublishCount} 项</Pill></> : <Pill tone={readyToPublish ? "blue" : "amber"}>{readyToPublish ? "未发布 · 可以发布" : resourceAuditLoaded ? `待完成 ${pendingPublishCount} 项` : "正在核对资源"}</Pill>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:justify-end">
              <Link className={buttonVariants({ variant: "outline", className: "min-h-11" })} href={courseDetailedEditHref(course.id)}><Edit3 size={15} />编辑课程设计</Link>
              {classroomId ? <Link className={buttonVariants({ variant: "outline", className: "min-h-11" })} href={`/teacher/prepare/${course.id}/classroom-editor`}><Presentation size={15} />编辑 AI 课堂</Link> : null}
              <Button
                className="min-h-11"
                disabled={downloadingResources || !hasDownloadableResources}
                loading={downloadingResources}
                onClick={() => void downloadResources()}
                variant="outline"
                type="button"
              >
                <Download size={15} />
                {downloadingResources ? "正在打包…" : "下载课程资源"}
              </Button>
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

        <div className="mt-3 overflow-x-auto border-b border-stone-200" onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
          const target = event.key === "Home" ? 0
            : event.key === "End" ? tabs.length - 1
              : event.key === "ArrowRight" ? (current + 1) % tabs.length
                : (current - 1 + tabs.length) % tabs.length;
          event.preventDefault();
          tabs[target]?.focus();
          tabs[target]?.click();
        }}>
          <div aria-label="发布中心视图" className="flex min-w-max gap-1" role="tablist">
            <ViewTab active={view === "overview"} icon={<Layers3 size={16} />} id="overview" label="课程总览" onClick={() => selectView("overview")} />
            <ViewTab active={view === "pages"} icon={<BookOpenCheck size={16} />} id="pages" label="逐页审阅" onClick={() => selectView("pages")} />
            <ViewTab active={view === "checks"} icon={<ShieldCheck size={16} />} id="checks" label="检查与终审" onClick={() => selectView("checks")} />
            <ViewTab active={view === "student"} icon={<PlayCircle size={16} />} id="student" label="学生课堂预览" onClick={() => selectView("student")} student />
          </div>
        </div>

        <div className={view === "student" ? "mt-5" : styles.workspace}>
          <div className={view === "student" ? "min-w-0" : styles.mainPanel}>
            {view === "overview" ? <div aria-labelledby="publish-tab-overview" id="publish-panel-overview" role="tabpanel">
              <section className="grid gap-px overflow-hidden rounded-[12px] border border-stone-200 bg-stone-200 sm:grid-cols-2 xl:grid-cols-4">
                <Metric icon={<BookOpenCheck size={17} />} label="学生学习页面" value={`${studentOutlines.length} 页`} />
                <Metric icon={<Clock3 size={17} />} label="AI 课堂估时" value={secondsLabel(totalStudentSeconds)} />
                <Metric icon={<Presentation size={17} />} label="已规划工具页面" value={`${toolPageCount} 页`} />
                <Metric icon={<Route size={17} />} label="互动探究页面" value={`${interactionCount} 页`} />
              </section>
              <CoursePublicationOverview course={course} />
              {adaptivePlan ? <details className="mt-5 overflow-hidden rounded-[12px] border border-stone-200 bg-white">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-bold text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-teacher)]">
                  <span>个性化学习路径</span>
                  <span className="text-xs font-semibold text-stone-500">{activeAdaptiveBranches.length} 条分支 · 展开查看</span>
                </summary>
                <div className="border-t border-stone-200">
                  <CoursePublishPathPreview mainScenes={studentOutlines} onPreviewBranch={setPreviewBranch} plan={adaptivePlan} />
                </div>
              </details> : null}
            </div> : null}

            {view === "pages" ? <section aria-labelledby="publish-tab-pages" className="grid min-h-[560px] scroll-mt-24 overflow-hidden rounded-[12px] border border-stone-200 bg-white outline-none lg:grid-cols-[260px_minmax(0,1fr)]" id="course-page-review" role="tabpanel" tabIndex={-1}>
              <LessonPageRail onSelect={setSelectedOutlineId} outlines={studentOutlines} selectedId={selectedOutline?.id} />
              <SelectedPageBrief onOpenStudentView={() => selectView("student")} outline={selectedOutline} toolPlan={selectedToolPlan} />
            </section> : null}

            {reviewRequired && !isTestLesson ? <CourseQualityReview
              courseId={courseId}
              onDecisionChange={setReviewDecision}
              onOpenPage={openReviewPage}
              onSummaryChange={setReviewSummary}
              visible={view === "checks"}
            /> : view === "checks" ? <section className="rounded-[12px] border border-stone-200 bg-white px-6 py-10 text-center text-sm text-stone-500">当前课程无需单独完成教师终审。</section> : null}

            {view === "checks" ? <details className="mt-5 overflow-hidden rounded-[12px] border border-stone-200 bg-white">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-bold text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-teacher)]">
                <span>AI 教学工具执行核对</span>
                <span className="text-xs font-semibold text-stone-500">按需展开</span>
              </summary>
              <TeachingToolRunbook classroomId={classroomId} key={resourceRepairVersion} outlines={studentOutlines} title="AI 教学工具执行核对" />
            </details> : null}

            {view === "student" ? <StudentClassroomExperience
              classroomId={classroomId}
              course={course}
              onBackToDirector={() => selectView("overview")}
              onSidebarCollapsedChange={setStudentSidebarCollapsed}
              sidebarCollapsed={studentSidebarCollapsed}
            /> : null}
          </div>

          {view !== "student" ? <PublicationStatusRail
            auditLoaded={resourceAuditLoaded}
            auditError={resourceAuditError}
            checks={prerequisitePublishChecks}
            course={course}
            missingResourceIssues={missingResourceIssues}
            onOpenReview={() => selectView("checks")}
            onRepairResources={() => void retryMissingResources()}
            onRepairSpeech={() => void repairSpeechSynchronization()}
            onRetryAudit={() => setResourceRepairVersion((value) => value + 1)}
            repairStatus={resourceRepairStatus}
            reviewRequired={reviewRequired}
            reviewSummary={reviewSummary}
            speechStatus={speechSyncStatus}
            speechSyncIssues={speechSyncIssues}
          /> : null}
        </div>
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
        saveStatus={<div className="flex min-w-0 items-center gap-3">
          <SaveStatus lastSavedAt={session.lastSavedAt} state={session.saveState} onRetry={() => void session.retrySave()} />
          {!isPublished && publishBlockReason ? <span className="truncate text-xs text-amber-700">{publishBlockReason}</span> : null}
        </div>}
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
  id,
  label,
  onClick,
  student = false,
}: {
  active: boolean;
  icon: React.ReactNode;
  id: PreviewView;
  label: string;
  onClick: () => void;
  student?: boolean;
}) {
  return (
    <button
      aria-controls={`publish-panel-${id}`}
      aria-selected={active}
      className={cn(
        "relative inline-flex min-h-11 items-center gap-2 rounded-t-[8px] border-b-2 px-4 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-teacher)]",
        active
          ? student
            ? "border-[var(--pbl-student)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]"
            : "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"
          : "border-transparent text-stone-500 hover:bg-stone-50 hover:text-stone-800",
      )}
      id={`publish-tab-${id}`}
      onClick={onClick}
      role="tab"
      tabIndex={active ? 0 : -1}
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
  return (
    <section className="mt-5 overflow-hidden rounded-[12px] border border-stone-200 bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-stone-400">课程发布总览</p>
          <h2 className="mt-1 text-base font-black text-stone-900">教学安排、知识小节与资源状态</h2>
        </div>
        <Link className="inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-stone-300 px-3 text-xs font-bold text-stone-700" href={`${courseDetailedEditHref(course.id)}?section=stage-plan`}><Edit3 size={14} />定位并修改</Link>
      </header>
      <div className="bg-white p-5">
          <h3 className="text-xs font-black text-stone-500">五阶段课堂安排</h3>
          {stagePlan?.stages.length ? <ol className="mt-4 grid gap-2 sm:grid-cols-5">{stagePlan.stages.map((stage, index) => <li className="rounded-[8px] border border-stone-200 p-3" key={stage.key}><span className="text-[10px] font-black text-[var(--pbl-teacher)]">{String(index + 1).padStart(2, "0")}</span><p className="mt-1 text-xs font-bold text-stone-900">{stage.title}</p><p className="mt-2 text-[11px] text-stone-500">{stage.durationMin ?? 0} 分钟</p></li>)}</ol> : <p className="mt-4 text-sm text-stone-500">五阶段安排尚未生成。</p>}
          <div className="mt-6 flex items-center justify-between gap-3"><h3 className="text-xs font-black text-stone-500">知识讲授小节</h3><Link className="text-xs font-bold text-[var(--pbl-teacher)] hover:underline" href={`${courseDetailedEditHref(course.id)}?section=blueprint`}>查看教学蓝图</Link></div>
          {lectureSections.length ? <div className="mt-3 divide-y divide-stone-100 border-y border-stone-100">{lectureSections.map((section, index) => <div className="flex items-center gap-3 py-3" key={section.id}><span className="grid size-7 shrink-0 place-items-center rounded-full bg-stone-100 text-[10px] font-black text-stone-600">{index + 1}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-stone-900">{section.title}</p><p className="mt-1 text-[11px] text-stone-500">{section.sceneOutlineIds.length} 个讲授页面 + 1 个检测 · 约 {section.estimatedMinutes} 分钟</p></div><Link className="text-[11px] font-bold text-[var(--pbl-teacher)]" href={`${courseDetailedEditHref(course.id)}?section=classroom&lectureSectionId=${encodeURIComponent(section.id)}`}>定位</Link></div>)}</div> : <p className="mt-3 text-sm text-stone-500">知识讲授小节尚未生成。</p>}
      </div>
    </section>
  );
}

function PublicationStatusRail({
  auditError,
  auditLoaded,
  checks,
  course,
  missingResourceIssues,
  onOpenReview,
  onRepairResources,
  onRepairSpeech,
  onRetryAudit,
  repairStatus,
  reviewRequired,
  reviewSummary,
  speechStatus,
  speechSyncIssues,
}: {
  auditError: string;
  auditLoaded: boolean;
  checks: PublishCheck[];
  course: Course;
  missingResourceIssues: ResourceRepairIssue[];
  onOpenReview: () => void;
  onRepairResources: () => void;
  onRepairSpeech: () => void;
  onRetryAudit: () => void;
  repairStatus: ResourceRepairStatus;
  reviewRequired: boolean;
  reviewSummary: CourseQualityReviewSummary | null;
  speechStatus: ResourceRepairStatus;
  speechSyncIssues: ResourceRepairIssue[];
}) {
  const hasClassroom = Boolean(course.aiLearningClassroomId || course.content._openmaicClassroomId);
  const timing = course.content.moduleTimingPlan;
  const timingAudit = course.content.teachingTimingAudit;
  const savedReview = course.content.teacherReview;
  const reviewStatus = savedReview || reviewSummary?.status === "confirmed" ? "confirmed"
    : reviewSummary?.status ?? "loading";
  const reviewLabel = !reviewRequired ? "无需单独终审"
    : reviewStatus === "confirmed" ? "当前版本已终审"
      : reviewStatus === "blocked" ? `存在 ${reviewSummary?.blockingCount ?? 0} 项阻断问题`
        : reviewStatus === "attention" ? `还有 ${reviewSummary?.attentionCount ?? 0} 项建议待核对`
          : reviewStatus === "ready" ? "可以确认当前版本"
            : reviewStatus === "error" ? "终审状态读取失败" : "正在读取终审状态";
  const incompleteChecks = checks.filter((item) => !item.done);
  const resourceNeedsAttention = Boolean(auditError || repairStatus.status === "failed" || missingResourceIssues.length);
  const speechNeedsAttention = !hasClassroom || speechStatus.status === "failed" || speechSyncIssues.length > 0;
  const reviewNeedsAttention = reviewRequired && ["blocked", "attention", "error"].includes(reviewStatus);

  return <aside aria-label="课程发布状态" className={styles.statusRail}>
    <div className="space-y-3">
      {resourceNeedsAttention ? <section className={cn("rounded-[12px] border px-4 py-4", auditError || repairStatus.status === "failed" ? "border-rose-200 bg-rose-50/60" : "border-amber-200 bg-amber-50/55")} role="alert">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2"><AlertTriangle className={auditError || repairStatus.status === "failed" ? "text-rose-700" : "text-amber-700"} size={17} /><h2 className="text-sm font-black text-stone-950">课程资源需要处理</h2></div>
          <StatusBadge tone={auditError || repairStatus.status === "failed" ? "danger" : "warning"}>{auditError ? "读取失败" : repairStatus.status === "failed" ? "补齐失败" : repairStatus.status === "running" ? "补齐中" : `${missingResourceIssues.length} 项缺失`}</StatusBadge>
        </div>
        {auditError ? <p className="mt-2 text-xs leading-5 text-rose-800">{auditError}</p> : <>
          {repairStatus.status === "failed" ? <p className="mt-2 text-xs leading-5 text-rose-800">{repairStatus.error || "上次资源补齐失败，请重试。"}</p> : null}
          {missingResourceIssues.length ? <ul className="mt-3 space-y-2 text-xs leading-5 text-stone-700">{missingResourceIssues.map((issue) => <li key={issue.id}><strong className="text-stone-950">{issue.title}</strong>：{issue.detail}</li>)}</ul> : null}
        </>}
        {auditError ? <Button className="mt-3 min-h-11 w-full" onClick={onRetryAudit} variant="outline"><RotateCcw size={14} />重新读取</Button> : <>
          <Button className="mt-3 min-h-11 w-full" loading={repairStatus.status === "running"} onClick={onRepairResources} variant="outline"><RotateCcw size={14} />重试缺失资源</Button>
          <Link className="mt-1 inline-flex min-h-11 w-full items-center justify-center text-xs font-bold text-[var(--pbl-teacher)] hover:underline" href={`${courseDetailedEditHref(course.id)}?section=classroom`}>定位并修改</Link>
        </>}
      </section> : <StatusSummaryRow label="课程资源" status={!auditLoaded ? "核对中" : repairStatus.status === "running" ? "补齐中" : "完整"} tone={auditLoaded && repairStatus.status !== "running" ? "success" : "neutral"} />}

      {speechNeedsAttention ? <section className={cn("rounded-[12px] border px-4 py-4", speechStatus.status === "failed" ? "border-rose-200 bg-rose-50/60" : "border-amber-200 bg-amber-50/55")} role={speechStatus.status === "failed" ? "alert" : undefined}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2"><AlertTriangle className={speechStatus.status === "failed" ? "text-rose-700" : "text-amber-700"} size={17} /><h2 className="text-sm font-black text-stone-950">朗读与动作同步</h2></div>
          <StatusBadge tone={speechStatus.status === "failed" ? "danger" : "warning"}>{!hasClassroom ? "待生成" : speechStatus.status === "running" ? `${speechStatus.completed ?? 0}/${speechStatus.total || "…"}` : speechStatus.status === "failed" ? "修复失败" : `${speechSyncIssues.length} 项待处理`}</StatusBadge>
        </div>
        {!hasClassroom ? <p className="mt-2 text-xs leading-5 text-stone-600">生成 AI 课堂后可以核对字幕和指示动作时间线。</p>
          : speechStatus.status === "failed" ? <p className="mt-2 text-xs leading-5 text-rose-800">{speechStatus.error || "同步修复未完成，请稍后重试。"}</p>
            : <ul className="mt-3 space-y-2 text-xs leading-5 text-stone-700">{speechSyncIssues.map((issue) => <li key={issue.id}><strong className="text-stone-950">{issue.title}</strong>：{issue.detail}</li>)}</ul>}
        {hasClassroom ? <Button className="mt-3 min-h-11 w-full" loading={speechStatus.status === "running"} onClick={onRepairSpeech} variant="outline"><RotateCcw size={14} />修复朗读与动作同步</Button> : null}
      </section> : <StatusSummaryRow label="朗读与动作同步" status={speechStatus.status === "running" ? `${speechStatus.completed ?? 0}/${speechStatus.total || "…"}` : "已同步"} tone={speechStatus.status === "running" ? "neutral" : "success"} />}

      {incompleteChecks.length ? <section className="rounded-[12px] border border-amber-200 bg-amber-50/55 px-4 py-4">
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-black text-stone-950">还需完成 {incompleteChecks.length} 项</h2><StatusBadge tone="warning">影响发布</StatusBadge></div>
        <ul className="mt-3 divide-y divide-amber-200/70">{incompleteChecks.map((item) => {
          const section = item.id === "design-workspace-freshness" ? course.content.designWorkspaceRevision?.pendingUpdates[0]?.target ?? "classroom" : PUBLISH_SECTION_BY_CHECK[item.id];
          return <li className="py-2.5 first:pt-0 last:pb-0" key={item.id}><p className="text-xs font-bold text-stone-950">{item.label}</p><p className="mt-0.5 text-[11px] leading-5 text-stone-600">{item.detail}</p>{section ? <Link className="mt-1 inline-flex min-h-8 items-center gap-1 text-[11px] font-bold text-[var(--pbl-teacher)] hover:underline" href={`${courseDetailedEditHref(course.id)}?section=${section}`}>定位并修改 <ArrowRight size={11} /></Link> : null}</li>;
        })}</ul>
      </section> : null}

      {reviewNeedsAttention ? <section className={cn("rounded-[12px] border px-4 py-4", reviewStatus === "blocked" || reviewStatus === "error" ? "border-rose-200 bg-rose-50/60" : "border-amber-200 bg-amber-50/55")}>
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-black text-stone-950">教师终审</h2><StatusBadge tone={reviewStatus === "blocked" || reviewStatus === "error" ? "danger" : "warning"}>{reviewStatus === "blocked" ? "有阻断" : reviewStatus === "error" ? "读取失败" : "待核对"}</StatusBadge></div>
        <p className="mt-2 text-xs leading-5 text-stone-700">{reviewLabel}</p>
        <Button className="mt-3 min-h-11 w-full" onClick={onOpenReview} variant="outline">查看并处理检查结果</Button>
      </section> : <section className="rounded-[12px] border border-stone-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-stone-900">教师终审</h2><StatusBadge tone={reviewStatus === "confirmed" || reviewStatus === "ready" ? "success" : "neutral"}>{reviewStatus === "confirmed" ? "已确认" : reviewStatus === "ready" ? "可确认" : "读取中"}</StatusBadge></div>
        <p className="mt-1 text-xs leading-5 text-stone-500">{reviewLabel}{savedReview ? ` · ${new Date(savedReview.confirmedAt).toLocaleDateString("zh-CN")}` : ""}</p>
        {reviewRequired ? <button className="mt-1 min-h-9 text-xs font-bold text-[var(--pbl-teacher)] hover:underline" onClick={onOpenReview} type="button">打开检查与终审</button> : null}
      </section>}

      <section className="rounded-[12px] border border-stone-200 bg-white px-4 py-3">
        <h2 className="text-sm font-bold text-stone-900">讲授时长</h2>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <div><dt className="text-[11px] text-stone-500">教案规划</dt><dd className="mt-1 text-sm font-bold text-stone-900">{timing ? `${timing.totalMinutes} 分钟` : "未规划"}</dd></div>
          <div><dt className="text-[11px] text-stone-500">讲授音频</dt><dd className="mt-1 text-sm font-bold text-stone-900">{timingAudit ? secondsLabel(timingAudit.substantiveTeachingDurationSec) : "待测量"}</dd></div>
        </dl>
        <p className="mt-1 text-[11px] leading-5 text-stone-500">{timingAudit?.narrationDurationSource === "actual-audio" ? "音频时长来自实际语音。" : timingAudit ? "当前按讲稿估算。" : "生成音频后更新实际时长。"}</p>
      </section>

      <PublishReadiness checks={checks} />
    </div>
  </aside>;
}

function StatusSummaryRow({ label, status, tone }: { label: string; status: string; tone: "neutral" | "success" }) {
  return <section className="flex min-h-12 items-center justify-between gap-3 rounded-[12px] border border-stone-200 bg-white px-4 py-2.5"><h2 className="text-sm font-bold text-stone-900">{label}</h2><StatusBadge tone={tone}>{status}</StatusBadge></section>;
}

function StatusBadge({ children, tone }: { children: React.ReactNode; tone: "neutral" | "success" | "warning" | "danger" }) {
  return <span className={cn(
    "shrink-0 rounded-full px-2 py-1 text-[10px] font-bold",
    tone === "success" ? "bg-emerald-50 text-emerald-700" : tone === "warning" ? "bg-amber-100 text-amber-900" : tone === "danger" ? "bg-rose-100 text-rose-800" : "bg-stone-100 text-stone-600",
  )}>{children}</span>;
}

function PublishReadiness({ checks }: { checks: PublishCheck[] }) {
  const readyCount = checks.filter((item) => item.done).length;
  return (
    <details className="overflow-hidden rounded-[12px] border border-stone-200 bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-bold text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-teacher)]"><span>查看全部发布条件</span><span className="text-xs font-semibold text-stone-500">{readyCount}/{checks.length}</span></summary>
      <ul className="divide-y divide-stone-100 border-t border-stone-200">{checks.map((item) => <li className="flex gap-2.5 px-4 py-3" key={item.id}><span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full", item.done ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>{item.done ? <Check size={12} /> : <AlertTriangle size={11} />}</span><div><p className="text-xs font-bold text-stone-900">{item.label}</p><p className="mt-0.5 text-[11px] leading-5 text-stone-500">{item.detail}</p></div></li>)}</ul>
    </details>
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
    <section aria-labelledby="publish-tab-student" className="overflow-hidden rounded-[12px] border border-stone-200 bg-white" id="publish-panel-student" role="tabpanel">
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
