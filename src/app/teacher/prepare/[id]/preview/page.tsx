"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useEffect } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpenCheck,
  Check,
  Clock3,
  Edit3,
  Eye,
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
  OpenMaicSceneOutlineSnapshot,
} from "@/lib/session/types";
import { normalizeTeachingToolPlan } from "@/lib/openmaic/generation/teaching-tool-plan";
import { courseDetailedEditHref } from "@/lib/courses/preparation-navigation";
import { cn } from "@/lib/utils";
import { getNewSystemCourseReadiness } from "@/lib/classroom/new-system-course";

const STEPS = [
  { key: "verify", label: "备课阶段" },
  { key: "generate", label: "生成课程" },
  { key: "preview", label: "预览发布" },
];

type PreviewView = "director" | "student";

type PublishCheck = {
  label: string;
  done: boolean;
  detail: string;
};

type ResourceRepairIssue = {
  id: string;
  type: "adaptive-resource" | "teaching-tool" | "tts" | "media";
  title: string;
  detail: string;
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
  const [view, setView] = useState<PreviewView>("director");
  const [selectedOutlineId, setSelectedOutlineId] = useState<string>();
  const [studentSidebarCollapsed, setStudentSidebarCollapsed] = useState(false);
  const [previewBranch, setPreviewBranch] = useState<AdaptiveBranchOutline>();
  const [resourceIssues, setResourceIssues] = useState<ResourceRepairIssue[]>([]);
  const [resourceAuditLoaded, setResourceAuditLoaded] = useState(false);
  const [repairingResources, setRepairingResources] = useState(false);
  const [resourceRepairVersion, setResourceRepairVersion] = useState(0);

  useEffect(() => {
    if (!params?.id) return;
    const controller = new AbortController();
    void fetch(`/api/courses/${params.id}/resource-repair`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { issues?: ResourceRepairIssue[] };
      setResourceIssues(payload.issues ?? []);
    }).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setResourceAuditLoaded(true);
    });
    return () => controller.abort();
  }, [params?.id, resourceRepairVersion]);

  if (!hydrated) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid min-h-72 place-items-center text-sm text-stone-500">正在打开课程发布中心…</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
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
  const studentOutlines = outlines.filter((outline) => outline.audience !== "teacher");
  const selectedOutline = studentOutlines.find((outline) => outline.id === selectedOutlineId)
    ?? studentOutlines[0];
  const selectedToolPlan = normalizeTeachingToolPlan(selectedOutline?.teachingToolPlan);
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const adaptivePlan = course.content.adaptiveLearningPlan;
  const activeAdaptiveBranches = adaptivePlan?.branches.filter((branch) => branch.enabled !== false) ?? [];
  const requestedPreviewBranch = activeAdaptiveBranches.find(
    (branch) => branch.id === searchParams.get("adaptiveBranchId")
      && Boolean(branch.preparedResource?.classroomId),
  );
  const activePreviewBranch = previewBranch ?? requestedPreviewBranch;
  const publishChecks = buildPublishChecks(course);
  const readyCount = publishChecks.filter((item) => item.done).length;
  const readyToPublish = resourceAuditLoaded
    && readyCount === publishChecks.length
    && resourceIssues.length === 0;
  const pendingPublishCount = publishChecks.length - readyCount + resourceIssues.length;
  const isPublished = course.status === "ready"
    || course.status === "teaching"
    || course.status === "finished";
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
    setPublishing(true);
    try {
      publishCourse(courseId);
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

  async function retryMissingResources() {
    setRepairingResources(true);
    try {
      const response = await fetch(`/api/courses/${courseId}/resource-repair`, { method: "POST" });
      const payload = await response.json() as { issues?: ResourceRepairIssue[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "缺失资源重试失败");
      const issues = payload.issues ?? [];
      setResourceIssues(issues);
      setResourceRepairVersion((value) => value + 1);
      if (issues.length === 0) {
        toast.success("缺失资源已经补齐");
      } else {
        toast.warning("部分资源仍未生成", { description: `还剩 ${issues.length} 项，可稍后再次重试。` });
      }
    } catch (error) {
      toast.error("资源重试失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setRepairingResources(false);
    }
  }

  function closeBranchPreview() {
    setPreviewBranch(undefined);
    if (requestedPreviewBranch) {
      router.replace(`/teacher/prepare/${courseId}/preview`, { scroll: false });
    }
  }

  return (
    <DashboardShell
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
                <span>课程发布中心 · 第 3 步</span>
              </div>
              <h1 className="mt-1 break-words font-editorial text-xl font-semibold leading-snug tracking-[-0.02em] text-stone-950 sm:truncate sm:text-[30px]" title={course.name}>{course.name}</h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-500">
                {[course.subject, course.grade].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-2">
              <Pill tone={isPublished ? "green" : readyToPublish ? "blue" : "amber"}>
                {isPublished ? "已发布" : readyToPublish ? "可以发布" : resourceAuditLoaded ? `待完成 ${pendingPublishCount} 项` : "正在核对资源"}
              </Pill>
              <Link
                className="inline-flex h-10 items-center gap-1.5 rounded-[7px] border border-stone-200 bg-white px-3.5 text-sm font-semibold text-stone-600 shadow-sm transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]"
                href={courseDetailedEditHref(course.id)}
              >
                <Edit3 size={15} /> 返回修改
              </Link>
            </div>
          </div>
        </header>

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

            {resourceIssues.length > 0 ? (
              <section className="mt-5 rounded-[12px] border border-amber-200 bg-amber-50/70 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-black text-amber-950">还有 {resourceIssues.length} 项课程资源需要补充</h2>
                    <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-900">
                      {resourceIssues.map((issue) => <li key={issue.id}>• {issue.title}：{issue.detail}</li>)}
                    </ul>
                  </div>
                  <Button loading={repairingResources} onClick={() => void retryMissingResources()}>
                    <RotateCcw size={14} />一键重试缺失资源
                  </Button>
                </div>
              </section>
            ) : null}

            <section className="mt-5 grid min-h-[620px] overflow-hidden rounded-[12px] border border-stone-200 bg-white xl:grid-cols-[280px_minmax(0,1fr)_330px]">
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
              <PublishReadiness checks={publishChecks} />
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
        {!isPublished ? (
          <Button disabled={!readyToPublish || publishing} loading={publishing} onClick={() => void publish()}>发布课程</Button>
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

function PublishReadiness({ checks }: { checks: PublishCheck[] }) {
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
        {checks.map((item) => (
          <li className="flex gap-3 px-5 py-3.5" key={item.label}>
            <span className={cn(
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
              item.done ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
            )}>
              {item.done ? <Check size={12} /> : <AlertTriangle size={11} />}
            </span>
            <div>
              <p className="text-xs font-bold text-stone-900">{item.label}</p>
              <p className="mt-1 text-[11px] leading-5 text-stone-500">{item.detail}</p>
            </div>
          </li>
        ))}
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
